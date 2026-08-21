/**
 * Ask a question and get an answer with the sources it came from.
 *
 * This is the one thing a local model cannot do and a search engine will not:
 * read the live web and answer in a paragraph, with the pages it used attached.
 * Perplexity's API is the whole implementation — there is no scraping here and
 * no ranking of our own.
 *
 * The sources are the point, not a footnote. An answer whose `[1]` resolves to
 * nothing is indistinguishable from an answer that was made up, so the marker
 * numbers the model writes inline and the list printed underneath are the same
 * numbering, and a citation the model referenced but the API did not return is
 * reported rather than silently dropped.
 */

/**
 * `sonar` is the cheap grounded default and answers in a second or two.
 * `sonar-pro` searches wider for the same question; the reasoning models think
 * first and are worth it only for a question with steps in it.
 */
export const DEFAULT_MODEL = 'sonar';

export const MODELS = [
  'sonar',
  'sonar-pro',
  'sonar-reasoning',
  'sonar-reasoning-pro',
  'sonar-deep-research',
] as const;

export type Model = (typeof MODELS)[number];

/** How far back the search may look. The API accepts only these four. */
export const RECENCY = ['day', 'week', 'month', 'year'] as const;

export type Recency = (typeof RECENCY)[number];

export interface Source {
  /** 1-based, matching the `[n]` markers in the answer text. */
  index: number;
  url: string;
  title: string | null;
  /** Publication date when the API knows one; often null. */
  date: string | null;
}

export interface Answer {
  text: string;
  sources: Source[];
  model: string;
  /** Markers the answer cites that no source backs — see {@link parseAnswer}. */
  danglingCitations: number[];
}

export interface AskOptions {
  model?: string;
  recency?: Recency;
  /** Restrict the search to these hosts. */
  domains?: readonly string[];
  maxTokens?: number;
}

/**
 * The request body.
 *
 * Kept separate from the HTTP call so the shape can be asserted in a test
 * without a network round trip — the filters are the part worth pinning, since
 * sending `search_domain_filter: []` is not the same as omitting it: an empty
 * array is a filter matching nothing, and the API answers from no sources at
 * all rather than from the whole web.
 */
export function buildBody(question: string, options: AskOptions = {}): string {
  const body: Record<string, unknown> = {
    model: options.model ?? DEFAULT_MODEL,
    messages: [{ role: 'user', content: question }],
  };

  if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;
  if (options.recency) body['search_recency_filter'] = options.recency;
  if (options.domains && options.domains.length > 0) {
    body['search_domain_filter'] = [...options.domains];
  }

  return JSON.stringify(body);
}

/** The API speaks plain HTTP; this repo has no runtime dependencies. */
export type Caller = (body: string) => Promise<string>;

export function perplexityCaller(apiKey: string, timeoutMs: number): Caller {
  return async (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`perplexity ${response.status}: ${describeError(text)}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Pull the useful sentence out of an error body.
 *
 * A 401 here arrives as a JSON envelope whose `message` says the key is bad,
 * wrapped in enough punctuation that pasting the raw body into a terminal
 * buries it. Anything unrecognised is passed through untouched rather than
 * summarised away.
 */
export function describeError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string } | string;
      detail?: unknown;
    };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    // Not JSON — an HTML error page from a proxy, most likely.
  }
  return body.trim().slice(0, 400);
}

interface RawResponse {
  choices?: { message?: { content?: string } }[];
  citations?: string[];
  search_results?: { title?: string; url?: string; date?: string | null }[];
  model?: string;
}

/**
 * Turn the response into an answer and a numbered source list.
 *
 * Two fields carry the sources and they are not redundant: `citations` is a
 * bare URL list whose position *is* the `[n]` the model wrote, while
 * `search_results` carries the titles and dates but is not guaranteed to be in
 * that order. So the numbering comes from `citations`, and `search_results` is
 * joined onto it by URL purely to put a title on the line. When only
 * `search_results` comes back, its own order is the numbering — that is the
 * best available guess and it is at least stable.
 */
export function parseAnswer(raw: string): Answer {
  let parsed: RawResponse;
  try {
    parsed = JSON.parse(raw) as RawResponse;
  } catch (error) {
    throw new Error(`perplexity returned non-JSON — ${(error as Error).message}`);
  }

  const text = (parsed.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('perplexity returned an empty answer');

  const details = new Map<string, { title: string | null; date: string | null }>();
  for (const result of parsed.search_results ?? []) {
    if (!result.url) continue;
    details.set(result.url, { title: result.title?.trim() || null, date: result.date ?? null });
  }

  const urls =
    parsed.citations && parsed.citations.length > 0
      ? parsed.citations
      : (parsed.search_results ?? []).map((result) => result.url ?? '').filter(Boolean);

  const sources: Source[] = urls.map((url, position) => ({
    index: position + 1,
    url,
    title: details.get(url)?.title ?? null,
    date: details.get(url)?.date ?? null,
  }));

  return {
    text,
    sources,
    model: parsed.model ?? DEFAULT_MODEL,
    danglingCitations: danglingCitations(text, sources.length),
  };
}

/**
 * Markers in the text with no source behind them.
 *
 * Worth surfacing rather than ignoring: `[7]` in a paragraph backed by four
 * sources is the visible edge of an answer that has drifted from what was
 * actually retrieved, and it is the one signal available without re-reading
 * every page.
 */
export function danglingCitations(text: string, sourceCount: number): number[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(match[1]);
    if (n > sourceCount || n === 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export interface FormatOptions {
  /** Leave the source list off — for piping the prose somewhere else. */
  bare?: boolean;
}

/**
 * Render for a terminal.
 *
 * The answer goes to stdout and nothing else does, so `ask-web … | pbcopy`
 * gets prose rather than prose plus a banner. The source list is part of the
 * answer, not chrome, so it stays on stdout too; `--bare` is how you ask for
 * only the paragraph.
 */
export function formatAnswer(answer: Answer, options: FormatOptions = {}): string {
  if (options.bare || answer.sources.length === 0) return `${answer.text}\n`;

  const lines = [answer.text, '', 'Sources:'];
  for (const source of answer.sources) {
    const label = source.title ? `${source.title} — ` : '';
    const when = source.date ? ` (${source.date})` : '';
    lines.push(`  [${source.index}] ${label}${source.url}${when}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function askWeb(
  question: string,
  call: Caller,
  options: AskOptions = {},
): Promise<Answer> {
  return parseAnswer(await call(buildBody(question, options)));
}
