#!/usr/bin/env node
/**
 * user-export — every user account across many databases, as one CSV.
 *
 *   user-export -o users.csv
 *   → site,name,email,last_login
 *   user-export --clean -o list.csv --dropped dropped.csv
 *   → email,first_name,last_name, only the addresses worth mailing
 *   user-export --clean --full -o list.csv
 *   → email,first_name,last_name,company_domain,job_title,linkedin_url,
 *     enriched from the config's "enrich" sources
 *
 * Which databases, and with which credentials, is a config file whose secret
 * fields are references (`env:NAME`, `vault:<project>/<env>/<KEY>`), so the
 * same command serves anyone: the file names your sources, the environment or
 * your logicsrc vault holds the keys.
 */

import { writeFileSync } from 'node:fs';

import {
  defaultCachePath,
  formatLookupSummary,
  loadCache,
  lookupLinkedin,
  saveCache,
  valueSerp,
} from '../src/linkedin-lookup.ts';

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
  enrichContacts,
  formatCleanSummary,
  formatEnrichSummary,
  mynaOptOuts,
  resendSuppressions,
  toCleanCsv,
  toContacts,
  forExplee,
  formatExpleeSummary,
  toMissingCsv,
  type CleanedRow,
  type ContactRow,
  toDroppedCsv,
} from '../src/user-clean.ts';

const USAGE = `Usage:
  user-export [--config FILE] [-o FILE] [--only site,site] [--source] [--json]
  user-export --clean [-o FILE] [--dropped FILE] [--only site,site]
  user-export --full [--clean] [-o FILE] [--no-enrich] [--no-linkedin] [--linkedin-max N]
  user-export --format explee [--clean] [-o FILE] [--missing FILE] [--default-title TEXT]
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

--full writes one row per address with
email,first_name,last_name,company_domain,job_title,linkedin_url, and always
enriches: every source in the config's "enrich" array (same types as
"sources"; alias columns to email, name or first_name/last_name, job_title,
linkedin_url, company_domain) is read and matched by email, filling only blank
fields. company_domain falls back to the address's own domain unless that is
webmail. Add --clean to drop the addresses not worth mailing first.

With "linkedin": {"serpKey": <secret reference>} in the config, --full then
searches Google (ValueSERP) for whoever still has no linkedin_url: a profile
is taken only when its title carries the full name and, with a company, the
company's name; with no company, only when a single profile matches. Failing
that, the company's linkedin.com/company page. Answers are cached in
~/.cache/cli-tools/linkedin-lookup.json, so a rerun only searches new contacts;
"maxSearches" (default 3000) or --linkedin-max caps the new searches per run.

Options:
      --config FILE  config path (default: $USER_EXPORT_CONFIG, then
                     ~/.config/cli-tools/user-export.json)
  -o, --out FILE     write the CSV here instead of stdout (created mode 600)
      --only SITES   comma-separated site labels to read
      --source       add a source column
      --json         rows and per-source results as JSON
      --clean        only the addresses worth mailing (see above)
      --full         the six contact columns above, enriched
      --no-enrich    with --full: skip the "enrich" sources
      --no-linkedin  with --full: skip the LinkedIn search
      --format explee   --full, keeping only rows Explee's import accepts:
                     email, first_name, last_name, company_domain and job_title
                     all set (it skips any other row without saying why)
      --missing FILE with --format: email,missing for every row left out
      --default-title TEXT   with --format explee: fill a blank job_title
      --linkedin-max N   with --full: at most N new searches this run
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
      boolean: ['-h', '--help', '--example', '--source', '--json', '-q', '--quiet', '--clean', '--full', '--no-enrich', '--no-linkedin', '--keep-never-logged-in', '--no-resend', '--no-dns'],
      string: ['--config', '-o', '--out', '--only', '--dropped', '--linkedin-max', '--format', '--missing', '--default-title'],
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
    const format = values.get('--format');
    if (format !== undefined && format !== 'explee') throw new UsageError(`unknown --format: ${format} (known: explee)`);
    const full = flags.has('--full') || format === 'explee';
    let text: string;
    let cleanSummary = '';
    let contacts: CleanedRow[] | undefined;
    let enrichResults: Awaited<ReturnType<typeof exportUsers>> = [];

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
      contacts = result.kept;
      const dropped = values.get('--dropped');
      if (dropped) writeFileSync(dropped, toDroppedCsv(result.dropped), { mode: 0o600 });
      cleanSummary = formatCleanSummary(result);
    } else if (full) {
      contacts = toContacts(rows);
    }

    if (contacts) {
      if (full && config.enrich?.length && !flags.has('--no-enrich')) {
        enrichResults = await exportUsers({ ...config, sources: config.enrich }, resolve);
        const enriched = enrichContacts(contacts, enrichResults.flatMap((r) => r.rows));
        contacts = enriched.contacts;
        cleanSummary += formatEnrichSummary(enriched, contacts.length);
      }
      const serpKey = config.linkedin?.serpKey;
      if (full && serpKey && !flags.has('--no-linkedin')) {
        const max = values.get('--linkedin-max');
        const maxSearches = max === undefined ? (config.linkedin?.maxSearches ?? 3000) : Number(max);
        if (!Number.isInteger(maxSearches) || maxSearches < 0) throw new UsageError('--linkedin-max takes a whole number');
        const cachePath = defaultCachePath();
        const cache = loadCache(cachePath);
        try {
          const found = await lookupLinkedin(contacts as ContactRow[], valueSerp(resolve(serpKey, 'linkedin.serpKey')), {
            cache,
            maxSearches,
            concurrency: config.linkedin?.concurrency ?? 20,
            // A long run is visible, and a killed one keeps what it paid for.
            onProgress: (r, done, total) => {
              saveCache(cachePath, cache);
              if (!quiet) {
                process.stderr.write(`linkedin: ${done}/${total} contacts, ${r.searches} searches, +${r.people} profiles, +${r.companies} company pages\n`);
              }
            },
          });
          contacts = found.contacts;
          cleanSummary += formatLookupSummary(found);
        } finally {
          saveCache(cachePath, cache);
        }
      }
      if (format === 'explee') {
        const explee = forExplee(contacts, { defaultTitle: values.get('--default-title') ?? '' });
        contacts = explee.kept;
        const missing = values.get('--missing');
        if (missing) writeFileSync(missing, toMissingCsv(explee.missing), { mode: 0o600 });
        cleanSummary += formatExpleeSummary(explee);
      }
      text = toCleanCsv(contacts, { full });
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
      if (enrichResults.length) process.stderr.write(`enrich sources:\n${formatSummary(enrichResults)}`);
      process.stderr.write(cleanSummary);
      if (out) process.stderr.write(`wrote ${text.split('\n').length - 2} rows to ${out}\n`);
    }
    // Partial output is still output, but a script should know it was partial.
    // exitCode, not exit(): exit() cut piped stdout off at 64 KiB.
    process.exitCode = [...results, ...enrichResults].some((r) => r.error) ? 3 : 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ExportError) {
      process.stderr.write(`user-export: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`user-export: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
