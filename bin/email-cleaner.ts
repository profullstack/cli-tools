#!/usr/bin/env node
/**
 * email-cleaner: keep the addresses worth mailing, drop the rest.
 *
 *   email-cleaner list.txt > clean.txt
 *   email-cleaner users.csv --invalid rejected.csv --report > clean.csv
 *
 * The options follow emaillistcleaner.org: role, disposable, duplicate,
 * unlikely and no-website addresses are removed unless allowed. The logic is
 * in src/email-cleaner.ts (`cleanEmails`, `cleanText`) for other tools.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_DNS_SERVER,
  DEFAULT_TIMEOUT_MS,
  type CleanOptions,
  type Format,
  InputError,
  cleanEmails,
  formatReport,
  parseDomainList,
  parseInput,
  render,
} from '../src/email-cleaner.ts';

const USAGE = `Usage:
  email-cleaner [file|-] [options]      reads stdin when no file or "-"

Input is addresses separated by newlines, commas or semicolons, plain or
"Name <addr>", or a CSV whose header has an email column (email, e-mail, mail,
address). The kept entries are written to stdout in the same shape and with
the same separator; CSV rows keep every other column untouched.

Always checked: syntax, provider typos, and (unless --no-dns) whether the
domain exists and takes mail. Removed unless allowed:
      --allow-role          role addresses (info@, support@, admin@, noreply@ ...)
      --allow-disposable    throwaway domains (vendored open list)
      --allow-duplicates    repeats, counting gmail dots and +tags (first one wins)
      --allow-unlikely      placeholders (test@test.com, nothanks@, example.com, .test)
      --allow-no-website    domains that take mail but have no website

Options:
      --no-dns              skip network checks
      --fix-typos           rewrite gmial.com -> gmail.com and the like, and log
                            each fix (without it a typo is rejected with a hint)
      --format FMT          text, csv or json (default: the input's shape)
      --invalid FILE        also write the rejected entries to FILE
      --report              print the report to stderr: log, chart, special
                            types, top 5 domains
      --dns-server IP       resolver to ask (default: ${DEFAULT_DNS_SERVER})
      --dns-timeout MS      per-query timeout (default: ${DEFAULT_TIMEOUT_MS})
  -j, --jobs N              domains looked up at once (default: ${DEFAULT_CONCURRENCY})
      --disposable-list F   more disposable domains, one per line
  -h, --help                show this help

Exit status: 0 when the list was cleaned (even if nothing survived), 2 on bad
input or usage. A DNS lookup that times out never rejects an address.
`;

function readInput(path: string | undefined): string {
  try {
    return readFileSync(path && path !== '-' ? path : 0, 'utf8');
  } catch (error) {
    throw new InputError(`cannot read ${path && path !== '-' ? path : 'stdin'}: ${(error as Error).message}`);
  }
}

if (isMain(import.meta.url)) {
  try {
    // A lone "-" means stdin; parseArgs would take it for a flag.
    const argv = process.argv.slice(2);
    const dash = argv.indexOf('-');
    if (dash !== -1) argv.splice(dash, 1);

    const { flags, values, positional } = parseArgs(argv, {
      boolean: [
        '-h', '--help', '--allow-role', '--allow-disposable', '--allow-duplicates',
        '--allow-unlikely', '--allow-no-website', '--no-dns', '--fix-typos', '--report',
      ],
      string: ['--format', '--invalid', '--dns-server', '--dns-timeout', '-j', '--jobs', '--disposable-list'],
    });

    if (flags.has('-h') || flags.has('--help')) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (positional.length > 1 || (positional.length === 1 && dash !== -1)) {
      throw new UsageError('give one file, or "-" for stdin');
    }

    const format = values.get('--format');
    if (format !== undefined && !['text', 'csv', 'json'].includes(format)) {
      throw new UsageError(`--format must be text, csv or json, got ${JSON.stringify(format)}`);
    }

    const options: CleanOptions = {
      allowRole: flags.has('--allow-role'),
      allowDisposable: flags.has('--allow-disposable'),
      allowDuplicates: flags.has('--allow-duplicates'),
      allowUnlikely: flags.has('--allow-unlikely'),
      allowNoWebsite: flags.has('--allow-no-website'),
      dns: !flags.has('--no-dns'),
      fixTypos: flags.has('--fix-typos'),
      dnsServer: values.get('--dns-server') ?? DEFAULT_DNS_SERVER,
      timeoutMs: integer(values, '--dns-timeout', DEFAULT_TIMEOUT_MS, { min: 100 }),
      concurrency: integer(values, values.has('-j') ? '-j' : '--jobs', DEFAULT_CONCURRENCY, { min: 1, max: 256 }),
    };
    const extra = values.get('--disposable-list');
    if (extra) {
      try {
        options.disposableDomains = parseDomainList(readFileSync(extra, 'utf8'));
      } catch (error) {
        throw new InputError(`cannot read --disposable-list ${extra}: ${(error as Error).message}`);
      }
    }

    const parsed = parseInput(readInput(positional[0]));
    const result = await cleanEmails(parsed.entries, options);
    const fmt = format ? { format: format as Format } : {};

    process.stdout.write(render(parsed, result, fmt));
    const invalidPath = values.get('--invalid');
    if (invalidPath) writeFileSync(invalidPath, render(parsed, result, { ...fmt, which: 'invalid' }));
    if (flags.has('--report')) process.stderr.write(formatReport(result, { dns: options.dns !== false }));
    process.exit(0);
  } catch (error) {
    if (error instanceof UsageError || error instanceof InputError) {
      process.stderr.write(`email-cleaner: ${error.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`email-cleaner: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
