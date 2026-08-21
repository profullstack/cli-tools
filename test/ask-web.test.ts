import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODEL,
  askWeb,
  buildBody,
  danglingCitations,
  describeError,
  formatAnswer,
  parseAnswer,
  perplexityCaller,
} from '../src/ask-web.ts';

describe('buildBody', () => {
  it('sends the question and the default model', () => {
    const body = JSON.parse(buildBody('why is the sky blue'));
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.messages).toEqual([{ role: 'user', content: 'why is the sky blue' }]);
  });

  // An empty search_domain_filter is a filter matching nothing, not an absent
  // one: sending it answers the question from no sources at all.
  it('omits the domain filter rather than sending an empty one', () => {
    expect(JSON.parse(buildBody('q', { domains: [] }))).not.toHaveProperty(
      'search_domain_filter',
    );
    expect(JSON.parse(buildBody('q', { domains: ['nodejs.org'] })).search_domain_filter).toEqual([
      'nodejs.org',
    ]);
  });

  it('passes recency and max tokens through only when asked', () => {
    expect(JSON.parse(buildBody('q'))).not.toHaveProperty('search_recency_filter');
    const body = JSON.parse(buildBody('q', { recency: 'week', maxTokens: 100 }));
    expect(body.search_recency_filter).toBe('week');
    expect(body.max_tokens).toBe(100);
  });
});

describe('parseAnswer', () => {
  const response = {
    model: 'sonar',
    choices: [{ message: { content: 'Paris is the capital [1].' } }],
    citations: ['https://a.example/paris', 'https://b.example/france'],
    search_results: [
      { title: 'France', url: 'https://b.example/france', date: '2020-01-01' },
      { title: 'Paris', url: 'https://a.example/paris', date: null },
    ],
  };

  // citations is positional — its order IS the [n] numbering — while
  // search_results carries the titles in whatever order it likes. Numbering
  // from search_results would mislabel every source in this response.
  it('numbers sources by citations, not by search_results order', () => {
    const answer = parseAnswer(JSON.stringify(response));
    expect(answer.sources.map((source) => source.url)).toEqual([
      'https://a.example/paris',
      'https://b.example/france',
    ]);
    expect(answer.sources[0]).toMatchObject({ index: 1, title: 'Paris' });
    expect(answer.sources[1]).toMatchObject({ index: 2, title: 'France', date: '2020-01-01' });
  });

  it('falls back to search_results when there are no citations', () => {
    const answer = parseAnswer(
      JSON.stringify({ ...response, citations: undefined }),
    );
    expect(answer.sources.map((source) => source.index)).toEqual([1, 2]);
    expect(answer.sources[0]!.url).toBe('https://b.example/france');
  });

  it('rejects an empty answer rather than printing nothing', () => {
    expect(() => parseAnswer(JSON.stringify({ choices: [{ message: { content: '  ' } }] }))).toThrow(
      /empty answer/,
    );
  });

  it('reports non-JSON as such', () => {
    expect(() => parseAnswer('<html>502</html>')).toThrow(/non-JSON/);
  });
});

describe('danglingCitations', () => {
  // A [7] in a paragraph backed by four sources is the visible edge of an
  // answer that has drifted from what was retrieved.
  it('finds markers with no source behind them', () => {
    expect(danglingCitations('a [1] b [7] c [2]', 4)).toEqual([7]);
  });

  it('is quiet when every marker resolves', () => {
    expect(danglingCitations('a [1] b [2]', 2)).toEqual([]);
  });
});

describe('formatAnswer', () => {
  const answer = {
    text: 'Paris [1].',
    model: 'sonar',
    danglingCitations: [],
    sources: [{ index: 1, url: 'https://a.example', title: 'Paris', date: null }],
  };

  it('numbers the printed list to match the inline markers', () => {
    expect(formatAnswer(answer)).toBe('Paris [1].\n\nSources:\n  [1] Paris — https://a.example\n');
  });

  it('prints prose alone under --bare', () => {
    expect(formatAnswer(answer, { bare: true })).toBe('Paris [1].\n');
  });
});

describe('describeError', () => {
  it('pulls the message out of the envelope', () => {
    expect(describeError('{"error":{"message":"invalid api key","type":"auth"}}')).toBe(
      'invalid api key',
    );
  });

  it('passes a non-JSON body through', () => {
    expect(describeError('  Bad Gateway  ')).toBe('Bad Gateway');
  });
});

describe('perplexityCaller', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the status and the message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"bad key"}}',
      })),
    );
    await expect(perplexityCaller('k', 1000)('{}')).rejects.toThrow('perplexity 401: bad key');
  });
});

describe('askWeb', () => {
  it('asks and parses in one step', async () => {
    const call = vi.fn(async (_body: string) =>
      JSON.stringify({
        model: 'sonar',
        choices: [{ message: { content: 'yes [1]' } }],
        citations: ['https://a.example'],
      }),
    );
    const answer = await askWeb('is it', call, { recency: 'day' });
    expect(JSON.parse(call.mock.calls[0]![0]).search_recency_filter).toBe('day');
    expect(answer.text).toBe('yes [1]');
    expect(answer.sources).toHaveLength(1);
  });
});
