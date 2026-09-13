import { describe, expect, it } from 'vitest';

import {
  baselineFor,
  chartPair,
  emptyMovement,
  fourteenDays,
  isMover,
  lastPage,
  movementBits,
  newestDay,
  nextLink,
  renderHtml,
  resendBody,
  score,
  subjectLine,
  trafficBits,
  trafficDelta,
  type Bucket,
  type Movement,
  type ReportContext,
  type RepoState,
  type Snapshot,
} from '../src/gh-pulse.ts';
import { historyRows } from '../src/gh-pulse-tui.ts';

const b = (day: string, count: number, uniques = count): Bucket => ({ timestamp: `${day}T00:00:00Z`, count, uniques });
const moved = (patch: Partial<Movement>): Movement => ({ ...emptyMovement(), ...patch });

describe('trafficDelta', () => {
  it('counts only the growth of buckets present in the baseline, and new buckets in full', () => {
    const prev = [b('2026-09-10', 5, 2), b('2026-09-11', 20, 9)];
    const cur = [b('2026-09-11', 29, 17), b('2026-09-12', 7, 3)];
    expect(trafficDelta(cur, prev, '2026-09-11')).toEqual({ count: 9 + 7, uniques: 8 + 3 });
  });

  it('never goes negative when GitHub revises a bucket down', () => {
    expect(trafficDelta([b('2026-09-11', 3)], [b('2026-09-11', 5)], '2026-09-11')).toEqual({ count: 0, uniques: 0 });
  });

  it('without a baseline takes every bucket on or after the first-run day', () => {
    const cur = [b('2026-09-09', 100), b('2026-09-11', 4), b('2026-09-12', 6)];
    expect(trafficDelta(cur, null, '2026-09-11')).toEqual({ count: 10, uniques: 10 });
  });

  it('is zero when the repo has no traffic access', () => {
    expect(trafficDelta(null, null, '2026-09-11')).toEqual({ count: 0, uniques: 0 });
  });
});

describe('newestDay', () => {
  it('ignores the empty buckets GitHub pads up to today', () => {
    const padded = [b('2026-09-11', 12), b('2026-09-12', 0), b('2026-09-13', 0)];
    const other = [b('2026-09-10', 1)];
    expect(newestDay([padded, other, null], '2026-09-13')).toBe('2026-09-11');
  });

  it('falls back when nothing has any traffic', () => {
    expect(newestDay([[b('2026-09-12', 0)], null], '2026-09-13')).toBe('2026-09-13');
  });
});

describe('fourteenDays', () => {
  it('zero-fills fourteen days ending on the given day, oldest first', () => {
    const days = fourteenDays([b('2026-09-11', 29, 17)], '2026-09-11');
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ day: '2026-08-29', count: 0, uniques: 0 });
    expect(days[13]).toEqual({ day: '2026-09-11', count: 29, uniques: 17 });
  });

  it('leaves out buckets after the end day', () => {
    const days = fourteenDays([b('2026-09-12', 99)], '2026-09-11');
    expect(days.every((d) => d.count === 0)).toBe(true);
  });
});

describe('scoring', () => {
  it('weights stars above commits and caps commits', () => {
    expect(score(moved({ stars: 2 }))).toBe(10);
    expect(score(moved({ commits: 100 }))).toBe(25);
    expect(score(moved({ prMerged: 1, prOpened: 1 }))).toBe(5);
    expect(score(moved({ views: 10, uniques: 4, clones: 2, cloners: 1 }))).toBeCloseTo(2 + 4 + 1 + 1);
  });

  it('does not reward lost stars but still reports them', () => {
    const m = moved({ stars: -1 });
    expect(score(m)).toBe(0);
    expect(isMover(m)).toBe(true);
    expect(movementBits(m)).toEqual(['-1 star']);
  });

  it('treats one clone or one visitor as background noise', () => {
    expect(isMover(moved({ clones: 1, cloners: 1 }))).toBe(false);
    expect(isMover(moved({ views: 3, uniques: 1 }))).toBe(false);
    expect(isMover(moved({ views: 3, uniques: 2 }))).toBe(true);
    expect(isMover(moved({ clones: 5, cloners: 2 }))).toBe(true);
    expect(isMover(moved({ releases: 1 }))).toBe(true);
  });
});

describe('text bits', () => {
  it('pluralises and signs', () => {
    const m = moved({ stars: 3, forks: 1, commits: 1, prMerged: 2, releases: 1, views: 1, uniques: 1, clones: 2, cloners: 2 });
    expect(movementBits(m)).toEqual(['+3 stars', '+1 fork', '1 commit', '2 PRs merged', '1 release']);
    expect(trafficBits(m)).toEqual(['1 view / 1 unique', '2 clones / 2 unique']);
  });

  it('writes the subject with the star delta only when there is one', () => {
    const now = new Date('2026-09-13T13:05:00Z');
    expect(subjectLine(now, 12, null, 368, 1362)).toBe('GitHub pulse 2026-09-13: 12 repos moved, 368 views, 1362 clones');
    expect(subjectLine(now, 12, 4, 1, 2)).toBe('GitHub pulse 2026-09-13: 12 repos moved, +4 stars, 1 views, 2 clones');
  });
});

describe('baselineFor', () => {
  const snap = (at: string): Snapshot => ({ at, user: 'u', followersCount: 0, followers: [], repos: {} });
  const now = new Date('2026-09-14T13:05:00Z');

  it('uses yesterday\'s snapshot, not one from minutes ago or last week', () => {
    expect(baselineFor(snap('2026-09-13T13:05:00Z'), now)?.at).toBe('2026-09-13T13:05:00Z');
    expect(baselineFor(snap('2026-09-14T12:00:00Z'), now)).toBeNull();
    expect(baselineFor(snap('2026-09-01T12:00:00Z'), now)).toBeNull();
    expect(baselineFor(null, now)).toBeNull();
  });
});

describe('link headers', () => {
  it('finds the next and last pages', () => {
    const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=7>; rel="last"';
    expect(nextLink(link)).toBe('https://api.github.com/x?page=2');
    expect(lastPage(link)).toBe(7);
    expect(nextLink('')).toBeUndefined();
    expect(lastPage('')).toBe(1);
  });
});

describe('chartPair', () => {
  it('draws one bar per day with data and labels the peak and the latest day', () => {
    const days = fourteenDays([b('2026-09-05', 10), b('2026-09-11', 4)], '2026-09-11');
    const svg = chartPair({ title: 'Views', color: '#2a78d6', days }, { title: 'Clones', color: '#eb6834', days: [] });
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
    expect(svg).toContain('>10<');
    expect(svg).toContain('>4<');
    expect(svg).toContain('14 in 14d');
    expect(svg).toContain('0 in 14d');
  });
});

describe('resendBody', () => {
  it('sends inline images as attachments with a content id', () => {
    const body = resendBody({ to: 'a@b.c, d@e.f', from: 'P <p@x.y>', subject: 's', html: '<img src="cid:portfolio">', text: 't', images: [{ id: 'portfolio', buf: Buffer.from('png') }] });
    expect(body['to']).toEqual(['a@b.c', 'd@e.f']);
    expect(body['attachments']).toEqual([{ filename: 'portfolio.png', content: Buffer.from('png').toString('base64'), content_type: 'image/png', content_id: 'portfolio' }]);
  });
});

describe('renderHtml', () => {
  const repo = (name: string, m: Partial<Movement>): RepoState => ({
    repo: { id: 1, full_name: name, html_url: `https://github.com/${name}`, private: false, fork: false, archived: false, stargazers_count: 10, forks_count: 2, open_issues_count: 0, pushed_at: '', updated_at: '' },
    views: [b('2026-09-11', 29, 17)], clones: [b('2026-09-11', 279, 79)], trafficOk: true,
    m: { ...moved(m), score: score(moved(m)), mover: true },
    referrers: [{ referrer: 'news.ycombinator.com', count: 12, uniques: 9 }],
    paths: [{ path: `/${name}/blob/main/README.md`, count: 5, uniques: 4 }],
    img: 'cid:r1',
  });

  it('ranks movers, embeds the charts by cid, and names the new stargazers', () => {
    const movers = [repo('profullstack/nixamp', { stars: 1, newStargazers: ['octocat'], views: 29, uniques: 17, clones: 279, cloners: 79 }), repo('profullstack/scripts', { commits: 2 })];
    const ctx: ReportContext = {
      login: 'ralyodio', now: new Date('2026-09-13T03:05:00Z'), cutoff: new Date('2026-09-12T03:05:00Z'), useBaseline: false,
      newestDay: '2026-09-11', trafficLabel: 'GitHub days from 2026-09-11', repoCount: 349, movers, detailed: movers.slice(0, 1),
      followers: ['a', 'b'], followerMoves: { gained: [], lost: [] }, totalStars: 2294, prevTotalStars: null,
      port: { views: 29, uniques: 17, clones: 279, cloners: 79, viewsByDay: new Map(), clonesByDay: new Map() }, trafficBlind: 0, portfolioImg: 'cid:portfolio',
    };
    const html = renderHtml(ctx);
    expect(html.indexOf('profullstack/nixamp')).toBeLessThan(html.indexOf('profullstack/scripts'));
    expect(html).toContain('src="cid:portfolio"');
    expect(html).toContain('src="cid:r1"');
    expect(html).toContain('Starred by <a href="https://github.com/octocat"');
    expect(html).toContain('news.ycombinator.com');
    expect(html).toContain('/blob/main/README.md');
    expect(html).toContain('of 349 scanned');
    expect(html).not.toContain('undefined');
  });
});

describe('historyRows', () => {
  it('sums stars over every repo but traffic only over the movers that were stored', () => {
    const snap: Snapshot = {
      at: '2026-09-13T03:05:36Z', user: 'u', followersCount: 2, followers: ['a', 'b'],
      repos: {
        'o/a': { id: 1, stars: 5, forks: 0, openIssues: 0, pushedAt: '', private: false, archived: false, views: null, clones: null, movement: moved({ views: 3, clones: 4, mover: true }) },
        'o/b': { id: 2, stars: 7, forks: 0, openIssues: 0, pushedAt: '', private: false, archived: false, views: null, clones: null },
      },
    };
    expect(historyRows([snap])).toEqual([{ at: snap.at, repos: 2, stars: 12, followers: 2, movers: 1, views: 3, clones: 4 }]);
  });
});
