/**
 * One query, three search indexes, one ranking that is ours.
 *
 * Cloudflare's Web Search API fronts three providers behind a single endpoint —
 * Ceramic (its own 40B-page index, cheapest), Exa (neural, query-relevant
 * highlights) and Linkup (raw results, no generated answer). Two more are called
 * directly with our own keys: Perplexity's Search API (its own index) and Serper
 * (Google's results). Each one is good at something different and none of them
 * is right about everything, so this asks every configured one at once and fuses
 * the lists instead of trusting any one ordering.
 *
 * The direct two are not an afterthought: they are what makes this work on an
 * account whose AI Gateway credits never landed, which is exactly what happened
 * the day it shipped (2026-10-06).
 *
 * The ranking is deliberately explainable — every number `--explain` prints is
 * one of the four terms below, not a model's opinion:
 *
 *   fusion     Reciprocal Rank Fusion: Σ 1/(k + rank) over the providers that
 *              returned the page. Rank-only, so it needs no agreement on what a
 *              provider's raw score means (and the API returns none).
 *   consensus  how many providers independently found it. Two indexes agreeing
 *              is the strongest signal available without reading the page.
 *   match      how much of the query is in the title and the description,
 *              title counting double. Catches the provider that ranked a
 *              tangential page first.
 *   diversity  the second result from a host is damped, the third more so, so
 *              one site cannot take the whole first page.
 *
 * A page is the same page across providers when its canonical URL matches —
 * scheme, `www.`, trailing slash, fragment and tracking parameters ignored —
 * since the providers disagree on all of those for the same document.
 */

export const PROVIDERS = ['ceramic', 'exa', 'linkup', 'perplexity', 'serper'] as const;

/** The ones that go through Cloudflare's endpoint; the rest are called directly. */
export const CLOUDFLARE_PROVIDERS = ['ceramic', 'exa', 'linkup'] as const;

export type Provider = (typeof PROVIDERS)[number];

/** The API accepts 1–10 results per provider per request. */
export const MAX_LIMIT = 10;

export const MAX_QUERY = 1024;

export const DEFAULT_GATEWAY = 'default';

/** Price per 1,000 requests, from the providers page, for the stderr cost line. */
export const PRICE_PER_1K: Record<Provider, number> = {
  ceramic: 0.25,
  exa: 7.0,
  linkup: 5.0,
  // Perplexity Search API list price; Serper's pay-as-you-go top tier.
  perplexity: 5.0,
  serper: 1.0,
};

export interface Hit {
  url: string;
  title: string;
  description: string;
}

export interface ProviderResult {
  provider: Provider;
  hits: Hit[];
  latencyMs: number | null;
  /** Set when this provider failed; the others still rank. */
  error: string | null;
}

export interface Breakdown {
  fusion: number;
  consensus: number;
  match: number;
  diversity: number;
}

export interface Ranked {
  rank: number;
  url: string;
  title: string;
  description: string;
  score: number;
  /** Which providers returned it, and at what (1-based) position. */
  seenBy: Partial<Record<Provider, number>>;
  breakdown: Breakdown;
}

export interface RankOptions {
  /** RRF damping constant. 60 is the value from the original paper. */
  k?: number;
  /** Per-provider multiplier on the fusion term; default 1 each. */
  weights?: Partial<Record<Provider, number>>;
}

// --- request ---------------------------------------------------------------

export interface SearchRequest {
  query: string;
  provider: Provider;
  limit: number;
  gateway: string;
}

/** The request body, separate from the call so its shape can be pinned in a test. */
export function buildBody(request: SearchRequest): string {
  return JSON.stringify({
    query: request.query,
    provider: request.provider,
    limit: request.limit,
    options: { gateway: { id: request.gateway } },
  });
}

/** Either auth Cloudflare accepts. A scoped token is preferred when both exist. */
export type Auth =
  | { kind: 'token'; token: string }
  | { kind: 'global'; email: string; key: string };

export function authHeaders(auth: Auth): Record<string, string> {
  return auth.kind === 'token'
    ? { Authorization: `Bearer ${auth.token}` }
    : { 'X-Auth-Email': auth.email, 'X-Auth-Key': auth.key };
}

/**
 * Every auth the environment can offer, best first.
 *
 * Both are kept because a token is only useful with Workers AI Read and AI
 * Gateway Read on it, and an older token minted for DNS work has neither — it
 * authenticates fine everywhere else and fails here with a bare "Authentication
 * error". Falling through to the global key then is what makes the command
 * work on a machine that has both, instead of making someone mint a token.
 */
export function authCandidates(env: Record<string, string | undefined>): Auth[] {
  const out: Auth[] = [];
  const token = env['CLOUDFLARE_API_TOKEN'];
  if (token) out.push({ kind: 'token', token });
  const email = env['CLOUDFLARE_EMAIL'];
  const key = env['CLOUDFLARE_GLOBAL_API_KEY'] ?? env['CLOUDFLARE_API_KEY'];
  if (email && key) out.push({ kind: 'global', email, key });
  return out;
}

// Plain fields, not parameter properties: Node's type stripping, which is how
// bin/ runs, refuses those.
export class SearchError extends Error {
  readonly status: number;
  /** True when another credential might succeed where this one did not. */
  readonly authFailure: boolean;

  constructor(message: string, status: number, authFailure = false) {
    super(message);
    this.status = status;
    this.authFailure = authFailure;
  }
}

/**
 * Turn either error envelope the endpoint uses into one readable line.
 *
 * The v4 API wrapper answers `{ success: false, errors: [...] }`; the gateway
 * behind it answers `{ ok: false, error: { code, status } }`. A 402 with
 * `web_search_payment_required` means the account has no AI Gateway credits —
 * said in words, because the code alone reads like a bug.
 */
export function describeError(status: number, text: string): SearchError {
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON — fall through to the raw text
  }

  const v4 = Array.isArray(parsed?.errors) ? parsed.errors[0] : null;
  if (v4) {
    const auth = v4.code === 10000 || status === 401 || status === 403;
    return new SearchError(`${v4.message ?? 'error'} (code ${v4.code})`, status, auth);
  }

  const gw = parsed?.error;
  if (gw && typeof gw === 'object') {
    const code = String(gw.code ?? 'error');
    const effective = Number(gw.status ?? status);
    if (code === 'web_search_payment_required') {
      return new SearchError(
        'no Cloudflare AI Gateway credits (402) — give each provider its own key instead: `cli-tools config set ceramic` / `exa` / `linkup`',
        effective,
      );
    }
    return new SearchError(`${code} (${effective})`, effective, effective === 401 || effective === 403);
  }

  const snippet = text.trim().slice(0, 200) || `HTTP ${status}`;
  return new SearchError(snippet, status, status === 401 || status === 403);
}

/** Pull hits out of a success body, tolerating the v4 `{ result: … }` wrapper. */
export function parseHits(text: string): { hits: Hit[]; latencyMs: number | null } {
  const parsed: any = JSON.parse(text);
  const body = parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed;
  const items: any[] = Array.isArray(body?.items) ? body.items : [];
  const hits: Hit[] = [];
  for (const item of items) {
    const url = typeof item?.url === 'string' ? item.url.trim() : '';
    if (!url) continue;
    hits.push({
      url,
      title: typeof item.title === 'string' ? item.title.trim() : '',
      description: typeof item.description === 'string' ? item.description.trim() : '',
    });
  }
  const latency = Number(body?.metadata?.latencyMs);
  return { hits, latencyMs: Number.isFinite(latency) ? latency : null };
}

/** A provider called with our own key, outside Cloudflare. */
export type DirectCaller = (query: string, limit: number) => Promise<{ hits: Hit[]; latencyMs: number | null }>;

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.trim().slice(0, 200) || `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? message;
    } catch {
      // keep the raw text
    }
    throw new SearchError(`${message} (${response.status})`, response.status);
  }
  return { body: JSON.parse(text), latencyMs: Date.now() - started };
}

/** Perplexity Search API: `results[]` of { title, url, snippet, date }. */
export function parsePerplexity(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => typeof r?.url === 'string' && r.url)
    .map((r) => ({
      url: r.url.trim(),
      title: typeof r.title === 'string' ? r.title.trim() : '',
      description: typeof r.snippet === 'string' ? r.snippet.trim() : '',
    }));
}

/** Serper (Google): `organic[]` of { title, link, snippet }, already in Google's order. */
export function parseSerper(body: any): Hit[] {
  const organic: any[] = Array.isArray(body?.organic) ? body.organic : [];
  return organic
    .filter((r) => typeof r?.link === 'string' && r.link)
    .map((r) => ({
      url: r.link.trim(),
      title: typeof r.title === 'string' ? r.title.trim() : '',
      description: typeof r.snippet === 'string' ? r.snippet.trim() : '',
    }));
}

/** Ceramic: `result.results[]` of { title, url, description }. */
export function parseCeramic(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.result?.results) ? body.result.results : Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => typeof r?.url === 'string' && r.url)
    .map((r) => ({
      url: r.url.trim(),
      title: typeof r.title === 'string' ? r.title.trim() : '',
      description: typeof r.description === 'string' ? r.description.trim() : '',
    }));
}

/** Exa: `results[]` of { title, url, highlights[] }; the highlights are the snippet. */
export function parseExa(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => typeof r?.url === 'string' && r.url)
    .map((r) => ({
      url: r.url.trim(),
      title: typeof r.title === 'string' ? r.title.trim() : '',
      description: Array.isArray(r.highlights)
        ? r.highlights.filter((h: unknown) => typeof h === 'string').join(' … ').trim()
        : typeof r.text === 'string'
          ? r.text.trim().slice(0, 1000)
          : '',
    }));
}

/** Linkup searchResults: `results[]` of { name, url, content }. */
export function parseLinkup(body: any): Hit[] {
  const results: any[] = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => typeof r?.url === 'string' && r.url)
    .map((r) => ({
      url: r.url.trim(),
      title: typeof r.name === 'string' ? r.name.trim() : '',
      // Linkup returns page content, sometimes the whole page; the ranker only
      // needs enough to match the query against.
      description: typeof r.content === 'string' ? r.content.trim().slice(0, 1000) : '',
    }));
}

export function ceramicCaller(apiKey: string, timeoutMs: number): DirectCaller {
  return async (query, limit) => {
    const { body, latencyMs } = await postJson(
      'https://api.ceramic.ai/search',
      { Authorization: `Bearer ${apiKey}` },
      { query },
      timeoutMs,
    );
    return { hits: parseCeramic(body).slice(0, limit), latencyMs };
  };
}

export function exaCaller(apiKey: string, timeoutMs: number): DirectCaller {
  return async (query, limit) => {
    const { body, latencyMs } = await postJson(
      'https://api.exa.ai/search',
      { 'x-api-key': apiKey },
      { query, type: 'auto', numResults: limit, contents: { highlights: true } },
      timeoutMs,
    );
    return { hits: parseExa(body), latencyMs };
  };
}

export function linkupCaller(apiKey: string, timeoutMs: number): DirectCaller {
  return async (query, limit) => {
    // POST with a JSON body. The docs show a GET with query parameters, but
    // the live API answers that with 404 "Cannot GET /v1/search" (2026-10-06).
    const { body, latencyMs } = await postJson(
      'https://api.linkup.so/v1/search',
      { Authorization: `Bearer ${apiKey}` },
      { q: query, depth: 'fast', outputType: 'searchResults', maxResults: limit },
      timeoutMs,
    );
    return { hits: parseLinkup(body).slice(0, limit), latencyMs };
  };
}

export function perplexitySearchCaller(apiKey: string, timeoutMs: number): DirectCaller {
  return async (query, limit) => {
    const { body, latencyMs } = await postJson(
      'https://api.perplexity.ai/search',
      { Authorization: `Bearer ${apiKey}` },
      { query, max_results: limit },
      timeoutMs,
    );
    return { hits: parsePerplexity(body), latencyMs };
  };
}

export function serperCaller(apiKey: string, timeoutMs: number): DirectCaller {
  return async (query, limit) => {
    const { body, latencyMs } = await postJson(
      'https://google.serper.dev/search',
      { 'X-API-KEY': apiKey },
      { q: query, num: limit },
      timeoutMs,
    );
    return { hits: parseSerper(body).slice(0, limit), latencyMs };
  };
}

/** One provider, one HTTP call. Injected so the fan-out is testable offline. */
export type Caller = (request: SearchRequest, auth: Auth) => Promise<{ hits: Hit[]; latencyMs: number | null }>;

export function cloudflareCaller(accountId: string, timeoutMs: number): Caller {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/websearch/`;
  return async (request, auth) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
      body: buildBody(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    // The gateway can answer 200 with `ok: false`, so the body decides too.
    let failed = !response.ok;
    if (!failed) {
      try {
        const parsed = JSON.parse(text);
        failed = parsed?.ok === false || parsed?.success === false;
      } catch {
        failed = true;
      }
    }
    if (failed) throw describeError(response.status, text);
    return parseHits(text);
  };
}

/**
 * Find the account id from the credential itself, so it never has to be typed.
 * Only when exactly one account is visible — guessing between several would
 * bill the wrong one.
 */
export async function discoverAccountId(auth: Auth, timeoutMs: number): Promise<string> {
  const response = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=5', {
    headers: authHeaders(auth),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw describeError(response.status, text);
  const accounts: any[] = JSON.parse(text)?.result ?? [];
  if (accounts.length === 1 && typeof accounts[0]?.id === 'string') return accounts[0].id;
  if (accounts.length === 0) throw new Error('this credential can see no Cloudflare account');
  throw new Error(
    `this credential sees ${accounts.length} accounts — pick one with --account or CLOUDFLARE_ACCOUNT_ID`,
  );
}

/**
 * Ask every provider at once.
 *
 * A failing provider is reported, not fatal: two indexes still rank. An auth
 * failure moves to the next credential and the move sticks for the rest of the
 * run, so a token without the scope costs one wasted request, not three.
 */
export async function searchAll(
  query: string,
  providers: readonly Provider[],
  caller: Caller,
  auths: readonly Auth[],
  options: { limit?: number; gateway?: string; direct?: Partial<Record<Provider, DirectCaller>> } = {},
): Promise<ProviderResult[]> {
  let authIndex = 0;
  const limit = options.limit ?? MAX_LIMIT;
  const gateway = options.gateway ?? DEFAULT_GATEWAY;

  const one = async (provider: Provider): Promise<ProviderResult> => {
    const direct = options.direct?.[provider];
    if (direct) {
      try {
        const { hits, latencyMs } = await direct(query, limit);
        return { provider, hits, latencyMs, error: null };
      } catch (error) {
        return { provider, hits: [], latencyMs: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!(CLOUDFLARE_PROVIDERS as readonly string[]).includes(provider)) {
      return { provider, hits: [], latencyMs: null, error: `no ${provider} key — run \`cli-tools config set ${provider}\`` };
    }
    if (auths.length === 0) {
      return { provider, hits: [], latencyMs: null, error: 'no Cloudflare credential' };
    }
    const request = { query, provider, limit, gateway };
    for (;;) {
      const tried = authIndex;
      try {
        const { hits, latencyMs } = await caller(request, auths[tried]!);
        return { provider, hits, latencyMs, error: null };
      } catch (error) {
        const auth = error instanceof SearchError && error.authFailure;
        if (auth && tried + 1 < auths.length) {
          // Another provider may already have advanced it; never go backwards.
          authIndex = Math.max(authIndex, tried + 1);
          continue;
        }
        return {
          provider,
          hits: [],
          latencyMs: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  return Promise.all(providers.map(one));
}

// --- ranking ---------------------------------------------------------------

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$|si$)/i;

/** The identity a page has across providers. Falls back to the raw string. */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim().toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = url.pathname.replace(/\/+$/, '') || '';
  return `${host}${url.port ? `:${url.port}` : ''}${path}${query}`;
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const STOP = new Set(
  'a an and are as at be by for from how in is it of on or that the this to vs was what when where which who why with'.split(' '),
);

export function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 1 && !STOP.has(term)),
    ),
  ];
}

/** Share of the query's terms found, title worth twice the description. 0..1. */
export function matchScore(queryTerms: readonly string[], title: string, description: string): number {
  if (queryTerms.length === 0) return 0;
  const t = new Set(terms(title));
  const d = new Set(terms(description));
  let sum = 0;
  for (const term of queryTerms) sum += (t.has(term) ? 2 : 0) + (d.has(term) ? 1 : 0);
  return sum / (queryTerms.length * 3);
}

/**
 * Fuse the provider lists into one.
 *
 * score = fusion × (1 + 0.5·(consensus−1)) × (0.6 + 0.4·match) × diversity
 *
 * Multiplicative on purpose: a page every provider found but that does not
 * mention the query still loses to one that does, and a perfectly matching
 * page from one provider at rank 9 does not outrank a consensus top hit. The
 * fusion term is normalised to the best possible (rank 1 everywhere) so the
 * final score reads 0..~1 regardless of how many providers answered.
 */
export function rank(query: string, results: readonly ProviderResult[], options: RankOptions = {}): Ranked[] {
  const k = options.k ?? 60;
  const queryTerms = terms(query);
  const answered = results.filter((result) => !result.error);
  const best = answered.reduce((sum, result) => sum + (options.weights?.[result.provider] ?? 1) / (k + 1), 0) || 1;

  interface Acc {
    url: string;
    title: string;
    description: string;
    seenBy: Partial<Record<Provider, number>>;
    fusion: number;
  }
  const byUrl = new Map<string, Acc>();

  for (const result of answered) {
    const weight = options.weights?.[result.provider] ?? 1;
    result.hits.forEach((hit, index) => {
      const key = canonicalUrl(hit.url);
      let acc = byUrl.get(key);
      if (!acc) {
        acc = { url: hit.url, title: hit.title, description: hit.description, seenBy: {}, fusion: 0 };
        byUrl.set(key, acc);
      }
      // A provider listing the same page twice counts once, at its best rank.
      if (acc.seenBy[result.provider] !== undefined) return;
      acc.seenBy[result.provider] = index + 1;
      acc.fusion += weight / (k + index + 1);
      // Keep the most informative copy of the text.
      if (hit.title.length > acc.title.length) acc.title = hit.title;
      if (hit.description.length > acc.description.length) acc.description = hit.description;
    });
  }

  const scored = [...byUrl.values()].map((acc) => {
    const fusion = acc.fusion / best;
    const consensus = Object.keys(acc.seenBy).length;
    const match = matchScore(queryTerms, acc.title, acc.description);
    const base = fusion * (1 + 0.5 * (consensus - 1)) * (0.6 + 0.4 * match);
    return { acc, fusion, consensus, match, base };
  });
  scored.sort((a, b) => b.base - a.base || a.acc.url.localeCompare(b.acc.url));

  // Diversity is applied in order, so it needs a second sort afterwards.
  const perHost = new Map<string, number>();
  const ranked = scored.map(({ acc, fusion, consensus, match, base }) => {
    const host = hostOf(acc.url);
    const seen = perHost.get(host) ?? 0;
    perHost.set(host, seen + 1);
    const diversity = 0.8 ** seen;
    return {
      rank: 0,
      url: acc.url,
      title: acc.title,
      description: acc.description,
      score: base * diversity,
      seenBy: acc.seenBy,
      breakdown: { fusion, consensus, match, diversity },
    };
  });
  ranked.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  ranked.forEach((item, index) => {
    item.rank = index + 1;
  });
  return ranked;
}

// --- output ----------------------------------------------------------------

const LETTER: Record<Provider, string> = { ceramic: 'C', exa: 'E', linkup: 'L', perplexity: 'P', serper: 'S' };

function badge(seenBy: Partial<Record<Provider, number>>): string {
  return PROVIDERS.map((provider) => (seenBy[provider] ? LETTER[provider] : '·')).join('');
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1).trimEnd()}…`;
}

export function formatResults(
  ranked: readonly Ranked[],
  options: { explain?: boolean; snippet?: number } = {},
): string {
  if (ranked.length === 0) return '';
  const snippet = options.snippet ?? 160;
  const lines: string[] = [];
  for (const item of ranked) {
    lines.push(`${String(item.rank).padStart(2)}. ${item.title || hostOf(item.url) || item.url}`);
    lines.push(`    ${item.url}`);
    const meta = `    [${badge(item.seenBy)}] ${item.score.toFixed(3)}`;
    if (options.explain) {
      const { fusion, consensus, match, diversity } = item.breakdown;
      const at = PROVIDERS.filter((p) => item.seenBy[p])
        .map((p) => `${p}#${item.seenBy[p]}`)
        .join(' ');
      lines.push(
        `${meta}  fusion ${fusion.toFixed(3)} · consensus ${consensus} · match ${match.toFixed(2)} · diversity ${diversity.toFixed(2)} · ${at}`,
      );
    } else {
      lines.push(meta);
    }
    if (snippet > 0 && item.description) lines.push(`    ${clip(item.description, snippet)}`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

export function costOf(results: readonly ProviderResult[]): number {
  // A failed call is not billed by the gateway, so only answers count.
  return results.filter((r) => !r.error).reduce((sum, r) => sum + PRICE_PER_1K[r.provider] / 1000, 0);
}
