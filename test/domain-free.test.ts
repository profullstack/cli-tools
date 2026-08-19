import { describe, expect, it } from 'vitest';
import {
  type Fetcher,
  checkMany,
  checkOne,
  classify,
  normalizeNames,
  rdapEndpoint,
  summarize,
} from '../src/domain-free.ts';

describe('rdapEndpoint', () => {
  it('sends .com and .net straight to Verisign', () => {
    expect(rdapEndpoint('sorrycheck.com')).toBe(
      'https://rdap.verisign.com/com/v1/domain/sorrycheck.com',
    );
    expect(rdapEndpoint('example.net')).toBe(
      'https://rdap.verisign.com/net/v1/domain/example.net',
    );
  });

  it('sends .org to PIR', () => {
    expect(rdapEndpoint('example.org')).toBe(
      'https://rdap.publicinterestregistry.org/rdap/domain/example.org',
    );
  });

  it('falls back to rdap.org for everything else', () => {
    expect(rdapEndpoint('nosorry.dev')).toBe('https://rdap.org/domain/nosorry.dev');
    expect(rdapEndpoint('example.co.uk')).toBe('https://rdap.org/domain/example.co.uk');
  });
});

describe('classify', () => {
  it('treats 404 as available and 200 as taken', () => {
    expect(classify(404)).toBe('available');
    expect(classify(200)).toBe('taken');
  });

  it('never reports an indeterminate response as available', () => {
    // The whole point: a rate limit read as "available" sends you to buy a
    // name someone already owns.
    for (const code of [429, 500, 502, 503, 0, null]) {
      expect(classify(code as number | null)).toBe('unknown');
    }
  });
});

describe('normalizeNames', () => {
  it('lowercases, trims and dedupes', () => {
    expect(normalizeNames('  GOOGLE.com \nexample.com\ngoogle.com\n')).toEqual([
      'example.com',
      'google.com',
    ]);
  });

  it('drops blanks, comments and anything that is not a bare domain', () => {
    const input = [
      '',
      '# a comment',
      'not a domain',
      'http://example.com',
      'example.com/path',
      'localhost',
      'good.com',
    ].join('\n');
    expect(normalizeNames(input)).toEqual(['good.com']);
  });

  it('keeps multi-label names', () => {
    expect(normalizeNames('a.b.example.co.uk')).toEqual(['a.b.example.co.uk']);
  });
});

const fakeFetcher =
  (byUrl: Record<string, number | null>): Fetcher =>
  async (url) =>
    url in byUrl ? byUrl[url]! : 404;

describe('checkOne', () => {
  it('reports the registry verdict and the code behind it', async () => {
    const fetcher = fakeFetcher({
      'https://rdap.verisign.com/com/v1/domain/taken.com': 200,
    });
    expect(await checkOne('taken.com', { fetcher })).toEqual({
      domain: 'taken.com',
      status: 'taken',
      code: 200,
    });
    expect(await checkOne('free.com', { fetcher })).toEqual({
      domain: 'free.com',
      status: 'available',
      code: 404,
    });
  });
});

describe('checkMany', () => {
  it('preserves input order regardless of completion order', async () => {
    const fetcher: Fetcher = async (url) => {
      // Force the first name to settle last, so completion order differs from
      // input order, without spending wall-clock time on a timer.
      if (url.endsWith('a.com')) {
        for (let i = 0; i < 50; i += 1) await Promise.resolve();
        return 404;
      }
      return 200;
    };
    const results = await checkMany(['a.com', 'b.com', 'c.com'], {
      fetcher,
      jobs: 3,
      retryDelayMs: 0,
    });
    expect(results.map((r) => r.domain)).toEqual(['a.com', 'b.com', 'c.com']);
    expect(results.map((r) => r.status)).toEqual(['available', 'taken', 'taken']);
  });

  it('retries an indeterminate result once, and keeps the better answer', async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return calls === 1 ? 429 : 404; // rate limited, then fine
    };
    const results = await checkMany(['flaky.com'], { fetcher, jobs: 1, retryDelayMs: 0 });
    expect(calls).toBe(2);
    expect(results[0]!.status).toBe('available');
  });

  it('leaves a result unknown when the retry also fails', async () => {
    const fetcher: Fetcher = async () => null;
    const results = await checkMany(['down.com'], { fetcher, jobs: 1, retryDelayMs: 0 });
    expect(results[0]!.status).toBe('unknown');
  });

  it('honours the job cap', async () => {
    let live = 0;
    let peak = 0;
    const fetcher: Fetcher = async () => {
      live += 1;
      peak = Math.max(peak, live);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      live -= 1;
      return 404;
    };
    await checkMany(
      Array.from({ length: 20 }, (_, i) => `n${i}.com`),
      { fetcher, jobs: 4, retryDelayMs: 0 },
    );
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('summarize', () => {
  it('counts each verdict', () => {
    expect(
      summarize([
        { domain: 'a.com', status: 'available', code: 404 },
        { domain: 'b.com', status: 'taken', code: 200 },
        { domain: 'c.com', status: 'taken', code: 200 },
        { domain: 'd.com', status: 'unknown', code: 429 },
      ]),
    ).toEqual({ available: 1, taken: 2, unknown: 1 });
  });
});
