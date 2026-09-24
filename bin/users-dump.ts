#!/usr/bin/env node
/**
 * users-dump — every user account across the fleet, as one CSV.
 *
 *   users-dump discover            find the databases (once, and after a new app)
 *   users-dump -o users.csv        name,email,site,last_login,created_at,source
 *   users-dump --only ugig.net,tsbb
 *
 * Supabase.com projects come from the management API and need no setup beyond
 * a live token. Turso, SQLite Cloud, self-hosted Supabase and Postgres come
 * from the team vaults, located by `discover` and written down (names only, no
 * values) in ~/.config/cli-tools/users-dump.json. src/users-dump.ts has the
 * rest.
 */

import { UsageError, csv, integer, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  type Config,
  type SourceEntry,
  type SourceReport,
  type UserRow,
  UsersDumpError,
  configPath,
  dedupe,
  describe,
  discoverSources,
  formatReport,
  listVaults,
  loadConfig,
  mapLimit,
  mergeSources,
  pullVaultAsync,
  readSource,
  saveConfig,
  shapeRows,
  sourceIdentity,
  SUPABASE_PROFILE_SCHEMA_SQL,
  supabaseProjects,
  supabaseQuery,
  supabaseRef,
  supabaseUsersSql,
  toCsv,
  vaultCache,
} from '../src/users-dump.ts';
import { writeFileSync } from 'node:fs';

const USAGE = `Usage:
  users-dump [-o file.csv] [--only site,site] [--json]
  users-dump discover [--dry-run]
  users-dump sources

Every user account across the fleet: Supabase.com projects through the
management API, plus the Turso, SQLite Cloud, self-hosted Supabase, Postgres and
SQLite databases listed in ${configPath()}.

Columns: name,email,site,last_login,created_at,source — one row per person per
site, last_login in ISO 8601 UTC ('' when the app never recorded one).

Commands:
  (none)       dump. CSV to stdout, or to --out; a per-source summary on stderr
  discover     pull every prod vault in the team, find the user databases and the
               live Supabase management token, and write them to the config file.
               Hand edits (site, skip, tables) and hand-added entries survive
  sources      list what a dump would read

Options:
  -o, --out FILE      write the CSV here instead of stdout
      --only SITES    comma-separated site names to read (others skipped)
      --json          JSON array instead of CSV
      --no-supabase   skip the Supabase.com projects
      --concurrency N databases read at once (default 6)
      --team T        logicsrc team (default from config: profullstack)
      --env E         vault environment (default from config: prod)
      --dry-run       discover: print what was found, write nothing
  -h, --help          show this help

A database discover cannot see — SQLite on a box, Postgres on a private
network — goes in the config by hand:

  { "site": "example.com", "kind": "sqlite", "ssh": "vienna", "path": "/srv/example/data.db" }
  { "site": "example.com", "kind": "postgres", "url": "postgres://…" }

SUPABASE_ACCESS_TOKEN in the environment overrides the vault copy.
`;

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function discover(config: Config, dryRun: boolean): Promise<void> {
  const projects = await listVaults(config.team, config.env);
  say(`users-dump: reading ${projects.length} ${config.env} vaults in ${config.team}…`);

  const envs = new Map<string, Record<string, string>>();
  await mapLimit(projects, 8, async (project) => {
    try {
      envs.set(project, await pullVaultAsync(config.team, project, config.env));
    } catch (error) {
      say(`  ${project}: could not pull (${error instanceof Error ? error.message.split('\n')[0] : error})`);
    }
  });

  // Only one of the SUPABASE_ACCESS_TOKEN copies in the vaults is alive, and
  // which one changes when someone rotates it — so each distinct value is tried.
  const tried = new Set<string>();
  let hostedRefs = new Set<string>();
  let tokenVault: string | undefined;
  for (const project of projects) {
    const token = envs.get(project)?.SUPABASE_ACCESS_TOKEN;
    if (!token || tried.has(token)) continue;
    tried.add(token);
    try {
      const listed = await supabaseProjects(token);
      hostedRefs = new Set(listed.map((p) => p.id));
      tokenVault = project;
      say(`  Supabase management token: live in ${project} (${listed.length} projects)`);
      break;
    } catch {
      // Dead copy; keep looking.
    }
  }
  if (!tokenVault) say(`  no live SUPABASE_ACCESS_TOKEN among ${tried.size} distinct copies`);

  // The same database is often in several vaults (ugig's is in eight). The
  // vault with the shortest name is usually the app itself rather than a
  // satellite, so it is the one kept.
  const found = new Map<string, SourceEntry>();
  for (const project of [...envs.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const env = envs.get(project)!;
    for (const entry of discoverSources(project, env, hostedRefs)) {
      const identity = await sourceIdentity(entry, async () => env);
      if (!found.has(identity)) found.set(identity, entry);
    }
  }

  const discovered = [...found.values()].sort((a, b) => a.site.localeCompare(b.site));
  const next: Config = { ...config, sources: mergeSources(config.sources, discovered) };
  if (tokenVault) next.supabaseTokenVault = tokenVault;

  for (const entry of discovered) say(`  ${entry.site.padEnd(28)} ${describe(entry)}`);
  say(`users-dump: ${discovered.length} vault databases + ${hostedRefs.size} Supabase.com projects`);

  if (dryRun) {
    say('users-dump: --dry-run, nothing written');
    return;
  }
  saveConfig(next);
  say(`users-dump: wrote ${configPath()}`);
}

async function dump(
  config: Config,
  options: { only: string[]; supabase: boolean; concurrency: number },
): Promise<{ rows: UserRow[]; reports: SourceReport[] }> {
  const vault = vaultCache(config.team, config.env);
  const wanted = (site: string) => options.only.length === 0 || options.only.includes(site);
  const reports: SourceReport[] = [];
  const rows: UserRow[] = [];
  const hostedRefs = new Set<string>();

  if (options.supabase) {
    let token = process.env.SUPABASE_ACCESS_TOKEN;
    if (!token && config.supabaseTokenVault) {
      token = (await vault(config.supabaseTokenVault).catch(() => ({}) as Record<string, string>))
        .SUPABASE_ACCESS_TOKEN;
    }
    if (!token) {
      reports.push({ site: 'supabase.com', source: 'supabase', users: 0, error: 'no management token — run `users-dump discover`' });
    } else {
      const projects = await supabaseProjects(token);
      for (const p of projects) hostedRefs.add(p.id);
      await mapLimit(
        projects.filter((p) => wanted(p.name)),
        options.concurrency,
        async (project) => {
          const report: SourceReport = { site: project.name, source: 'supabase', users: 0 };
          reports.push(report);
          if (project.status !== 'ACTIVE_HEALTHY') {
            report.error = `project is ${project.status}`;
            return;
          }
          try {
            const schema = await supabaseQuery(token!, project.id, SUPABASE_PROFILE_SCHEMA_SQL);
            const sql = supabaseUsersSql(schema);
            const got = shapeRows(await supabaseQuery(token!, project.id, sql), project.name, 'supabase');
            rows.push(...got);
            report.users = got.length;
          } catch (error) {
            report.error = error instanceof Error ? error.message : String(error);
          }
        },
      );
    }
  }

  // Drop what the management API already read, and any database listed twice.
  const seen = new Set<string>();
  const entries: SourceEntry[] = [];
  for (const entry of config.sources) {
    if (entry.skip || !wanted(entry.site)) continue;
    try {
      const identity = await sourceIdentity(entry, vault);
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (entry.kind === 'gotrue' && options.supabase) {
        const ref = supabaseRef(identity.replace(/^gotrue:/, 'https://'));
        if (ref && hostedRefs.has(ref)) continue;
      }
    } catch {
      // Unresolvable: let readSource fail it with the reason, in the summary.
    }
    entries.push(entry);
  }

  await mapLimit(entries, options.concurrency, async (entry) => {
    const report: SourceReport = { site: entry.site, source: describe(entry), users: 0 };
    reports.push(report);
    try {
      const got = await readSource(entry, vault);
      rows.push(...got);
      report.users = new Set(got.map((r) => r.email.toLowerCase())).size;
    } catch (error) {
      report.error = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 160);
    }
  });

  const merged = dedupe(rows).sort(
    (a, b) => a.site.localeCompare(b.site) || b.last_login.localeCompare(a.last_login) || a.email.localeCompare(b.email),
  );
  return { rows: merged, reports };
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--json', '--no-supabase', '--dry-run'],
      string: ['-o', '--out', '--only', '--concurrency', '--team', '--env'],
    });

    if (flags.has('-h') || flags.has('--help')) {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    const config = loadConfig();
    if (values.has('--team')) config.team = values.get('--team')!;
    if (values.has('--env')) config.env = values.get('--env')!;
    const verb = positional[0];

    if (verb === 'discover') {
      await discover(config, flags.has('--dry-run'));
    } else if (verb === 'sources') {
      if (config.supabaseTokenVault) say(`supabase.com projects via the token in ${config.supabaseTokenVault}`);
      for (const entry of config.sources) {
        process.stdout.write(`${entry.skip ? '- ' : '  '}${entry.site.padEnd(28)} ${describe(entry)}\n`);
      }
      if (config.sources.length === 0) say(`nothing in ${configPath()} yet — run \`users-dump discover\``);
    } else if (verb === undefined) {
      if (config.sources.length === 0 && !config.supabaseTokenVault && !process.env.SUPABASE_ACCESS_TOKEN) {
        throw new UsageError('no sources configured — run `users-dump discover` first');
      }
      const { rows, reports } = await dump(config, {
        only: csv(values, '--only'),
        supabase: !flags.has('--no-supabase'),
        concurrency: integer(values, '--concurrency', 6, { min: 1, max: 32 }),
      });
      const body = flags.has('--json') ? `${JSON.stringify(rows, null, 2)}\n` : toCsv(rows);
      const out = values.get('--out') ?? values.get('-o');
      if (out) {
        // Emails of every user we have: private to this account, like the config.
        writeFileSync(out, body, { mode: 0o600 });
      } else {
        process.stdout.write(body);
      }
      process.stderr.write(formatReport(reports, rows.length));
      if (out) say(`wrote ${out}`);
    } else {
      throw new UsageError(`unknown command: ${verb}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof UsersDumpError) {
      process.stderr.write(`users-dump: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`users-dump: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
