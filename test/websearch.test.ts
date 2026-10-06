import { describe, expect, it } from 'vitest';

import {
  type Auth,
  type Caller,
  type ProviderResult,
  SearchError,
  authCandidates,
  authHeaders,
  buildBody,
  canonicalUrl,
  costOf,
  describeError,
  formatResults,
  matchScore,
  parseHits,
  rank,
  searchAll,
  terms,
} from '../src/websearch.ts';

const hit = (url: string, title = '', description = '') => ({ url, title, description });
const ok = (provider: ProviderResult['provider'], hits: ReturnType<typeof hit>[]): ProviderResult => ({
  provider,
  hits,
  latencyMs: 100,
  error: null,
});

describe('buildBody', () => {
  it('matches the documented request shape', () => {
    expect(JSON.parse(buildBody({ query: 'q', provider: 'exa', limit: 5, gateway: 'default' }))).toEqual({
      query: 'q',
      provider: 'exa',
      limit: 5,
      options: { gateway: { id: 'default' } },
    });
  });
});

describe('auth', () => {
  it('prefers the token, keeps the global key as fallback', () => {
    const auths = authCandidates({
      CLOUDFLARE_API_TOKEN: 't',
      CLOUDFLARE_EMAIL: 'e@x',
      CLOUDFLARE_GLOBAL_API_KEY: 'k',
    });
    expect(auths.map((a) => a.kind)).toEqual(['token', 'global']);
    expect(authHeaders(auths[1]!)).toEqual({ 'X-Auth-Email': 'e@x', 'X-Auth-Key': 'k' });
  });

  it('needs both halves of the global key', () => {
    expect(authCandidates({ CLOUDFLARE_GLOBAL_API_KEY: 'k' })).toEqual([]);
  });
});

describe('describeError', () => {
  it('flags the v4 auth error so the next credential is tried', () => {
    const error = describeError(
      400,
      JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
    );
    expect(error.authFailure).toBe(true);
    expect(error.message).toContain('Authentication error');
  });

  // The real answer from an account with no gateway credits, 2026-10-06.
  it('says what a 402 payment_required actually means', () => {
    const error = describeError(
      402,
      JSON.stringify({ ok: false, error: { category: 'gateway', code: 'web_search_payment_required', status: 402 } }),
    );
    expect(error.authFailure).toBe(false);
    expect(error.message).toMatch(/AI Gateway credits/);
  });
});

describe('parseHits', () => {
  it('reads the documented response and the v4 wrapper alike', () => {
    const body = { items: [{ url: 'https://a.example', title: 'A', description: 'd' }, { title: 'no url' }], metadata: { latencyMs: 612 } };
    expect(parseHits(JSON.stringify(body))).toEqual({ hits: [hit('https://a.example', 'A', 'd')], latencyMs: 612 });
    expect(parseHits(JSON.stringify({ success: true, result: body })).hits).toHaveLength(1);
  });
});

describe('canonicalUrl', () => {
  it('treats scheme, www, trailing slash, fragment and tracking as the same page', () => {
    const a = canonicalUrl('https://www.Example.com/post/?utm_source=x&b=2&a=1#top');
    const b = canonicalUrl('http://example.com/post?a=1&b=2');
    expect(a).toBe(b);
  });

  it('keeps real query parameters distinct', () => {
    expect(canonicalUrl('https://x.example/?id=1')).not.toBe(canonicalUrl('https://x.example/?id=2'));
  });
});

describe('matchScore', () => {
  it('weights the title over the description and ignores stop words', () => {
    const q = terms('the bun runtime');
    expect(q).toEqual(['bun', 'runtime']);
    expect(matchScore(q, 'Bun runtime', '')).toBeGreaterThan(matchScore(q, '', 'bun runtime'));
    expect(matchScore(q, 'Bun runtime', 'bun runtime')).toBe(1);
  });
});

describe('rank', () => {
  it('puts what every provider agrees on above any single top hit', () => {
    const results = [
      ok('ceramic', [hit('https://solo.example/a', 'bun'), hit('https://shared.example/', 'bun')]),
      ok('exa', [hit('https://other.example/', 'bun'), hit('https://www.shared.example', 'bun')]),
      ok('linkup', [hit('https://third.example/', 'bun'), hit('http://shared.example/', 'bun')]),
    ];
    const ranked = rank('bun', results);
    expect(canonicalUrl(ranked[0]!.url)).toBe('shared.example');
    expect(ranked[0]!.seenBy).toEqual({ ceramic: 2, exa: 2, linkup: 2 });
    expect(ranked[0]!.breakdown.consensus).toBe(3);
    // Merged, not repeated.
    expect(ranked.filter((r) => canonicalUrl(r.url) === 'shared.example')).toHaveLength(1);
  });

  it('damps a host that already has a result', () => {
    const results = [
      ok('ceramic', [hit('https://big.example/1', 'q'), hit('https://big.example/2', 'q'), hit('https://small.example/', 'q')]),
    ];
    const ranked = rank('q', results);
    const second = ranked.find((r) => r.url.endsWith('/2'))!;
    expect(second.breakdown.diversity).toBeLessThan(1);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('ranks with the providers that answered when one fails', () => {
    const results: ProviderResult[] = [
      ok('ceramic', [hit('https://a.example/', 'a')]),
      { provider: 'exa', hits: [], latencyMs: null, error: 'boom' },
    ];
    const ranked = rank('a', results);
    expect(ranked).toHaveLength(1);
    // Normalised against the providers that answered: rank 1 there is 1.0.
    expect(ranked[0]!.breakdown.fusion).toBeCloseTo(1);
  });

  it('prefers the page that matches the query at equal positions', () => {
    const results = [
      ok('ceramic', [hit('https://off.example/', 'Cooking tips')]),
      ok('exa', [hit('https://on.example/', 'Bun performance benchmarks')]),
    ];
    expect(rank('bun performance', results)[0]!.url).toBe('https://on.example/');
  });
});

describe('searchAll', () => {
  const token: Auth = { kind: 'token', token: 't' };
  const global: Auth = { kind: 'global', email: 'e', key: 'k' };

  it('falls through to the next credential on an auth failure, and stays there', async () => {
    const seen: string[] = [];
    const caller: Caller = async (request, auth) => {
      seen.push(`${request.provider}:${auth.kind}`);
      if (auth.kind === 'token') throw new SearchError('Authentication error', 400, true);
      return { hits: [hit(`https://${request.provider}.example/`)], latencyMs: 1 };
    };
    const results = await searchAll('q', ['ceramic', 'exa', 'linkup'], caller, [token, global]);
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(seen.filter((s) => s.endsWith(':global'))).toHaveLength(3);
  });

  it('reports a failing provider without failing the others', async () => {
    const caller: Caller = async (request) => {
      if (request.provider === 'exa') throw new SearchError('no credits', 402);
      return { hits: [hit('https://a.example/')], latencyMs: 1 };
    };
    const results = await searchAll('q', ['ceramic', 'exa'], caller, [token]);
    expect(results.find((r) => r.provider === 'exa')!.error).toBe('no credits');
    expect(results.find((r) => r.provider === 'ceramic')!.hits).toHaveLength(1);
    expect(costOf(results)).toBeCloseTo(0.00025);
  });
});

describe('formatResults', () => {
  it('shows which providers found each result', () => {
    const text = formatResults(rank('a', [ok('ceramic', [hit('https://a.example/', 'A', 'about a')]), ok('linkup', [hit('https://a.example', 'A')])]));
    expect(text).toContain(' 1. A');
    expect(text).toContain('[C·L]');
    expect(text).toContain('about a');
  });
});
