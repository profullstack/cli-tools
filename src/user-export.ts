import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { pullVault, vaultTarget, type VaultTarget } from './vault.ts';

/**
 * Export every user account across many databases as one CSV:
 * `site,name,email,last_login`.
 *
 * Nothing here knows whose databases these are. Which databases to read, and
 * with what, is a config file whose secret fields are *references* — `env:NAME`,
 * `vault:<project>/<env>/<KEY>` or `cmd:<shell>` — so the file can live in a
 * repo while the values stay in the environment, a logicsrc team vault, or
 * whatever CLI already holds them.
 *
 * Every source is read-only. Supabase's management API is asked for
 * `read_only: true`, SQLite is opened read-only, Postgres runs in a read-only
 * transaction, and libSQL only ever runs the SELECT it was configured with.
 *
 * A database that is only reachable from inside its own host (a platform's
 * private network, a volume on a container) is read through `via`: a command
 * prefix that runs a shell command there — `ssh host`, `railway ssh ...`,
 * `docker exec ctr sh -c`. The reader is shipped through it, so nothing has
 * to be installed on the far side beyond psql, or node/bun for SQLite.
 */

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface UserRow {
  site: string;
  name: string;
  email: string;
  last_login: string;
}

/** Every site's users, one project per Supabase account the token can see. */
export interface SupabaseManagementSource {
  type: 'supabase-management';
  token: string;
  /** Project names (or refs) to read; everything visible when omitted. */
  include?: string[];
  exclude?: string[];
  /** Project name → site label, for projects not named after their host. */
  sites?: Record<string, string>;
  /** Project name → SQL, for projects whose users are not in auth.users. */
  queries?: Record<string, string>;
  api?: string;
}

/** One Supabase instance, cloud or self-hosted, through the GoTrue admin API. */
export interface SupabaseAuthSource {
  type: 'supabase-auth';
  site: string;
  url: string;
  serviceKey: string;
}

/** Turso / libSQL, over its HTTP pipeline, so no client library is needed. */
export interface LibsqlSource {
  type: 'libsql';
  site: string;
  url: string;
  token?: string;
  query: string;
}

export interface SqliteSource {
  type: 'sqlite';
  site: string;
  path: string;
  query: string;
  /** Run on another host: a prefix that executes one shell command there. */
  via?: string;
}

export interface PostgresSource {
  type: 'postgres';
  site: string;
  /** A connection URL; with `via`, optional and handed to the remote psql. */
  url?: string;
  query: string;
  via?: string;
}

/** Anything else: a command that prints the rows as JSON or CSV. */
export interface ExecSource {
  type: 'exec';
  site: string;
  command: string;
}

export type Source =
  | SupabaseManagementSource
  | SupabaseAuthSource
  | LibsqlSource
  | SqliteSource
  | PostgresSource
  | ExecSource;

export interface Config {
  /** Default team for `vault:` references. */
  vaultTeam?: string;
  sources: Source[];
}

/**
 * The query run on each Supabase project. The name is whichever of the
 * conventional metadata keys the project's sign-up flow happened to write.
 */
export const AUTH_USERS_QUERY = `select
  coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name',
           raw_user_meta_data->>'display_name', raw_user_meta_data->>'username',
           raw_user_meta_data->>'user_name', '') as name,
  coalesce(email, '') as email,
  coalesce(to_char(last_sign_in_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') as last_login
from auth.users
order by last_sign_in_at desc nulls last`;

const TYPES = ['supabase-management', 'supabase-auth', 'libsql', 'sqlite', 'postgres', 'exec'] as const;

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'cli-tools', 'user-export.json');
}

/** Parse and shape-check a config. Secrets are not resolved here. */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ExportError(`config is not valid JSON: ${(error as Error).message}`);
  }
  const sources = (raw as Config | null)?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new ExportError('config needs a non-empty "sources" array');
  }

  const required: Record<Source['type'], string[]> = {
    'supabase-management': ['token'],
    'supabase-auth': ['site', 'url', 'serviceKey'],
    libsql: ['site', 'url', 'query'],
    sqlite: ['site', 'path', 'query'],
    postgres: ['site', 'query'],
    exec: ['site', 'command'],
  };
  sources.forEach((source: Source, index) => {
    if (!TYPES.includes(source?.type)) {
      throw new ExportError(`sources[${index}]: type must be one of ${TYPES.join(', ')}`);
    }
    for (const key of required[source.type]) {
      if (typeof (source as unknown as Record<string, unknown>)[key] !== 'string') {
        throw new ExportError(`sources[${index}] (${source.type}): "${key}" is required`);
      }
    }
    if (source.type === 'postgres' && !source.url && !source.via) {
      throw new ExportError(`sources[${index}] (postgres): "url" is required unless "via" is set`);
    }
  });
  return raw as Config;
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ExportError(`no config at ${path} — see \`user-export --example\``);
  }
  return parseConfig(text);
}

export type VaultPuller = (target: VaultTarget) => Record<string, string>;
export type CommandRunner = (command: string) => { status: number; stdout: string; stderr: string };

export const shellRunner: CommandRunner = (command) => {
  const r = spawnSync('sh', ['-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
};

/**
 * Resolve `env:NAME`, `vault:<project>/<env>/<KEY>` (or
 * `vault:<team>/<project>/<env>/<KEY>`) and `cmd:<shell>` (its trimmed stdout).
 * Anything else is a literal. Each vault is pulled, and each command run, once
 * however many references point at it.
 */
export function secretResolver(
  env: NodeJS.ProcessEnv,
  {
    team = vaultTarget(env).team,
    pull = (t: VaultTarget) => pullVault(t),
    run = shellRunner,
  }: { team?: string; pull?: VaultPuller; run?: CommandRunner } = {},
) {
  const vaults = new Map<string, Record<string, string>>();
  const commands = new Map<string, string>();

  return (value: string | undefined, label: string): string => {
    if (value === undefined) return '';
    if (value.startsWith('env:')) {
      const name = value.slice(4);
      const found = env[name];
      if (!found) throw new ExportError(`${label}: environment variable ${name} is not set`);
      return found;
    }
    if (value.startsWith('vault:')) {
      const parts = value.slice(6).split('/');
      if (parts.length !== 3 && parts.length !== 4) {
        throw new ExportError(`${label}: expected vault:<project>/<env>/<KEY>, got ${value}`);
      }
      const [vaultTeam, project, vaultEnv, key] = parts.length === 4 ? parts : [team, ...parts];
      const id = `${vaultTeam}/${project}/${vaultEnv}`;
      if (!vaults.has(id)) vaults.set(id, pull({ team: vaultTeam!, project: project!, env: vaultEnv! }));
      const found = vaults.get(id)![key!];
      if (!found) throw new ExportError(`${label}: ${key} is not in vault ${id}`);
      return found;
    }
    if (value.startsWith('cmd:')) {
      const command = value.slice(4);
      if (!commands.has(command)) {
        const r = run(command);
        const out = r.stdout.trim();
        if (r.status !== 0 || !out) {
          // The command is config, not a secret, but its stderr might echo one.
          throw new ExportError(`${label}: cmd: exited ${r.status}${out ? '' : ' with no output'}`);
        }
        commands.set(command, out);
      }
      return commands.get(command)!;
    }
    return value;
  };
}

export type Resolve = ReturnType<typeof secretResolver>;
export type Fetch = typeof fetch;

/** One named result, so a dead source is reported instead of sinking the run. */
export interface SourceResult {
  site: string;
  source: string;
  rows: UserRow[];
  error?: string;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Map any row object onto the output columns by name. */
export function toUserRow(site: string, row: Record<string, unknown>): UserRow {
  return { site, name: cell(row.name), email: cell(row.email), last_login: isoTime(row.last_login) };
}

/**
 * One timestamp format across every source: ISO 8601 UTC, to the second.
 * Databases disagree — Postgres JSON says `+00:00`, SQLite apps store epoch
 * seconds or milliseconds, or a bare `YYYY-MM-DD HH:MM:SS` meaning UTC — and a
 * CSV sorted by last_login is only useful if they agree. Anything that does
 * not parse is passed through untouched rather than guessed at.
 */
export function isoTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const text = cell(value).trim();
  if (!text) return '';
  let ms: number;
  if (/^\d{9,13}(\.\d+)?$/.test(text)) {
    const n = Number(text);
    ms = n >= 1e12 ? n : n * 1000;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) {
    ms = Date.parse(`${text.replace(' ', 'T')}Z`);
  } else if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    ms = Date.parse(text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  } else {
    return text;
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : text;
}

async function json(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new ExportError(`${what}: HTTP ${response.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ExportError(`${what}: response is not JSON`);
  }
}

interface Project {
  id: string;
  name: string;
  status?: string;
}

export async function readSupabaseManagement(
  source: SupabaseManagementSource,
  resolve: Resolve,
  fetcher: Fetch = fetch,
  { concurrency = 6, only = [] as string[] } = {},
): Promise<SourceResult[]> {
  const token = resolve(source.token, 'supabase-management token');
  const api = source.api ?? 'https://api.supabase.com';
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const all = (await json(await fetcher(`${api}/v1/projects`, { headers }), 'list projects')) as Project[];
  const siteOf = (p: Project) => source.sites?.[p.name] ?? p.name;
  const wanted = (p: Project) =>
    (only.length === 0 || only.includes(siteOf(p))) &&
    (!source.include?.length || source.include.includes(p.name) || source.include.includes(p.id)) &&
    !source.exclude?.includes(p.name) &&
    !source.exclude?.includes(p.id);
  const projects = all.filter(wanted);

  return mapLimit(projects, concurrency, async (project) => {
    const site = siteOf(project);
    const label = `supabase:${project.name}`;
    if (project.status && project.status !== 'ACTIVE_HEALTHY') {
      return { site, source: label, rows: [], error: `project is ${project.status}` };
    }
    try {
      const response = await fetcher(`${api}/v1/projects/${project.id}/database/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: source.queries?.[project.name] ?? AUTH_USERS_QUERY, read_only: true }),
      });
      const rows = (await json(response, label)) as Record<string, unknown>[];
      return { site, source: label, rows: rows.map((row) => toUserRow(site, row)) };
    } catch (error) {
      return { site, source: label, rows: [], error: (error as Error).message };
    }
  });
}

interface AuthUser {
  email?: string | null;
  last_sign_in_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

export function metadataName(meta: Record<string, unknown> | null | undefined): string {
  for (const key of ['full_name', 'name', 'display_name', 'username', 'user_name']) {
    const value = meta?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

export async function readSupabaseAuth(
  source: SupabaseAuthSource,
  resolve: Resolve,
  fetcher: Fetch = fetch,
  perPage = 1000,
): Promise<UserRow[]> {
  const url = resolve(source.url, `${source.site} url`).replace(/\/+$/, '');
  const key = resolve(source.serviceKey, `${source.site} serviceKey`);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const rows: UserRow[] = [];
  for (let page = 1; ; page += 1) {
    const body = (await json(
      await fetcher(`${url}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, { headers }),
      `${source.site} admin users page ${page}`,
    )) as { users?: AuthUser[] };
    const users = body.users ?? [];
    for (const user of users) {
      rows.push({
        site: source.site,
        name: metadataName(user.user_metadata),
        email: user.email ?? '',
        last_login: isoTime(user.last_sign_in_at),
      });
    }
    if (users.length < perPage) return rows;
  }
}

/** `libsql://db-org.turso.io` → `https://db-org.turso.io`. */
export function libsqlHttpUrl(url: string): string {
  return url.replace(/^libsql:\/\//, 'https://').replace(/^wss?:\/\//, (m) => (m === 'ws://' ? 'http://' : 'https://')).replace(/\/+$/, '');
}

interface HranaValue {
  type: string;
  value?: string | number;
  base64?: string;
}

export async function readLibsql(source: LibsqlSource, resolve: Resolve, fetcher: Fetch = fetch): Promise<UserRow[]> {
  const url = libsqlHttpUrl(resolve(source.url, `${source.site} url`));
  const token = resolve(source.token, `${source.site} token`);
  const body = (await json(
    await fetcher(`${url}/v2/pipeline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: source.query } }, { type: 'close' }] }),
    }),
    `${source.site} libsql`,
  )) as {
    results: {
      type: string;
      error?: { message: string };
      response?: { result: { cols: { name: string }[]; rows: HranaValue[][] } };
    }[];
  };

  const first = body.results?.[0];
  if (!first || first.type !== 'ok' || !first.response) {
    throw new ExportError(`${source.site} libsql: ${first?.error?.message ?? 'no result'}`);
  }
  const { cols, rows } = first.response.result;
  return rows.map((values) => {
    const record: Record<string, unknown> = {};
    cols.forEach((col, index) => {
      const v = values[index];
      record[col.name] = v && v.type !== 'null' ? v.value : '';
    });
    return toUserRow(source.site, record);
  });
}

/** Quote one word for a POSIX shell. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Run `<via> '<remote>'` and return stdout, or throw with the tail of stderr. */
export function runVia(via: string, remote: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('sh', ['-c', `${via} ${shq(remote)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise(Buffer.concat(out).toString('utf8'));
      const tail = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' | ');
      reject(new ExportError(`remote command exited ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}

/** The reader shipped to a remote host for `sqlite` + `via`: bun or node >= 22.5. */
const REMOTE_SQLITE = `const p=process.env.UE_DB,q=Buffer.from(process.env.UE_SQL,'base64').toString();let rows;
if(globalThis.Bun){const{Database}=await import('bun:sqlite');const d=new Database(p,{readonly:true});rows=d.query(q).all();d.close()}
else{const{DatabaseSync}=await import('node:sqlite');const d=new DatabaseSync(p,{readOnly:true});rows=d.prepare(q).all();d.close()}
process.stdout.write(JSON.stringify(rows,(k,v)=>typeof v==='bigint'?String(v):v));`;

const b64 = (text: string) => Buffer.from(text).toString('base64');

export function remoteSqliteCommand(path: string, query: string): string {
  return [
    'F=/tmp/.user-export-$$.mjs',
    `echo ${b64(REMOTE_SQLITE)} | base64 -d > "$F"`,
    'if command -v bun >/dev/null 2>&1; then R=bun; elif command -v node >/dev/null 2>&1; then R="node --no-warnings"; else echo "neither bun nor node on the remote" >&2; exit 127; fi',
    `UE_DB=${shq(path)} UE_SQL=${b64(query)} $R "$F"`,
    'rc=$?; rm -f "$F"; exit $rc',
  ].join('; ');
}

export function remotePostgresCommand(query: string, url = ''): string {
  const sql = `select coalesce(json_agg(t), '[]'::json) from (${query}) t`;
  return `echo ${b64(sql)} | base64 -d | PGOPTIONS='-c default_transaction_read_only=on' psql -X -q -At -v ON_ERROR_STOP=1${url ? ` ${shq(url)}` : ''}`;
}

/** Split CSV text into records, RFC 4180 quoting. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), (i += 1);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') record.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field), records.push(record), (record = []), (field = '');
    } else field += c;
  }
  if (field || record.length) record.push(field), records.push(record);
  return records.filter((r) => r.length > 1 || r[0] !== '');
}

/** Rows from a command's output: a JSON array of objects, or CSV with a header. */
export function parseRows(site: string, text: string): UserRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    return (JSON.parse(trimmed) as Record<string, unknown>[]).map((row) => toUserRow(site, row));
  }
  const [header, ...records] = parseCsv(trimmed);
  return records.map((values) => toUserRow(site, Object.fromEntries(header!.map((h, i) => [h.trim(), values[i] ?? '']))));
}

export async function readSqlite(source: SqliteSource, resolve: Resolve): Promise<UserRow[]> {
  const path = resolve(source.path, `${source.site} path`);
  if (source.via) {
    return parseRows(source.site, await runVia(resolve(source.via, `${source.site} via`), remoteSqliteCommand(path, source.query)));
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(source.query).all() as Record<string, unknown>[]).map((row) => toUserRow(source.site, row));
  } finally {
    db.close();
  }
}

export async function readPostgres(source: PostgresSource, resolve: Resolve): Promise<UserRow[]> {
  const url = resolve(source.url, `${source.site} url`);
  if (source.via) {
    return parseRows(source.site, await runVia(resolve(source.via, `${source.site} via`), remotePostgresCommand(source.query, url)));
  }
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 20 });
  try {
    const rows = await sql.begin('read only', (tx) => tx.unsafe(source.query));
    return (rows as unknown as Record<string, unknown>[]).map((row) => toUserRow(source.site, row));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function readExec(source: ExecSource, resolve: Resolve): Promise<UserRow[]> {
  const command = resolve(source.command, `${source.site} command`);
  return parseRows(source.site, await runVia('sh -c', command));
}

/**
 * Read every source, `concurrency` at a time, results in config order. A
 * failing source becomes an error entry, never a throw.
 */
export async function exportUsers(
  config: Config,
  resolve: Resolve,
  { fetcher = fetch, only = [] as string[], concurrency = 4 } = {},
): Promise<SourceResult[]> {
  const keep = (site: string) => only.length === 0 || only.includes(site);

  const read = async (source: Source): Promise<SourceResult[]> => {
    if (source.type === 'supabase-management') {
      try {
        return await readSupabaseManagement(source, resolve, fetcher, { only });
      } catch (error) {
        return [{ site: '*', source: 'supabase-management', rows: [], error: (error as Error).message }];
      }
    }

    if (!keep(source.site)) return [];
    const label = `${source.type}:${source.site}`;
    try {
      const rows =
        source.type === 'supabase-auth'
          ? await readSupabaseAuth(source, resolve, fetcher)
          : source.type === 'libsql'
            ? await readLibsql(source, resolve, fetcher)
            : source.type === 'sqlite'
              ? await readSqlite(source, resolve)
              : source.type === 'postgres'
                ? await readPostgres(source, resolve)
                : await readExec(source, resolve);
      return [{ site: source.site, source: label, rows }];
    } catch (error) {
      return [{ site: source.site, source: label, rows: [], error: (error as Error).message }];
    }
  };

  return (await mapLimit(config.sources, concurrency, read)).flat();
}

export function csvField(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(rows: UserRow[], { withSource = false, sources = [] as string[] } = {}): string {
  const header = ['site', 'name', 'email', 'last_login', ...(withSource ? ['source'] : [])];
  const lines = [header.join(',')];
  rows.forEach((row, index) => {
    const fields = [row.site, row.name, row.email, row.last_login, ...(withSource ? [sources[index] ?? ''] : [])];
    lines.push(fields.map(csvField).join(','));
  });
  return `${lines.join('\n')}\n`;
}

/** One line per source for stderr: count, or why it produced nothing. */
export function formatSummary(results: SourceResult[]): string {
  const width = Math.max(...results.map((r) => r.source.length), 6);
  const lines = results.map((r) =>
    `${r.source.padEnd(width)}  ${r.error ? `ERROR ${r.error}` : String(r.rows.length).padStart(6)}`,
  );
  const total = results.reduce((n, r) => n + r.rows.length, 0);
  const failed = results.filter((r) => r.error).length;
  lines.push(`${'total'.padEnd(width)}  ${String(total).padStart(6)} users from ${results.length - failed} sources${failed ? `, ${failed} failed` : ''}`);
  return `${lines.join('\n')}\n`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const EXAMPLE_CONFIG: Config = {
  vaultTeam: 'my-team',
  sources: [
    {
      type: 'supabase-management',
      token: 'env:SUPABASE_ACCESS_TOKEN',
      exclude: ['staging'],
      sites: { myapp: 'myapp.com' },
      queries: { 'legacy.com': "select name, email, last_seen as last_login from public.members" },
    },
    { type: 'supabase-auth', site: 'selfhosted.dev', url: 'https://api.selfhosted.dev', serviceKey: 'vault:selfhosted/prod/SERVICE_ROLE_KEY' },
    { type: 'libsql', site: 'blog.example', url: 'env:TURSO_DATABASE_URL', token: 'env:TURSO_AUTH_TOKEN', query: 'select name, email, last_login_at as last_login from users' },
    { type: 'sqlite', site: 'tool.example', path: '/srv/tool/data.db', query: 'select username as name, email, datetime(last_login, \'unixepoch\') as last_login from users' },
    { type: 'postgres', site: 'app.example', url: 'env:APP_DATABASE_URL', query: 'select full_name as name, email, last_login_at as last_login from users' },
    { type: 'postgres', site: 'private.example', via: 'ssh db.internal', url: 'postgresql:///app?user=postgres', query: 'select name, email, last_seen as last_login from users' },
    { type: 'sqlite', site: 'volume.example', via: 'docker exec my-app sh -c', path: '/data/app.db', query: 'select name, email, last_login from users' },
    { type: 'libsql', site: 'platform.example', url: 'cmd:railway variable list -p <project-id> -s web -e production --json | jq -r .TURSO_DATABASE_URL', token: 'cmd:railway variable list -p <project-id> -s web -e production --json | jq -r .TURSO_AUTH_TOKEN', query: 'select name, email, last_login from users' },
    { type: 'exec', site: 'anything.example', command: './export-users.sh --json' },
  ],
};
