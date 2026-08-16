import { describe, expect, it } from 'vitest';
import { clean, hyperlink, table, timeAgo, truncate } from '../src/format.ts';
import { csv, integer, parseArgs, UsageError } from '../src/args.ts';
import { buildArgs, hasCheckSubcommand } from '../src/fix-all.ts';
import { parseDomainArgs } from '../src/domain.ts';
import { isMain } from '../src/is-main.ts';

const NOW = new Date('2026-08-16T12:00:00Z');
const ago = (seconds: number): string =>
  timeAgo(new Date(NOW.getTime() - seconds * 1000).toISOString(), NOW);

describe('timeAgo', () => {
  it('matches the jq original at each threshold', () => {
    expect(ago(1)).toBe('1 second ago');
    expect(ago(59)).toBe('59 seconds ago');
    expect(ago(60)).toBe('1 minute ago');
    expect(ago(3599)).toBe('59 minutes ago');
    expect(ago(3600)).toBe('1 hour ago');
    expect(ago(86_399)).toBe('23 hours ago');
    expect(ago(86_400)).toBe('1 day ago');
    expect(ago(604_800)).toBe('1 week ago');
    expect(ago(2_629_800)).toBe('1 month ago');
    expect(ago(31_557_600)).toBe('1 year ago');
  });

  it('never reads negative when the clock is behind the server', () => {
    expect(timeAgo(new Date(NOW.getTime() + 5000).toISOString(), NOW)).toBe('0 seconds ago');
  });

  it('says so rather than printing NaN for an unparseable date', () => {
    expect(timeAgo('not a date', NOW)).toBe('unknown');
  });
});

describe('cell formatting', () => {
  it('collapses whitespace that would break a row across lines', () => {
    expect(clean('a\nb\tc')).toBe('a b c');
    expect(clean(null)).toBe('');
  });

  it('truncates to exactly the requested width, ellipsis included', () => {
    expect(truncate('abcdefghij', 10)).toBe('abcdefghij');
    expect(truncate('abcdefghijk', 10)).toHaveLength(10);
    expect(truncate('abcdefghijk', 10)).toBe('abcdefg...');
  });
});

describe('table', () => {
  const rows = [
    ['ORG', 'PR'],
    ['acme', '#1'],
    ['verylongowner', '#22'],
  ];

  it('pads columns to the widest cell', () => {
    const out = table(rows).split('\n');
    expect(out[0]).toBe('ORG            PR');
    expect(out[1]).toBe('acme           #1');
    expect(out[2]).toBe('verylongowner  #22');
  });

  it('leaves plain text alone when hyperlinks are off', () => {
    expect(table(rows, { linkColumns: [1], urls: [undefined, 'u1', 'u2'] })).not.toContain(
      '',
    );
  });

  /**
   * The bug this guards: an OSC-8 escape is zero-width on screen but a dozen
   * characters to String.length. Padding the decorated cell throws every
   * following column out by the length of a URL.
   */
  it('measures padding on the undecorated text', () => {
    const linked = table(
      [
        ['A', 'B'],
        ['x', 'y'],
        ['xxxxx', 'y'],
      ],
      { linkColumns: [0], urls: [undefined, 'https://example.com/1', 'https://example.com/2'], hyperlinks: true },
    ).split('\n');

    // Strip the escapes and the layout must be identical to the plain version.
    const stripped = linked.map((line) => line.replace(/\]8;;[^]*\\/g, ''));
    expect(stripped[1]).toBe('x      y');
    expect(stripped[2]).toBe('xxxxx  y');
  });

  it('never decorates the header row', () => {
    const out = table(rows, {
      linkColumns: [0],
      urls: ['header-url', 'u1', 'u2'],
      hyperlinks: true,
    }).split('\n');
    expect(out[0]).not.toContain('');
  });

  it('builds a well-formed OSC-8 sequence', () => {
    expect(hyperlink('text', 'https://example.com')).toBe(
      ']8;;https://example.com\\text]8;;\\',
    );
  });
});

describe('parseArgs', () => {
  const spec = { boolean: ['--apply'], string: ['--limit'] } as const;

  it('accepts both --flag value and --flag=value', () => {
    expect(parseArgs(['--limit', '5'], spec).values.get('--limit')).toBe('5');
    expect(parseArgs(['--limit=5'], spec).values.get('--limit')).toBe('5');
  });

  /** `--limit --apply` used to set limit to the string "--apply". */
  it('treats a following flag as a missing value', () => {
    expect(() => parseArgs(['--limit', '--apply'], spec)).toThrow(UsageError);
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['--apply=yes'], spec)).toThrow(/does not take a value/);
  });

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() => parseArgs(['--nope'], spec)).toThrow(/unknown option: --nope/);
  });

  it('stops flag parsing at --', () => {
    expect(parseArgs(['--', '--limit'], spec).positional).toEqual(['--limit']);
  });

  it('validates integers with the flag name in the message', () => {
    const { values } = parseArgs(['--limit', 'abc'], spec);
    expect(() => integer(values, '--limit', 1)).toThrow(/--limit must be a non-negative integer/);
  });

  it('bounds integers', () => {
    const { values } = parseArgs(['--limit', '5000'], spec);
    expect(() => integer(values, '--limit', 1, { min: 1, max: 1000 })).toThrow(/between 1 and 1000/);
  });

  it('splits and trims csv, dropping empties', () => {
    const values = new Map([['--orgs', ' a , b ,, c ']]);
    expect(csv(values, '--orgs')).toEqual(['a', 'b', 'c']);
    expect(csv(new Map(), '--orgs')).toEqual([]);
  });
});

describe('gh-prs-fix-all argument shaping', () => {
  it('adds --fix by default', () => {
    expect(buildArgs([])).toEqual(['check', '--fix']);
  });

  it('omits --fix for a dry run, and does not pass the flag on', () => {
    expect(buildArgs(['--dry-run'])).toEqual(['check']);
    expect(buildArgs(['-n'])).toEqual(['check']);
  });

  it('passes repositories through', () => {
    expect(buildArgs(['owner/name'])).toEqual(['check', 'owner/name', '--fix']);
    expect(buildArgs(['owner/name', '-n'])).toEqual(['check', 'owner/name']);
  });

  it('recognises the check subcommand guard', () => {
    expect(hasCheckSubcommand("if (argument === 'check') {")).toBe(true);
    expect(hasCheckSubcommand('const x = 1;')).toBe(false);
  });
});

describe('isMain', () => {
  /**
   * The regression this exists for: importing `bin/gh-prs-fix-all.ts` to reach
   * one pure function *ran the tool*. The suite went from 60ms to 93 seconds
   * and swept live pull requests with `--fix` implied. Nothing under bin/ may
   * do work at import time.
   */
  it('is false when the module was imported rather than executed', () => {
    expect(isMain('file:///tools/bin/thing.ts', ['node', '/tools/bin/other.ts'])).toBe(false);
  });

  it('is true when the module is the entry point', () => {
    const url = new URL(import.meta.url);
    expect(isMain(url.href, ['node', url.pathname])).toBe(true);
  });

  it('is false with no entry point at all', () => {
    expect(isMain('file:///tools/bin/thing.ts', ['node'])).toBe(false);
  });
});

describe('domainjson argument parsing', () => {
  it('takes the final non-flag argument as the name', () => {
    const parsed = parseDomainArgs(['-s', 'https://rdap.example', 'example.com']);
    expect(parsed.own.name).toBe('example.com');
    // The server URL must not be mistaken for the name.
    expect(parsed.passthrough).toEqual(['-s', 'https://rdap.example']);
  });

  it('drops output-format flags because JSON is forced', () => {
    expect(parseDomainArgs(['--text', '--whois', 'example.com']).passthrough).toEqual([]);
  });

  it('strips trailing slashes from the registry', () => {
    expect(parseDomainArgs(['--registry', 'https://x.test///', 'a.com']).own.registry).toBe(
      'https://x.test',
    );
  });

  it('rejects a non-positive timeout', () => {
    expect(parseDomainArgs(['--timeout', '0', 'a.com']).error).toMatch(/positive integer/);
    expect(parseDomainArgs(['--timeout=abc', 'a.com']).error).toMatch(/positive integer/);
  });

  it('reports a missing name rather than looking up nothing', () => {
    expect(parseDomainArgs([]).error).toBe('no name given');
  });

  it('prefers --name over the positional', () => {
    const parsed = parseDomainArgs(['--name', 'chosen.com', 'other.com']);
    expect(parsed.own.name).toBe('chosen.com');
    expect(parsed.passthrough).toContain('other.com');
  });
});
