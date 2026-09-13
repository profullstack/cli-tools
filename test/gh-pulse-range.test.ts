import { describe, expect, it } from 'vitest';

import {
  buildLedger,
  commitCapFor,
  customRange,
  emptyMovement,
  foldDays,
  ledgerDays,
  ledgerSum,
  mergeBuckets,
  pageBudget,
  parseRangeKey,
  pointAt,
  rangeDays,
  rangeSpec,
  type Bucket,
  type Movement,
  type ReportMover,
  type Snapshot,
} from '../src/gh-pulse.ts';
import { applyFilters, defaultFilters, movedIn } from '../src/gh-pulse-tui.ts';

const b = (day: string, count: number, uniques = count): Bucket => ({ timestamp: `${day}T00:00:00Z`, count, uniques });
const snap = (at: string, repos: Snapshot['repos'], followers: string[] = []): Snapshot => ({ at, user: 'u', followersCount: followers.length, followers, repos });
const row = (stars: number, views: Bucket[] | null, clones: Bucket[] | null = null): Snapshot['repos'][string] =>
  ({ id: 1, stars, forks: 0, openIssues: 0, pushedAt: '', private: false, archived: false, views, clones });
const now = new Date('2026-09-13T13:05:00Z');

describe('ranges', () => {
  it('reads every spelling people type', () => {
    expect(parseRangeKey('week')).toBe('week');
    expect(parseRangeKey('7d')).toBe('week');
    expect(parseRangeKey('Last Month')).toBe('month');
    expect(parseRangeKey('1h')).toBe('hour');
    expect(parseRangeKey('all-time')).toBe('all');
    expect(parseRangeKey('fortnight')).toBeNull();
  });

  it('turns a key into a start date and a label', () => {
    const w = rangeSpec('week', now);
    expect(w.since.toISOString()).toBe('2026-09-06T13:05:00.000Z');
    expect(w.label).toBe('last 7 days');
    expect(rangeDays(w, now)).toBe(7);
    expect(rangeSpec('all', now).since.getTime()).toBe(0);
    expect(rangeDays(rangeSpec('all', now), now)).toBe(Number.POSITIVE_INFINITY);
  });

  it('accepts a custom start date and refuses the future', () => {
    const c = customRange('2026-09-01', now);
    expect(c.key).toBe('custom');
    expect(c.slug).toBe('since-2026-09-01');
    expect(rangeDays(c, now)).toBe(13);
    expect(() => customRange('2027-01-01', now)).toThrow(/past date/);
  });

  it('scales the commit cap with the range and grows the page budget', () => {
    expect(commitCapFor(1)).toBe(25);
    expect(commitCapFor(30)).toBe(750);
    expect(commitCapFor(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(pageBudget('week').pulls).toBeGreaterThan(pageBudget('day').pulls);
    expect(pageBudget('all').commits).toBeGreaterThan(pageBudget('year').commits);
    expect(pageBudget('custom', 45)).toEqual(pageBudget('quarter'));
  });
});

describe('ledger', () => {
  it('lays snapshots end to end and lets the newest one revise a day', () => {
    const older = snap('2026-09-12T13:00:00Z', { 'o/a': row(5, [b('2026-09-10', 3), b('2026-09-11', 8)]) }, ['x']);
    const newer = snap('2026-09-13T13:00:00Z', { 'o/a': row(6, [b('2026-09-11', 9), b('2026-09-12', 2)]) }, ['x', 'y']);
    const ledger = buildLedger([newer, older]);
    const series = ledger.views.get('o/a')!;
    expect([...series.keys()]).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
    expect(series.get('2026-09-11')?.count).toBe(9);
    expect(ledger.firstDay).toBe('2026-09-10');
    expect(ledger.points.map((p) => p.stars)).toEqual([5, 6]);
    expect(ledgerSum(series, '2026-09-11', '2026-09-12')).toEqual({ count: 11, uniques: 11 });
    expect(ledgerDays(series, '2026-09-09', '2026-09-12').map((d) => d.count)).toEqual([0, 3, 9, 2]);
  });

  it('merges live buckets on top and picks the point at the start of a range', () => {
    const ledger = buildLedger([snap('2026-09-12T13:00:00Z', { 'o/a': row(5, null) }), snap('2026-09-13T13:00:00Z', { 'o/a': row(7, null) })]);
    mergeBuckets(ledger, 'o/a', [b('2026-09-13', 4)], null);
    expect(ledger.views.get('o/a')?.get('2026-09-13')?.count).toBe(4);
    expect(pointAt(ledger, new Date('2026-09-12T20:00:00Z'))?.stars).toBe(5);
    expect(pointAt(ledger, new Date('2026-09-01T00:00:00Z'))).toBeNull();
    expect(pointAt(ledger, new Date('2026-09-14T00:00:00Z'))?.stars).toBe(7);
    expect(pointAt(buildLedger([]), now)).toBeNull();
  });

  it('folds a long series into a readable number of bars', () => {
    const days = ledgerDays(new Map([['2026-01-05', b('2026-01-05', 10)]]), '2026-01-01', '2026-04-10');
    expect(days).toHaveLength(100);
    const folded = foldDays(days, 60);
    expect(folded.length).toBeLessThanOrEqual(60);
    expect(folded.reduce((t, d) => t + d.count, 0)).toBe(10);
    expect(folded[0]?.day).toBe('2026-01-01');
    expect(foldDays(days.slice(0, 14), 60)).toHaveLength(14);
  });
});

describe('filters', () => {
  const mover = (repo: string, patch: Partial<Movement>, isPrivate = false): ReportMover => ({
    repo, private: isPrivate, url: '', stars: 0, forks: 0, score: 1, movement: { ...emptyMovement(), ...patch },
    views14d: [], clones14d: [], referrers: [], paths: [],
  });
  const movers = [
    mover('profullstack/a', { stars: 2 }),
    mover('ralyodio/b', { commits: 3 }, true),
    mover('profullstack/c', { views: 9, uniques: 3 }),
  ];

  it('knows which kinds moved', () => {
    expect(movedIn(movers[0]!.movement, 'stars')).toBe(true);
    expect(movedIn(movers[0]!.movement, 'traffic')).toBe(false);
    expect(movedIn(movers[2]!.movement, 'traffic')).toBe(true);
    expect(movedIn({ ...emptyMovement(), prClosed: 1 }, 'prs')).toBe(true);
  });

  it('keeps a repo while any enabled kind moved, and keeps the original rank', () => {
    const f = defaultFilters();
    expect(applyFilters(movers, f).map((r) => r.rank)).toEqual([1, 2, 3]);
    f.kinds.delete('stars');
    expect(applyFilters(movers, f).map((r) => r.mover.repo)).toEqual(['ralyodio/b', 'profullstack/c']);
    f.showPrivate = false;
    expect(applyFilters(movers, f).map((r) => r.rank)).toEqual([3]);
    f.hiddenOwners.add('profullstack');
    expect(applyFilters(movers, f)).toEqual([]);
  });
});
