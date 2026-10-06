#!/usr/bin/env node
/**
 * user-export — every user account across many databases, as one CSV.
 *
 *   user-export -o users.csv
 *   → site,name,email,last_login
 *   user-export --clean -o list.csv --dropped dropped.csv
 *   → email,first_name,last_name, only the addresses worth mailing
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
import {
  cleanUsers,
  defaultMynaContacts,
  formatCleanSummary,
  mynaOptOuts,
  resendSuppressions,
  toCleanCsv,
  toDroppedCsv,
} from '../src/user-clean.ts';

const USAGE = `Usage:
  user-export [--config FILE] [-o FILE] [--only site,site] [--source] [--json]
  user-export --clean [-o FILE] [--dropped FILE] [--only site,site]
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
  exec                 any command that prints rows as a JSON array or CSV

Custom queries must alias their columns to name, email and last_login.
sqlite and postgres take "via": a prefix that runs one shell command where the
database lives ("ssh host", "railway ssh -p P -s S -e production",
"docker exec ctr sh -c"); the read-only reader is sent through it.

Secret fields take a literal, env:NAME, vault:<project>/<env>/<KEY>
(logicsrc team vault; team from "vaultTeam" or vault:<team>/<project>/<env>/<KEY>),
or cmd:<shell> (the command's trimmed stdout).

--clean writes email,first_name,last_name instead: one row per address
that is worth mailing. Dropped, in this order: myna unsubscribes, addresses
Resend bounced/suppressed/got a complaint about (last 31 days, key from
$RESEND_API_KEY), config "clean.excludePatterns" (our test accounts), addresses
that never logged in on any site, then whatever email-cleaner rejects (syntax,
dead domain, disposable, role, duplicate). The config's "clean" block takes
excludePatterns, resendKey (a secret reference), resendDays and mynaContacts.

Options:
      --config FILE  config path (default: $USER_EXPORT_CONFIG, then
                     ~/.config/cli-tools/user-export.json)
  -o, --out FILE     write the CSV here instead of stdout (created mode 600)
      --only SITES   comma-separated site labels to read
      --source       add a source column
      --json         rows and per-source results as JSON
      --clean        only the addresses worth mailing (see above)
      --dropped FILE with --clean: every dropped address and why
      --keep-never-logged-in   with --clean: do not drop those
      --no-resend    with --clean: skip the Resend bounce lookup
      --no-dns       with --clean: skip email-cleaner's DNS checks
  -q, --quiet        no per-source summary on stderr
  -h, --help         show this help

The output is personal data. -o writes it owner-readable only.
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--example', '--source', '--json', '-q', '--quiet', '--clean', '--keep-never-logged-in', '--no-resend', '--no-dns'],
      string: ['--config', '-o', '--out', '--only', '--dropped'],
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
    const quiet = flags.has('-q') || flags.has('--quiet');
    const out = values.get('-o') || values.get('--out');
    let text: string;
    let cleanSummary = '';

    if (flags.has('--clean')) {
      const clean = config.clean ?? {};
      const resendKey = flags.has('--no-resend') || clean.resendKey === '' ? '' : resolve(clean.resendKey ?? 'env:RESEND_API_KEY', 'clean.resendKey');
      if (!resendKey && !flags.has('--no-resend')) throw new ExportError('--clean needs a Resend key (RESEND_API_KEY or clean.resendKey), or --no-resend');
      const suppressed = resendKey ? await resendSuppressions(resendKey, { days: clean.resendDays ?? 31 }) : new Map<string, string>();
      const result = await cleanUsers(rows, {
        suppressed,
        optedOut: mynaOptOuts(clean.mynaContacts ?? defaultMynaContacts()),
        exclude: (clean.excludePatterns ?? []).map((p) => new RegExp(p, 'i')),
        keepNeverLoggedIn: flags.has('--keep-never-logged-in'),
        cleaner: flags.has('--no-dns') ? { dns: false } : {},
      });
      text = toCleanCsv(result.kept);
      const dropped = values.get('--dropped');
      if (dropped) writeFileSync(dropped, toDroppedCsv(result.dropped), { mode: 0o600 });
      cleanSummary = formatCleanSummary(result);
    } else {
      const sources = results.flatMap((r) => r.rows.map(() => r.source));
      text = flags.has('--json')
        ? `${JSON.stringify({ rows, sources: results.map(({ rows: r, ...rest }) => ({ ...rest, count: r.length })) }, null, 2)}\n`
        : toCsv(rows, { withSource: flags.has('--source'), sources });
    }

    if (out) writeFileSync(out, text, { mode: 0o600 });
    else process.stdout.write(text);

    if (!quiet) {
      process.stderr.write(formatSummary(results));
      process.stderr.write(cleanSummary);
      if (out) process.stderr.write(`wrote ${text.split('\n').length - 2} rows to ${out}\n`);
    }
    // Partial output is still output, but a script should know it was partial.
    // exitCode, not exit(): exit() cut piped stdout off at 64 KiB.
    process.exitCode = results.some((r) => r.error) ? 3 : 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ExportError) {
      process.stderr.write(`user-export: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`user-export: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
