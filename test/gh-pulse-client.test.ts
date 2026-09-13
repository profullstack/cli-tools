import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_RESERVE,
  GitHub,
  acquireRunLock,
  cacheDir,
  clientOptions,
  collectEvents,
  emptyMovement,
  pageBudget,
  pruneCache,
  sinceParam,
} from '../src/gh-pulse.ts';

/** A GitHub reply; the headers are what the client reads on every response. */
function reply(status: number, body: unknown = null, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fake clock: `sleep` advances it instead of waiting, and records every wait. */
function clock(start = 1_000_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

interface Call { url: string; headers: Record<string, string>; at: number }

/** A fetch that answers from a script, recording every request with the clock time it started. */
function scripted(c: ReturnType<typeof clock>, answers: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url, headers, at: c.now() };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error(`no scripted reply for ${url}`);
    return next(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const HOUR = 3600_000;

describe('GitHub client pacing', () => {
  it('keeps the minimum gap between request starts', async () => {
    const c = clock();
    const { fetchImpl, calls } = scripted(c, [() => reply(200, { a: 1 }), () => reply(200, { a: 2 }), () => reply(200, { a: 3 })]);
    const gh = new GitHub('t', fetchImpl, { minIntervalMs: 100, now: c.now, sleep: c.sleep });
    await Promise.all([gh.get('/a'), gh.get('/b'), gh.get('/c')]);
    // Three starts, two gaps of the minimum: the first goes at once, each later one waits for its gap.
    // (The fake clock jumps inside sleep, so the recorded fetch times are not the thing to assert on.)
    expect(c.sleeps).toEqual([100, 100]);
    expect(calls).toHaveLength(3);
    expect(gh.calls).toEqual({ made: 3, retries: 0, cached: 0, counted: 3 });
  });

  it('pauses until the hour resets once it is down to the reserve, then goes on', async () => {
    const c = clock();
    const reset = String(Math.floor((c.now() + 30 * 60_000) / 1000));
    const waits: string[] = [];
    const { fetchImpl, calls } = scripted(c, [
      () => reply(200, [1], { 'x-ratelimit-remaining': '500', 'x-ratelimit-reset': reset }),
      () => reply(200, [2], { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Number(reset) + 3600) }),
    ]);
    const gh = new GitHub('t', fetchImpl, { reserve: 500, minIntervalMs: 0, now: c.now, sleep: c.sleep, onWait: (l) => waits.push(l) });
    const first = await gh.get<number[]>('/one');
    expect(first.data).toEqual([1]);
    expect(gh.remaining).toBe(500);
    const second = await gh.get<number[]>('/two');
    expect(second.data).toEqual([2]);
    // The second request started after the reset, not before it.
    expect(calls[1]!.at).toBeGreaterThanOrEqual(Number(reset) * 1000);
    expect(c.sleeps.some((ms) => ms >= 30 * 60_000)).toBe(true);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatch(/500 of the hour left/);
    expect(waits[0]).toMatch(/reserve/);
    expect(gh.calls.counted).toBe(2);
  });

  it('does not pause while the hour has more than the reserve', async () => {
    const c = clock();
    const reset = String(Math.floor((c.now() + HOUR) / 1000));
    const { fetchImpl } = scripted(c, [() => reply(200, 1, { 'x-ratelimit-remaining': '501', 'x-ratelimit-reset': reset }), () => reply(200, 2)]);
    const gh = new GitHub('t', fetchImpl, { reserve: 500, minIntervalMs: 0, now: c.now, sleep: c.sleep });
    await gh.get('/a');
    await gh.get('/b');
    expect(c.sleeps).toEqual([]);
  });

  it('waits out a 403 with the hour spent for as long as GitHub says, on one shared pause', async () => {
    const c = clock();
    const reset = String(Math.floor((c.now() + 50 * 60_000) / 1000));
    const waits: string[] = [];
    const limited = () => reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset });
    const { fetchImpl, calls } = scripted(c, [
      limited, limited,
      () => reply(200, 'a', { 'x-ratelimit-remaining': '4999' }),
      () => reply(200, 'b', { 'x-ratelimit-remaining': '4998' }),
    ]);
    const gh = new GitHub('t', fetchImpl, { minIntervalMs: 0, now: c.now, sleep: c.sleep, onWait: (l) => waits.push(l) });
    const [a, b] = await Promise.all([gh.get<string>('/a'), gh.get<string>('/b')]);
    expect([a.data, b.data].sort()).toEqual(['a', 'b']);
    expect(gh.calls.retries).toBe(2);
    // One pause for both, not one each: one long sleep, and both retries start after the reset.
    expect(c.sleeps.filter((ms) => ms >= 50 * 60_000)).toHaveLength(1);
    expect(calls.slice(2).every((k) => k.at >= Number(reset) * 1000)).toBe(true);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatch(/resuming \d\d:\d\d UTC, in 5[01] min/);
  });

  it('honours retry-after on a secondary limit', async () => {
    const c = clock();
    const { fetchImpl } = scripted(c, [() => reply(403, { message: 'secondary rate limit' }, { 'retry-after': '30' }), () => reply(200, 'ok')]);
    const gh = new GitHub('t', fetchImpl, { minIntervalMs: 0, now: c.now, sleep: c.sleep });
    expect((await gh.get<string>('/x')).data).toBe('ok');
    expect(c.sleeps).toEqual([30_000]);
  });

  it('gives up on a 403 that is not about the rate limit', async () => {
    const c = clock();
    const { fetchImpl } = scripted(c, [() => reply(403, { message: 'Resource not accessible' }, { 'x-ratelimit-remaining': '4000' })]);
    const gh = new GitHub('t', fetchImpl, { minIntervalMs: 0, now: c.now, sleep: c.sleep });
    await expect(gh.get('/x')).rejects.toThrow(/GitHub 403/);
    expect(c.sleeps).toEqual([]);
  });
});

describe('GitHub client cache', () => {
  it('offers the ETag next time and takes a 304 from the cache without charging the hour', async () => {
    const c = clock();
    const dir = mkdtempSync(join(tmpdir(), 'gh-pulse-cache-'));
    const { fetchImpl, calls } = scripted(c, [
      () => reply(200, { views: [1, 2] }, { etag: 'W/"abc"', link: '<https://api.github.com/x?page=2>; rel="next"' }),
      () => reply(304),
    ]);
    const gh = new GitHub('t', fetchImpl, { cacheDir: dir, minIntervalMs: 0, now: c.now, sleep: c.sleep });
    const first = await gh.get('/repos/o/r/traffic/views');
    expect(calls[0]!.headers['if-none-match']).toBeUndefined();
    expect(readdirSync(dir)).toHaveLength(1);
    const second = await gh.get('/repos/o/r/traffic/views');
    expect(calls[1]!.headers['if-none-match']).toBe('W/"abc"');
    expect(second).toEqual(first);
    expect(second.link).toContain('rel="next"');
    expect(gh.calls).toEqual({ made: 2, retries: 0, cached: 1, counted: 1 });
  });

  it('keeps entries apart by accept header, since the star listing is a different body', async () => {
    const c = clock();
    const dir = mkdtempSync(join(tmpdir(), 'gh-pulse-cache-'));
    const { fetchImpl, calls } = scripted(c, [() => reply(200, ['plain'], { etag: '"p"' }), () => reply(200, ['starred'], { etag: '"s"' })]);
    const gh = new GitHub('t', fetchImpl, { cacheDir: dir, minIntervalMs: 0, now: c.now, sleep: c.sleep });
    await gh.get('/repos/o/r/stargazers');
    const starred = await gh.get('/repos/o/r/stargazers', { accept: 'application/vnd.github.star+json' });
    expect(calls[1]!.headers['if-none-match']).toBeUndefined();
    expect(starred.data).toEqual(['starred']);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('runs without a cache directory', async () => {
    const c = clock();
    const { fetchImpl, calls } = scripted(c, [() => reply(200, 1, { etag: '"x"' }), () => reply(200, 2, { etag: '"x"' })]);
    const gh = new GitHub('t', fetchImpl, { minIntervalMs: 0, now: c.now, sleep: c.sleep });
    await gh.get('/a');
    await gh.get('/a');
    expect(calls[1]!.headers['if-none-match']).toBeUndefined();
    expect(gh.calls.cached).toBe(0);
  });

  it('prunes entries nobody has asked about for a month and leaves the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-pulse-cache-'));
    const now = Date.now();
    writeFileSync(join(dir, 'old.json.gz'), 'x');
    writeFileSync(join(dir, 'fresh.json.gz'), 'x');
    writeFileSync(join(dir, 'other.txt'), 'x');
    const old = new Date(now - 40 * 86400000);
    utimesSync(join(dir, 'old.json.gz'), old, old);
    utimesSync(join(dir, 'other.txt'), old, old);
    expect(pruneCache(dir, now)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['fresh.json.gz', 'other.txt']);
    expect(pruneCache(join(dir, 'missing'), now)).toBe(0);
  });

  it('reads the reserve from the environment and puts the cache under the data dir', () => {
    expect(clientOptions('/d', () => {}, {})).toMatchObject({ cacheDir: cacheDir('/d'), reserve: DEFAULT_RESERVE });
    expect(clientOptions('/d', () => {}, { GH_PULSE_RESERVE: '1200' }).reserve).toBe(1200);
    expect(clientOptions('/d', () => {}, { GH_PULSE_RESERVE: 'lots' }).reserve).toBe(DEFAULT_RESERVE);
    expect(clientOptions('/d', () => {}, { GH_PULSE_RESERVE: '-5' }).reserve).toBe(DEFAULT_RESERVE);
  });
});

describe('GitHub client failure', () => {
  it('starts nothing queued behind a failed task, and refuses further requests', async () => {
    const c = clock();
    const { fetchImpl } = scripted(c, [() => reply(500, { message: 'boom' }), () => reply(200, 'never')]);
    const gh = new GitHub('t', fetchImpl, { concurrency: 1, minIntervalMs: 0, now: c.now, sleep: c.sleep });
    let ran = 0;
    const results = await Promise.allSettled([
      gh.limit(() => gh.get('/first')),
      gh.limit(async () => { ran += 1; return gh.get('/second'); }),
      gh.limit(async () => { ran += 1; return 'third'; }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(ran).toBe(0);
    expect(gh.calls.made).toBe(1);
    await expect(gh.get('/later')).rejects.toThrow(/GitHub 500/);
  });

  it('reads the budget off the reply headers, and says so when it has not seen one', async () => {
    const c = clock();
    const reset = Math.floor((c.now() + HOUR) / 1000);
    const { fetchImpl } = scripted(c, [() => reply(200, { login: 'u' }, { 'x-ratelimit-remaining': '4321', 'x-ratelimit-reset': String(reset) })]);
    const gh = new GitHub('t', fetchImpl, { minIntervalMs: 0, now: c.now, sleep: c.sleep });
    expect(gh.budgetLine()).toBe('GitHub: rate limit unknown');
    await gh.get('/user');
    expect(gh.budgetLine()).toMatch(/^GitHub: 4321 calls left this hour, resets \d\d:\d\d UTC, reserve 500$/);
  });
});

describe('events since the cutoff', () => {
  it('asks from the top of the hour so the URL repeats, and drops the commits from before the exact cutoff', async () => {
    const cutoff = Date.parse('2026-09-13T03:05:36.694Z');
    expect(sinceParam(cutoff)).toBe('2026-09-13T03:00:00.000Z');
    const c = clock();
    const commit = (date: string, name: string) => ({ author: { login: name }, commit: { author: { name, date }, committer: { date } } });
    const { fetchImpl, calls } = scripted(c, [
      (call) => {
        if (call.url.includes('/commits')) {
          expect(call.url).toContain('since=2026-09-13T03:00:00.000Z');
          return reply(200, [commit('2026-09-13T04:00:00Z', 'late'), commit('2026-09-13T03:02:00Z', 'early')]);
        }
        return reply(200, []);
      },
      () => reply(200, []),
      () => reply(200, []),
      () => reply(200, []),
    ]);
    const gh = new GitHub('t', fetchImpl, { minIntervalMs: 0, now: c.now, sleep: c.sleep });
    const m = emptyMovement();
    await collectEvents(gh, 'o/r', cutoff, pageBudget('daily'), m);
    expect(calls.some((k) => k.url.includes('/commits?since=2026-09-13T03:00:00.000Z'))).toBe(true);
    expect(m.commits).toBe(1);
    expect(m.authors).toEqual(['late']);
  });
});

describe('run lock', () => {
  it('refuses a second run while the first is alive, and takes over a stale lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-pulse-lock-'));
    const release = acquireRunLock(dir, 100, () => true);
    expect(existsSync(join(dir, 'run.lock'))).toBe(true);
    expect(() => acquireRunLock(dir, 200, () => true)).toThrow(/pid 100/);
    // The holder died: the next run takes the lock over.
    const release2 = acquireRunLock(dir, 200, () => false);
    release(); // the old releaser must not remove the new holder's lock
    expect(existsSync(join(dir, 'run.lock'))).toBe(true);
    release2();
    expect(existsSync(join(dir, 'run.lock'))).toBe(false);
  });
});
