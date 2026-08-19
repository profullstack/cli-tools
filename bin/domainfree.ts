#!/usr/bin/env -S npx --yes tsx
/**
 * domainfree — bulk domain availability, straight from the registry.
 *
 * Prints only the names that can actually be registered, one per line, so the
 * output pipes into anything. Companion to `domainjson`, which looks one name
 * up in depth; this answers one question across thousands.
 */

import { readFile } from 'node:fs/promises';
import { UsageError, integer, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  DEFAULT_JOBS,
  DEFAULT_TIMEOUT_MS,
  checkMany,
  normalizeNames,
  summarize,
} from '../src/domain-free.ts';

const USAGE = `Usage:
  domainfree <name>...
  domainfree --file candidates.txt
  generate-names "a registry that checks Lean proofs" | domainfree
  printf '%s\n' sorry{check,lint,scan}.com | domainfree

Availability is read from RDAP, never inferred from DNS: a parked domain
resolves but is taken, and a domain registered with no nameservers returns
NXDOMAIN exactly like a free one.

Options:
  -f, --file FILE   read names from FILE, one per line ("-" for stdin)
  -j, --jobs N      parallel lookups (default: ${DEFAULT_JOBS})
  -t, --timeout MS  per-lookup timeout (default: ${DEFAULT_TIMEOUT_MS})
  -a, --all         print every name as "STATUS domain", not just the free ones
  -q, --quiet       suppress the summary, which goes to stderr
  -h, --help        show this help

Only available names go to stdout, so \`domainfree -f in.txt | wc -l\` counts
what you can buy. Exit status is 2 when any lookup stayed indeterminate — an
unknown is never reported as available.
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-a', '--all', '-q', '--quiet', '-h', '--help'],
      string: ['-f', '--file', '-j', '--jobs', '-t', '--timeout'],
    });

    if (flags.has('-h') || flags.has('--help')) {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    const showAll = flags.has('-a') || flags.has('--all');
    const quiet = flags.has('-q') || flags.has('--quiet');
    const jobs = integer(values, values.has('-j') ? '-j' : '--jobs', DEFAULT_JOBS, {
      min: 1,
      max: 128,
    });
    const timeout = integer(
      values,
      values.has('-t') ? '-t' : '--timeout',
      DEFAULT_TIMEOUT_MS,
      { min: 100, max: 120_000 },
    );

    const file = values.get('-f') ?? values.get('--file');
    let raw: string;
    if (file) {
      raw = file === '-' ? await readStdin() : await readFile(file, 'utf8');
    } else if (positional.length > 0) {
      raw = positional.join('\n');
    } else if (!process.stdin.isTTY) {
      raw = await readStdin();
    } else {
      process.stderr.write(USAGE);
      process.exit(1);
    }

    const names = normalizeNames(raw);
    if (names.length === 0) {
      process.stderr.write('domainfree: no valid domain names given\n');
      process.exit(1);
    }

    const results = await checkMany(names, { jobs, timeout });

    for (const result of results.slice().sort((a, b) => a.domain.localeCompare(b.domain))) {
      if (showAll) {
        const label =
          result.status === 'available'
            ? 'AVAILABLE'
            : result.status === 'taken'
              ? 'TAKEN'
              : `ERR:${result.code ?? 'timeout'}`;
        process.stdout.write(`${label} ${result.domain}\n`);
      } else if (result.status === 'available') {
        process.stdout.write(`${result.domain}\n`);
      }
    }

    const { available, taken, unknown } = summarize(results);
    if (!quiet) {
      const parts = [`${names.length} checked`, `${available} available`, `${taken} taken`];
      if (unknown > 0) parts.push(`${unknown} unknown`);
      process.stderr.write(`${parts.join(' · ')}\n`);
    }

    process.exit(unknown > 0 ? 2 : 0);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`domainfree: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
