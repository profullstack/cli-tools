/**
 * free-names — generating and checking as one command.
 *
 * The two halves already have their own tests for what they each do, so what
 * is worth testing here is only the join: that every candidate generated is a
 * candidate checked, that the list of free names agrees with the counts beside
 * it, and above all that a lookup which answered neither way is never reported
 * as available. That last one is the whole point of the command — somebody
 * acts on this output by trying to buy something.
 */

import { describe, expect, it } from 'vitest';
import type { Result } from '../src/domain-free.ts';
import { DEFAULT_COUNT, freeNames } from '../src/free-names.ts';

const call = async () => '{"heads":["sync"],"modifiers":["swift"],"exemplars":["syncswift"]}';

/** A generator that returns exactly what you hand it. */
const generating = (names: string[]) => async () => names;

/** A checker that answers from a map, defaulting to taken. */
const checking = (verdicts: Record<string, Result['status']>) => async (names: readonly string[]) =>
  names.map((domain) => ({
    domain,
    status: verdicts[domain] ?? ('taken' as const),
    code: null,
  })) as Result[];

describe('freeNames', () => {
  it('checks every candidate the generator produced', async () => {
    const seen: string[][] = [];
    const report = await freeNames('a desktop app for fast transfers', call, {}, {
      generate: generating(['one.com', 'two.com', 'three.com']),
      check: async (names) => {
        seen.push([...names]);
        return checking({})(names);
      },
    });

    expect(seen).toEqual([['one.com', 'two.com', 'three.com']]);
    expect(report.candidates).toEqual(['one.com', 'two.com', 'three.com']);
    expect(report.checked).toBe(3);
  });

  it('returns only the names a registry says are free, sorted', async () => {
    const report = await freeNames('a desktop app for fast transfers', call, {}, {
      generate: generating(['zeta.com', 'alpha.com', 'beta.com']),
      check: checking({ 'zeta.com': 'available', 'alpha.com': 'available' }),
    });

    expect(report.available).toEqual(['alpha.com', 'zeta.com']);
    expect(report.taken).toBe(1);
  });

  it('never reports an indeterminate lookup as available', async () => {
    // The failure that costs somebody real money: an unknown counted as free.
    const report = await freeNames('a desktop app for fast transfers', call, {}, {
      generate: generating(['maybe.com', 'sure.com']),
      check: checking({ 'maybe.com': 'unknown', 'sure.com': 'available' }),
    });

    expect(report.available).toEqual(['sure.com']);
    expect(report.unknown).toBe(1);
    expect(report.available).not.toContain('maybe.com');
  });

  it('keeps the list and the counts in agreement', async () => {
    const report = await freeNames('a desktop app for fast transfers', call, {}, {
      generate: generating(['a.com', 'b.com', 'c.com', 'd.com']),
      check: checking({ 'a.com': 'available', 'b.com': 'available', 'c.com': 'unknown' }),
    });

    expect(report.available.length + report.taken + report.unknown).toBe(report.checked);
  });

  it('passes the generation options through', async () => {
    let got: unknown;
    await freeNames('a desktop app for fast transfers', call, {
      count: 7, tld: 'dev', words: 1, seed: 42,
    }, {
      generate: async (_description, _call, options) => {
        got = options;
        return [];
      },
      check: checking({}),
    });

    expect(got).toMatchObject({ count: 7, tld: 'dev', words: 1, seed: 42 });
  });

  it('passes the lookup options through', async () => {
    let got: unknown;
    await freeNames('a desktop app for fast transfers', call, { jobs: 4, timeout: 1234 }, {
      generate: generating(['one.com']),
      check: async (_names, options) => {
        got = options;
        return [];
      },
    });

    expect(got).toMatchObject({ jobs: 4, timeout: 1234 });
  });

  it('does not go to the registry when nothing was generated', async () => {
    // A thin vocabulary is not an error, and checking nothing is a wasted trip.
    let checked = false;
    const report = await freeNames('a desktop app for fast transfers', call, {}, {
      generate: generating([]),
      check: async (names) => {
        checked = true;
        return checking({})(names);
      },
    });

    expect(checked).toBe(false);
    expect(report.available).toEqual([]);
    expect(report.checked).toBe(0);
  });

  it('defaults to fewer candidates than generate-names alone', async () => {
    // Every candidate here costs a registry lookup, not a line of output.
    expect(DEFAULT_COUNT).toBe(100);

    let got: { count?: number } | undefined;
    await freeNames('a desktop app for fast transfers', call, {}, {
      generate: async (_description, _call, options) => {
        got = options;
        return [];
      },
      check: checking({}),
    });

    expect(got?.count).toBe(DEFAULT_COUNT);
  });
});
