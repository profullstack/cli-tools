#!/usr/bin/env node
/**
 * user-export — every user account across many databases, as one CSV.
 *
 *   user-export -o users.csv
 *   → site,name,email,last_login
 *
 * Which databases, and with which credentials, is a config file whose secret
 * fields are references (`env:NAME`, `vault:<project>/<env>/<KEY>`), so the
 * same command serves anyone: the file names your sources, the environment or
 * your logicsrc vault holds the keys.
 */

import { writeFileSync } from 'node:fs';

import { UsageError, csv, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  EXAMPLE_CONFIG,
  ExportError,
  defaultConfigPath,
  exportUsers,
  formatSummary,
  loadConfig,
  secretResolver,
  toCsv,
} from '../src/user-export.ts';

const USAGE = `Usage:
  user-export [--config FILE] [-o FILE] [--only site,site] [--source] [--json]
  user-export --example        print a sample config

Reads every source in the config and writes one CSV of
site,name,email,last_login to stdout (or -o FILE). A per-source count, and any
source that failed, goes to stderr; a failed source never stops the others.

Sources (see --example):
  supabase-management  every project a Supabase access token can see (auth.users)
  supabase-auth        one Supabase instance, cloud or self-hosted, by service key
  libsql               Turso / libSQL over HTTP, with your own SELECT
  sqlite               a SQLite file, opened read-only, with your own SELECT
  postgres             any Postgres URL, in a read-only transaction

Custom queries must alias their columns to name, email and last_login.
Secret fields take a literal, env:NAME, or vault:<project>/<env>/<KEY>
(logicsrc team vault; team from "vaultTeam" or vault:<team>/<project>/<env>/<KEY>).

Options:
      --config FILE  config path (default: $USER_EXPORT_CONFIG, then
                     ~/.config/cli-tools/user-export.json)
  -o, --out FILE     write the CSV here instead of stdout (created mode 600)
      --only SITES   comma-separated site labels to read
      --source       add a source column
      --json         rows and per-source results as JSON
  -q, --quiet        no per-source summary on stderr
  -h, --help         show this help

The output is personal data. -o writes it owner-readable only.
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--example', '--source', '--json', '-q', '--quiet'],
      string: ['--config', '-o', '--out', '--only'],
    });

    if (flags.has('-h') || flags.has('--help')) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (flags.has('--example')) {
      process.stdout.write(`${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`);
      process.exit(0);
    }
    if (positional.length) throw new UsageError(`unexpected argument: ${positional[0]}`);

    const path = values.get('--config') || process.env.USER_EXPORT_CONFIG || defaultConfigPath();
    const config = loadConfig(path);
    const resolve = secretResolver(process.env, config.vaultTeam ? { team: config.vaultTeam } : {});
    const results = await exportUsers(config, resolve, { only: csv(values, '--only') });

    const rows = results.flatMap((r) => r.rows);
    const sources = results.flatMap((r) => r.rows.map(() => r.source));
    const text = flags.has('--json')
      ? `${JSON.stringify({ rows, sources: results.map(({ rows: r, ...rest }) => ({ ...rest, count: r.length })) }, null, 2)}\n`
      : toCsv(rows, { withSource: flags.has('--source'), sources });

    const out = values.get('-o') || values.get('--out');
    if (out) writeFileSync(out, text, { mode: 0o600 });
    else process.stdout.write(text);

    if (!flags.has('-q') && !flags.has('--quiet')) {
      process.stderr.write(formatSummary(results));
      if (out) process.stderr.write(`wrote ${rows.length} rows to ${out}\n`);
    }
    // Partial output is still output, but a script should know it was partial.
    process.exit(results.some((r) => r.error) ? 3 : 0);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ExportError) {
      process.stderr.write(`user-export: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`user-export: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
