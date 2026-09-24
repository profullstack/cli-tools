import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { parseEnvFile } from './vault.ts';

/**
 * Every user account across the fleet, as one CSV: name, email, site, last login.
 *
 * The accounts live in four kinds of place, and each needs a different key:
 *
 * - **Supabase.com** — every project on the account, through one management
 *   token (`POST /v1/projects/<ref>/database/query`, read-only). No per-project
 *   secret is needed, so a project nobody wrote down is still found.
 * - **Turso / libSQL, SQLite Cloud** — one database per app, reached with the
 *   URL and token in that app's team vault, over their HTTP APIs.
 * - **Self-hosted Supabase** — the GoTrue admin API with the service-role key.
 * - **Postgres and SQLite on our own boxes** — a connection URL, or a file path
 *   read over ssh.
 *
 * Nothing but the Supabase projects is discoverable from an account listing, so
 * `discover` reads every prod vault once and writes down *where* each database
 * is — vault and variable names, never the values — to
 * ~/.config/cli-tools/users-dump.json. The dump pulls those vaults again at run
 * time, which keeps the file free of secrets and keeps a rotated token working.
 *
 * The schemas are whatever each app chose. Rather than a query per app, the
 * users table is found by shape: a table called users (or accounts, actors, …)
 * with an email column; the name is the first of display_name/name/username;
 * the last login is a last_login-ish column when there is one and otherwise the
 * newest session row. An app that does not fit says so in the summary rather
 * than contributing a silent zero.
 */

export const COLUMNS = ['name', 'email', 'site', 'last_login', 'created_at', 'source'] as const;

export interface UserRow {
  name: string;
  email: string;
  site: string;
  last_login: string;
  created_at: string;
  source: string;
}

export type SourceKind = 'libsql' | 'sqlitecloud' | 'postgres' | 'gotrue' | 'sqlite';

/**
 * One database to read. `url` and `token` name a variable in `vault` when a
 * vault is given, and are the literal value otherwise.
 */
export interface SourceEntry {
  site: string;
  kind: SourceKind;
  vault?: string;
  url?: string;
  token?: string;
  /** sqlite only: the database file, and the ssh host it lives on. */
  path?: string;
  ssh?: string;
  /** Read only these tables instead of guessing. */
  tables?: string[];
  skip?: boolean;
}

export interface Config {
  team: string;
  env: string;
  /** The vault whose SUPABASE_ACCESS_TOKEN is alive. `discover` finds it. */
  supabaseTokenVault?: string;
  sources: SourceEntry[];
}

export interface SourceReport {
  site: string;
  source: string;
  users: number;
  error?: string;
}

export class UsersDumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsersDumpError';
  }
}

// ---------------------------------------------------------------------------
// Configuration

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.USERS_DUMP_CONFIG) return env.USERS_DUMP_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'cli-tools', 'users-dump.json');
}

export function emptyConfig(): Config {
  return { team: 'profullstack', env: 'prod', sources: [] };
}

export function loadConfig(path: string = configPath()): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return emptyConfig();
  }
  const parsed = JSON.parse(text) as Partial<Config>;
  return { ...emptyConfig(), ...parsed, sources: parsed.sources ?? [] };
}

export function saveConfig(config: Config, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // The file holds no secret values, but a literal URL typed in by hand may
  // carry a password, so it is kept private either way.
  chmodSync(path, 0o600);
}

/** The identity of a vault-derived entry, so a re-discover keeps hand edits. */
function entryKey(entry: SourceEntry): string {
  return `${entry.vault ?? ''}|${entry.kind}|${entry.url ?? entry.path ?? ''}`;
}

/**
 * Fold a fresh discovery into the existing file.
 *
 * Entries typed in by hand (no vault) are never touched. Vault entries are
 * replaced by what discovery found now, carrying over the fields a person would
 * have edited — the site name, skip, tables — so running discover again is
 * always safe.
 */
export function mergeSources(existing: SourceEntry[], discovered: SourceEntry[]): SourceEntry[] {
  const previous = new Map(existing.filter((e) => e.vault).map((e) => [entryKey(e), e]));
  const merged = discovered.map((entry) => {
    const old = previous.get(entryKey(entry));
    if (!old) return entry;
    const kept: SourceEntry = { ...entry, site: old.site };
    if (old.skip !== undefined) kept.skip = old.skip;
    if (old.tables !== undefined) kept.tables = old.tables;
    return kept;
  });
  return [...existing.filter((e) => !e.vault), ...merged];
}

// ---------------------------------------------------------------------------
// Discovery

const TLDS = ['com', 'net', 'org', 'dev', 'app', 'bot', 'now', 'ca', 'io', 'ai', 'chat', 'space'];

/** `outreachgraph-com` → `outreachgraph.com`; `bufferoverride-web` → `bufferoverride`. */
export function siteFromProject(project: string): string {
  const slug = project.replace(/-web$/, '');
  const at = slug.lastIndexOf('-');
  if (at > 0 && TLDS.includes(slug.slice(at + 1))) {
    return `${slug.slice(0, at)}.${slug.slice(at + 1)}`;
  }
  return slug;
}

/** The project ref of a hosted Supabase URL, or null for anything else. */
export function supabaseRef(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const match = host.match(/^([a-z0-9]{20})\.supabase\.(co|in)$/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

function tokenFor(urlKey: string, env: Record<string, string>): string | undefined {
  const candidates = [
    urlKey.replace(/_URL$/, '_AUTH_TOKEN'),
    urlKey.replace(/_DATABASE_URL$/, '_AUTH_TOKEN'),
    'TURSO_AUTH_TOKEN',
    'LIBSQL_AUTH_TOKEN',
    'DATABASE_AUTH_TOKEN',
  ];
  return candidates.find((key) => env[key]);
}

/** A Postgres host this machine could plausibly reach, as opposed to a private network name. */
export function isPublicHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (!host.includes('.')) return false; // `db`, `postgres`: a docker network name
    return !/\.(internal|local|lan)$/.test(host) && host !== 'localhost';
  } catch {
    return false;
  }
}

/**
 * Where the user databases in one vault are, by variable name.
 *
 * Hosted Supabase URLs are left out when `hostedRefs` lists them, because the
 * management token already reads those, and a second copy through the
 * service-role key would only double the rows.
 */
export function discoverSources(
  project: string,
  env: Record<string, string>,
  hostedRefs: ReadonlySet<string> = new Set(),
): SourceEntry[] {
  const site = siteFromProject(project);
  const found: SourceEntry[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (/^libsql:\/\//.test(value)) {
      const token = tokenFor(key, env);
      const entry: SourceEntry = { site, kind: 'libsql', vault: project, url: key };
      if (token) entry.token = token;
      found.push(entry);
    } else if (/^sqlitecloud:\/\//.test(value)) {
      found.push({ site, kind: 'sqlitecloud', vault: project, url: key });
    } else if (/^postgres(ql)?:\/\//.test(value)) {
      // Supabase's own Postgres is read through the management API instead.
      if (/\.supabase\.(co|com)$/.test(safeHost(value))) continue;
      // Railway gives a private URL and a public one; only the public one
      // reaches this machine, so it wins when both are there.
      const publicKey = `${key.replace(/_URL$/, '')}_PUBLIC_URL`;
      if (!key.endsWith('_PUBLIC_URL') && env[publicKey]) continue;
      found.push({ site, kind: 'postgres', vault: project, url: key });
    }
  }

  const urlKey = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_URL'].find((k) => env[k]);
  const keyKey = ['SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY'].find((k) => env[k]);
  if (urlKey && keyKey) {
    const ref = supabaseRef(env[urlKey]!);
    if (!ref || !hostedRefs.has(ref)) {
      found.push({ site, kind: 'gotrue', vault: project, url: urlKey, token: keyKey });
    }
  }

  return found;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Vaults

const run = promisify(execFile);

/** Every vault in the team for one environment, by project name. */
export async function listVaults(team: string, environment: string): Promise<string[]> {
  const { stdout } = await run('logicsrc', ['teams', 'vaults', team, '--format', 'json'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const vaults = JSON.parse(stdout) as { project: string; env: string; youHaveAccess?: boolean }[];
  return vaults
    .filter((v) => v.env === environment && v.youHaveAccess !== false)
    .map((v) => v.project)
    .sort();
}

/**
 * Pull one vault and return its keys. Same discipline as src/vault.ts: the
 * decrypted file lives in a 0700 temp dir for one read and is removed in a
 * finally. Async here because discovery pulls a hundred of them.
 */
export async function pullVaultAsync(
  team: string,
  project: string,
  environment: string,
): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), 'users-dump-vault-'));
  const envPath = join(dir, 'vault.env');
  try {
    await run('logicsrc', ['teams', 'pull', team, project, environment, '--env', envPath]);
    return parseEnvFile(readFileSync(envPath, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A memo over vault pulls, so a dump that reads one vault twice pulls it once. */
export function vaultCache(team: string, environment: string) {
  const pulls = new Map<string, Promise<Record<string, string>>>();
  return (project: string) => {
    let pull = pulls.get(project);
    if (!pull) {
      pull = pullVaultAsync(team, project, environment);
      pulls.set(project, pull);
    }
    return pull;
  };
}

/** Run `task` over `items`, `limit` at a time, in order of results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Values

/**
 * Any timestamp an app stored, as ISO 8601 UTC, or '' when there is none.
 *
 * SQLite apps store whatever they liked: ISO text, `2026-09-01 12:00:00` (which
 * SQLite means as UTC), epoch seconds, epoch milliseconds.
 */
export function normalizeTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();

  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (n <= 0) return '';
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }

  // A bare date-time with no zone is UTC by SQLite's convention; without the Z,
  // Date would read it as local time.
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
  const parsed = new Date(bare ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

/** The later of two ISO stamps, either of which may be ''. */
export function later(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** RFC 4180: quote a field when it holds a comma, quote or line break. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: readonly UserRow[]): string {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) lines.push(COLUMNS.map((c) => csvField(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}

/**
 * One row per person per site. Two tables in one app (moshcoding has `users` and
 * `accounts`) can hold the same address; the merged row keeps the newest login
 * and the first name anyone gave.
 */
export function dedupe(rows: readonly UserRow[]): UserRow[] {
  const byKey = new Map<string, UserRow>();
  for (const row of rows) {
    if (!row.email) continue;
    const key = `${row.site}|${row.email.toLowerCase()}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...row });
      continue;
    }
    seen.name ||= row.name;
    seen.last_login = later(seen.last_login, row.last_login);
    if (row.created_at && (!seen.created_at || row.created_at < seen.created_at)) {
      seen.created_at = row.created_at;
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Finding the users table

export interface TableInfo {
  /** Qualified for the dialect: `users` in SQLite, `public.users` in Postgres. */
  name: string;
  columns: string[];
}

/** Tables that hold accounts, best first. Waitlists and invitations are not accounts. */
const USER_TABLES = ['users', 'auth_users', 'user', 'accounts', 'actors', 'members', 'customers', 'profiles'];
const NAME_COLUMNS = ['display_name', 'full_name', 'name', 'username', 'handle', 'dn'];
const LOGIN_COLUMNS = ['last_login_at', 'last_login', 'last_sign_in_at', 'last_seen_at', 'last_active_at'];
const CREATED_COLUMNS = ['created_at', 'created', 'inserted_at', 'signed_up_at'];
const SESSION_TABLES = ['sessions', 'auth_sessions', 'user_sessions'];
const SESSION_TIMES = ['last_seen_at', 'last_used_at', 'created_at'];

export interface UserQuery {
  table: string;
  sql: string;
}

function bare(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

function quoteName(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}

function first(columns: readonly string[], wanted: readonly string[]): string | undefined {
  return wanted.find((c) => columns.includes(c));
}

/**
 * The column in a session table that points at this users table, and the
 * key it points at. `actors` pairs with `actor_id`, `accounts` with
 * `account_id`, everything else with `user_id` (or `user_sub` onto `sub`).
 */
function sessionLink(table: TableInfo, session: TableInfo): { fk: string; pk: string } | null {
  const base = bare(table.name);
  const pairs: [string, string][] =
    base === 'actors'
      ? [['actor_id', 'id']]
      : base === 'accounts'
        ? [['account_id', 'id']]
        : [
            ['user_id', 'id'],
            ['user_sub', 'sub'],
          ];
  for (const [fk, pk] of pairs) {
    if (session.columns.includes(fk) && table.columns.includes(pk)) return { fk, pk };
  }
  return null;
}

/**
 * The SELECTs that read accounts out of a schema, one per users table.
 *
 * Every query returns the same five columns (name, email, last_login,
 * last_session, created_at) so the caller never needs to know which app it was.
 * Returns [] when nothing looks like a users table — the caller reports that.
 */
export function planUserQueries(tables: readonly TableInfo[], only?: readonly string[]): UserQuery[] {
  const byBare = new Map<string, TableInfo>();
  for (const table of tables) {
    const key = bare(table.name);
    // Postgres can have the same name in two schemas; public wins.
    if (!byBare.has(key) || table.name.startsWith('public.')) byBare.set(key, table);
  }

  const wanted = only?.length ? only : USER_TABLES;
  const candidates = wanted
    .map((name) => tables.find((t) => t.name === name) ?? byBare.get(name))
    .filter((t): t is TableInfo => Boolean(t))
    .filter((t) => t.columns.some((c) => /email/i.test(c)));

  const sessions = SESSION_TABLES.map((n) => byBare.get(n)).filter((t): t is TableInfo => Boolean(t));

  return candidates.map((table) => {
    const cols = table.columns;
    const email = cols.includes('email') ? 'email' : cols.find((c) => /email/i.test(c) && !/lower/.test(c)) ?? cols.find((c) => /email/i.test(c))!;
    const name = first(cols, NAME_COLUMNS);
    const login = first(cols, LOGIN_COLUMNS);
    const created = first(cols, CREATED_COLUMNS);

    let sessionExpr = 'NULL';
    for (const session of sessions) {
      const link = sessionLink(table, session);
      const times = SESSION_TIMES.filter((c) => session.columns.includes(c));
      if (!link || times.length === 0) continue;
      const stamp = times.length === 1 ? `s.${quoteName(times[0]!)}` : `COALESCE(${times.map((c) => `s.${quoteName(c)}`).join(', ')})`;
      sessionExpr = `(SELECT MAX(${stamp}) FROM ${quoteName(session.name)} s WHERE s.${quoteName(link.fk)} = u.${quoteName(link.pk)})`;
      break;
    }

    const sql =
      `SELECT ${name ? `u.${quoteName(name)}` : "''"} AS name, u.${quoteName(email)} AS email, ` +
      `${login ? `u.${quoteName(login)}` : 'NULL'} AS last_login, ${sessionExpr} AS last_session, ` +
      `${created ? `u.${quoteName(created)}` : 'NULL'} AS created_at FROM ${quoteName(table.name)} u`;
    return { table: table.name, sql };
  });
}

/** The app's own per-user tables on a Supabase project, where names usually live. */
const PROFILE_TABLES = ['profiles', 'user_profiles', 'users'];
const PROFILE_NAMES = ['display_name', 'full_name', 'name', 'username', 'nickname', 'handle'];
const PROFILE_KEYS = ['user_id', 'auth_user_id', 'id'];
const PROFILE_TIMES = ['last_login_at', 'last_active_at', 'last_seen_at', 'last_seen'];

/** Columns of the candidate profile tables, with types: only a real timestamp may feed GREATEST. */
export const SUPABASE_PROFILE_SCHEMA_SQL =
  "SELECT table_name AS t, column_name AS c, data_type AS type FROM information_schema.columns " +
  `WHERE table_schema = 'public' AND table_name IN (${PROFILE_TABLES.map((t) => `'${t}'`).join(', ')})`;

const META_NAME = `NULLIF(u.raw_user_meta_data->>'full_name', ''), NULLIF(u.raw_user_meta_data->>'name', ''),
    NULLIF(u.raw_user_meta_data->>'display_name', ''), NULLIF(u.raw_user_meta_data->>'user_name', ''),
    NULLIF(u.raw_user_meta_data->>'username', ''), NULLIF(u.raw_user_meta_data->>'preferred_username', ''),
    NULLIF(TRIM(CONCAT(u.raw_user_meta_data->>'first_name', ' ', u.raw_user_meta_data->>'last_name')), ''),
    NULLIF(u.raw_user_meta_data->>'handle', '')`;

/**
 * auth.users on any Supabase, hosted or not.
 *
 * The name is wherever the sign-up flow put it: auth metadata first, then the
 * app's own profiles/user_profiles/users table. Those are read as correlated
 * subqueries with LIMIT 1 rather than joins, because some apps keep several
 * profiles per account and a join would multiply the rows. An app-side
 * last_active_at is often fresher than last_sign_in_at (a long session never
 * signs in again), so the later of the two wins.
 */
export function supabaseUsersSql(schema: readonly Record<string, unknown>[] = []): string {
  const names: string[] = [];
  const times: string[] = [];

  for (const table of PROFILE_TABLES) {
    const cols = schema.filter((r) => r.t === table);
    const columns = cols.map((r) => String(r.c));
    const key = first(columns, PROFILE_KEYS);
    if (!key) continue;
    const from = `FROM public.${quoteName(table)} p WHERE p.${quoteName(key)}::text = u.id::text`;
    const name = first(columns, PROFILE_NAMES);
    if (name) names.push(`(SELECT NULLIF(p.${quoteName(name)}::text, '') ${from} LIMIT 1)`);
    for (const col of PROFILE_TIMES) {
      const type = String(cols.find((r) => r.c === col)?.type ?? '');
      if (type.startsWith('timestamp')) times.push(`(SELECT MAX(p.${quoteName(col)}) ${from})`);
    }
  }

  const name = names.length ? `COALESCE(${META_NAME}, ${names.join(', ')}, '')` : `COALESCE(${META_NAME}, '')`;
  const session = times.length ? `GREATEST(${times.join(', ')})` : 'NULL';
  return `SELECT ${name} AS name, u.email, u.last_sign_in_at AS last_login, ${session} AS last_session, u.created_at
FROM auth.users u WHERE u.deleted_at IS NULL`;
}

/** Rows from a planned query, shaped. */
export function shapeRows(rows: readonly Record<string, unknown>[], site: string, source: string): UserRow[] {
  return rows
    .map((row) => ({
      name: text(row.name),
      email: text(row.email),
      site,
      last_login: later(normalizeTime(row.last_login), normalizeTime(row.last_session)),
      created_at: normalizeTime(row.created_at),
      source,
    }))
    .filter((row) => row.email.includes('@'));
}

// ---------------------------------------------------------------------------
// Databases

export interface Db {
  tables(): Promise<TableInfo[]>;
  query(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

const SQLITE_SCHEMA_SQL =
  "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p " +
  "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'";

function groupColumns(rows: readonly Record<string, unknown>[]): TableInfo[] {
  const tables = new Map<string, string[]>();
  for (const row of rows) {
    const name = String(row.t);
    const list = tables.get(name) ?? [];
    list.push(String(row.c));
    tables.set(name, list);
  }
  return [...tables].map(([name, columns]) => ({ name, columns }));
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeout: number): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text();
  if (!response.ok) throw new UsersDumpError(`HTTP ${response.status}: ${raw.slice(0, 200)}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsersDumpError(raw.slice(0, 200));
  }
}

/** Turso over its HTTP pipeline API: no client library, one request per statement. */
export function libsqlDb(url: string, token: string | undefined, timeout = 30_000): Db {
  const endpoint = `${url.replace(/^libsql:/, 'https:').replace(/\/$/, '')}/v2/pipeline`;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  const query = async (sql: string) => {
    const reply = (await postJson(
      endpoint,
      headers,
      { requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }] },
      timeout,
    )) as {
      results?: {
        type: string;
        error?: { message?: string };
        response?: { result?: { cols: { name: string }[]; rows: { value?: unknown }[][] } };
      }[];
    };
    const result = reply.results?.[0];
    if (!result || result.type !== 'ok') {
      throw new UsersDumpError(result?.error?.message ?? 'libsql: no result');
    }
    const rs = result.response?.result;
    if (!rs) return [];
    return rs.rows.map((row) => Object.fromEntries(rs.cols.map((c, i) => [c.name, row[i]?.value ?? null])));
  };

  return {
    query,
    tables: async () => groupColumns(await query(SQLITE_SCHEMA_SQL)),
    close: async () => {},
  };
}

/** SQLite Cloud's Weblite REST API, authorised with the connection string itself. */
export function sqlitecloudDb(connection: string, timeout = 30_000): Db {
  const url = new URL(connection);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const apikey = url.searchParams.get('apikey') ?? '';
  const auth = `Bearer sqlitecloud://${url.hostname}:${url.port || '8860'}?apikey=${apikey}`;

  const query = async (sql: string) => {
    const response = await fetch(`https://${url.hostname}/v2/weblite/sql`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, database }),
      signal: AbortSignal.timeout(timeout),
    });
    const raw = await response.text();
    let reply: { data?: Record<string, unknown>[]; error?: unknown; message?: string };
    try {
      reply = JSON.parse(raw);
    } catch {
      // A paused free node answers 200 with a sentence, not JSON.
      throw new UsersDumpError(raw.slice(0, 160));
    }
    if (!response.ok || !Array.isArray(reply.data)) {
      throw new UsersDumpError(reply.message ?? JSON.stringify(reply.error ?? reply).slice(0, 160));
    }
    return reply.data;
  };

  return {
    query,
    tables: async () => groupColumns(await query(SQLITE_SCHEMA_SQL)),
    close: async () => {},
  };
}

/** Any Postgres, through the `postgres` client, in a read-only transaction. */
export async function postgresDb(url: string, timeout = 30_000): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, {
    max: 1,
    connect_timeout: Math.ceil(timeout / 1000),
    idle_timeout: 5,
    onnotice: () => {},
    // A managed Postgres wants TLS; one on a docker network may not offer it.
    ssl: /sslmode=disable/.test(url) ? false : 'prefer',
  });

  const query = async (text: string) =>
    (await sql.begin('READ ONLY', (tx) => tx.unsafe(text))) as unknown as Record<string, unknown>[];

  return {
    query,
    tables: async () =>
      groupColumns(
        await query(
          "SELECT table_schema || '.' || table_name AS t, column_name AS c FROM information_schema.columns " +
            "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY ordinal_position",
        ),
      ),
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Quote one word for a POSIX shell. ssh joins its arguments into a remote command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A SQLite file, locally through node:sqlite or on another box through `ssh host sqlite3`. */
export async function sqliteDb(path: string, ssh?: string, timeout = 60_000): Promise<Db> {
  if (ssh) {
    const query = async (sql: string) => {
      const remote = `sqlite3 -readonly -json ${shellQuote(path)} ${shellQuote(sql)}`;
      const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', ssh, remote], {
        timeout,
        maxBuffer: 256 * 1024 * 1024,
      });
      // sqlite3 -json prints nothing at all for an empty result.
      return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
    };
    return { query, tables: async () => groupColumns(await query(SQLITE_SCHEMA_SQL)), close: async () => {} };
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  const query = async (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  return {
    query,
    tables: async () => groupColumns(await query(SQLITE_SCHEMA_SQL)),
    close: async () => db.close(),
  };
}

/** Read a generic database: the Supabase shape when auth.users is there, the heuristic otherwise. */
export async function readDb(db: Db, site: string, source: string, only?: readonly string[]): Promise<UserRow[]> {
  const tables = await db.tables();
  if (!only?.length && tables.some((t) => t.name === 'auth.users' && t.columns.includes('raw_user_meta_data'))) {
    const schema = await db.query(SUPABASE_PROFILE_SCHEMA_SQL);
    return shapeRows(await db.query(supabaseUsersSql(schema)), site, source);
  }
  const plans = planUserQueries(tables, only);
  if (plans.length === 0) throw new UsersDumpError(`no users table among ${tables.length} tables`);
  const rows: UserRow[] = [];
  for (const plan of plans) rows.push(...shapeRows(await db.query(plan.sql), site, `${source}:${bare(plan.table)}`));
  return rows;
}

// ---------------------------------------------------------------------------
// Supabase

const SUPABASE_API = 'https://api.supabase.com/v1';

export interface SupabaseProject {
  id: string;
  name: string;
  status: string;
}

export async function supabaseProjects(token: string, timeout = 30_000): Promise<SupabaseProject[]> {
  const response = await fetch(`${SUPABASE_API}/projects`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new UsersDumpError(`Supabase management API: HTTP ${response.status}`);
  return (await response.json()) as SupabaseProject[];
}

export async function supabaseQuery(
  token: string,
  ref: string,
  sql: string,
  timeout = 120_000,
): Promise<Record<string, unknown>[]> {
  const reply = await postJson(
    `${SUPABASE_API}/projects/${ref}/database/query`,
    { authorization: `Bearer ${token}` },
    { query: sql, read_only: true },
    timeout,
  );
  if (!Array.isArray(reply)) throw new UsersDumpError(JSON.stringify(reply).slice(0, 200));
  return reply as Record<string, unknown>[];
}

/**
 * Self-hosted (or unlisted) Supabase through GoTrue's admin API, a page at a
 * time. A new-style `sb_secret_` key is not a JWT, so it goes in `apikey` only.
 */
export async function gotrueUsers(baseUrl: string, key: string, site: string, timeout = 30_000): Promise<UserRow[]> {
  const headers: Record<string, string> = { apikey: key };
  if (!key.startsWith('sb_')) headers.authorization = `Bearer ${key}`;
  const rows: UserRow[] = [];
  const perPage = 1000;

  for (let page = 1; ; page += 1) {
    const url = `${baseUrl.replace(/\/$/, '')}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      throw new UsersDumpError(`GoTrue admin: HTTP ${response.status} ${(await response.text()).slice(0, 160)}`);
    }
    const reply = (await response.json()) as { users?: Record<string, unknown>[] } | Record<string, unknown>[];
    const users = Array.isArray(reply) ? reply : reply.users ?? [];
    for (const user of users) {
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      rows.push({
        name: text(meta.full_name ?? meta.name ?? meta.display_name ?? meta.user_name ?? meta.username),
        email: text(user.email),
        site,
        last_login: normalizeTime(user.last_sign_in_at),
        created_at: normalizeTime(user.created_at),
        source: 'gotrue',
      });
    }
    if (users.length < perPage) break;
  }
  return rows.filter((row) => row.email.includes('@'));
}

// ---------------------------------------------------------------------------
// One source

export type VaultReader = (project: string) => Promise<Record<string, string>>;

/** Resolve `url`/`token`: a variable in the entry's vault, or the literal value. */
async function resolveValue(entry: SourceEntry, field: 'url' | 'token', vault: VaultReader): Promise<string | undefined> {
  const value = entry[field];
  if (!value || !entry.vault) return value;
  const env = await vault(entry.vault);
  const resolved = env[value];
  if (!resolved) throw new UsersDumpError(`${value} is not in vault ${entry.vault}`);
  return resolved;
}

export function describe(entry: SourceEntry): string {
  if (entry.kind === 'sqlite') return `sqlite:${entry.ssh ? `${entry.ssh}:` : ''}${entry.path}`;
  return entry.vault ? `${entry.kind}:${entry.vault}` : entry.kind;
}

/** The URL a source will actually connect to, for dropping duplicates. */
export async function sourceIdentity(entry: SourceEntry, vault: VaultReader): Promise<string> {
  if (entry.kind === 'sqlite') return `sqlite:${entry.ssh ?? ''}:${entry.path}`;
  const url = (await resolveValue(entry, 'url', vault)) ?? '';
  try {
    const parsed = new URL(url);
    return `${entry.kind}:${parsed.host}${parsed.pathname}`;
  } catch {
    return `${entry.kind}:${url}`;
  }
}

export async function readSource(entry: SourceEntry, vault: VaultReader): Promise<UserRow[]> {
  const source = describe(entry);
  if (entry.kind === 'sqlite') {
    if (!entry.path) throw new UsersDumpError('sqlite source needs a path');
    const db = await sqliteDb(entry.path, entry.ssh);
    try {
      return await readDb(db, entry.site, source, entry.tables);
    } finally {
      await db.close();
    }
  }

  const url = await resolveValue(entry, 'url', vault);
  if (!url) throw new UsersDumpError('no url');
  const token = await resolveValue(entry, 'token', vault).catch(() => undefined);

  if (entry.kind === 'gotrue') {
    if (!token) throw new UsersDumpError('gotrue source needs a service-role key');
    return gotrueUsers(url, token, entry.site);
  }

  let db: Db;
  if (entry.kind === 'libsql') db = libsqlDb(url, token);
  else if (entry.kind === 'sqlitecloud') db = sqlitecloudDb(url);
  else if (entry.kind === 'postgres') {
    if (!isPublicHost(url)) {
      throw new UsersDumpError(`${new URL(url).hostname} is a private network name — add a *_PUBLIC_URL or an ssh sqlite/postgres entry`);
    }
    db = await postgresDb(url);
  } else throw new UsersDumpError(`unknown kind ${String(entry.kind)}`);

  try {
    return await readDb(db, entry.site, source, entry.tables);
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// Summary

export function formatReport(reports: readonly SourceReport[], total: number): string {
  const width = Math.max(4, ...reports.map((r) => r.site.length));
  const sourceWidth = Math.max(6, ...reports.map((r) => r.source.length));
  const lines = reports
    .slice()
    .sort((a, b) => Number(Boolean(a.error)) - Number(Boolean(b.error)) || b.users - a.users || a.site.localeCompare(b.site))
    .map((r) =>
      `${r.site.padEnd(width)}  ${r.source.padEnd(sourceWidth)}  ${r.error ? `  -  ${r.error}` : String(r.users).padStart(5)}`,
    );
  const failed = reports.filter((r) => r.error).length;
  lines.push('', `${total} users from ${reports.length - failed} sources` + (failed ? `, ${failed} failed or skipped` : ''));
  return `${lines.join('\n')}\n`;
}
