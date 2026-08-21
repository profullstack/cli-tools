#!/usr/bin/env -S npx --yes tsx
/**
 * genrewatch — what is coming out, and whether it exists at all.
 *
 * Reads the public API at genrewatch.com, which takes no key and no account.
 * Companion to the site rather than a replacement for it: this answers the two
 * questions worth asking from a terminal, which are "is this a thing" and "what
 * is out this week".
 */

import { UsageError, integer, parseArgs } from '../src/args.ts';
import {
  DEFAULT_BASE,
  categories,
  formatWhen,
  pad,
  search,
  upcoming,
} from '../src/genrewatch.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  genrewatch search <words>...        find anything, out or not
  genrewatch upcoming                 what is coming up
  genrewatch categories               what the catalogue covers

Search reaches the back catalogue as well as the calendar, so a film from 1999
is a valid answer. Anything the site does not already hold is looked up live.

Options:
  -c, --category NAME   tv | film | anime | music | space
  -g, --genre SLUG      restrict upcoming to one genre (e.g. drama-tv)
  -n, --limit N         how many rows (default: 20)
      --base URL        point at another deployment (default: ${DEFAULT_BASE})
      --json            emit raw JSON instead of a table
  -h, --help            show this help

A date with no time is printed as a date. The API says which is which, and a
release genuinely has no hour -- printing one would be inventing it.
`;

function table(rows: string[][]): string {
  const first = rows[0];
  if (!first) return '';
  const widths = first.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => pad(cell ?? '', widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--json', '-h', '--help'],
      string: ['-c', '--category', '-g', '--genre', '-n', '--limit', '--base'],
    });

    if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 ? 1 : 0);
    }

    const json = flags.has('--json');
    const base = values.get('--base') ?? DEFAULT_BASE;
    const category = values.get('-c') ?? values.get('--category') ?? '';
    const genre = values.get('-g') ?? values.get('--genre') ?? '';
    const limit = integer(values, values.has('-n') ? '-n' : '--limit', 20, { min: 1, max: 50 });

    const [command, ...rest] = positional;

    if (command === 'search') {
      const term = rest.join(' ').trim();
      if (term.length < 2) throw new UsageError('search needs at least two characters');
      const results = await search(term, { base, category, limit });
      if (json) {
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      } else if (results.length === 0) {
        process.stderr.write(`nothing matched "${term}"\n`);
        process.exit(1);
      } else {
        process.stdout.write(
          `${table(
            results.map((r) => [
              r.name,
              r.category,
              r.released ? String(new Date(r.released).getUTCFullYear()) : '',
              r.upcoming ? 'upcoming' : '',
            ]),
          )}\n`,
        );
      }
    } else if (command === 'upcoming') {
      const events = await upcoming({ base, category, genre, limit });
      if (json) {
        process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
      } else if (events.length === 0) {
        process.stderr.write('nothing upcoming\n');
        process.exit(1);
      } else {
        process.stdout.write(
          `${table(
            events.map((e) => [formatWhen(e), e.name, e.category, e.venue ?? '']),
          )}\n`,
        );
      }
    } else if (command === 'categories') {
      const cats = await categories({ base });
      if (json) {
        process.stdout.write(`${JSON.stringify(cats, null, 2)}\n`);
      } else {
        process.stdout.write(
          `${table(cats.map((c) => [c.category, `${c.genres} genres`, `${c.upcoming} upcoming`]))}\n`,
        );
      }
    } else {
      throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`genrewatch: ${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`genrewatch: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
