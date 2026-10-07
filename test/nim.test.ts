import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/args.ts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  FORBIDDEN_EXPLANATION,
  NimError,
  baseUrl,
  chat,
  checkKey,
  defaultModel,
  errorDetail,
  explain,
  listModels,
  parseNimArgs,
  resolveKey,
  type Fetch,
} from '../src/nim.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Bodies exactly as integrate.api.nvidia.com sent them on 2026-10-07. */
const FORBIDDEN = { status: 403, title: 'Forbidden', detail: 'Authorization failed' };
const GONE = {
  type: 'about:blank',
  title: 'Gone',
  status: 410,
  detail:
    "The model 'meta/llama-3.1-8b-instruct' has reached its end of life on 2026-08-26T09:00:00Z and is no longer available.",
};

describe('parseNimArgs', () => {
  it('is help with no verb', () => {
    expect(parseNimArgs([])).toEqual({ command: 'help' });
    expect(parseNimArgs(['chat', '-h'])).toEqual({ command: 'help' });
  });

  it('reads models with a filter', () => {
    expect(parseNimArgs(['models', '--json', 'nemotron'])).toEqual({
      command: 'models',
      json: true,
      filter: 'nemotron',
    });
  });

  it('reads chat with a model, a cap and a multi-word prompt', () => {
    expect(parseNimArgs(['chat', '-m', 'x/y', '--max-tokens=50', 'hello', 'there'])).toEqual({
      command: 'chat',
      json: false,
      model: 'x/y',
      maxTokens: 50,
      prompt: 'hello there',
    });
  });

  it('leaves the prompt empty for stdin, with the default cap', () => {
    const parsed = parseNimArgs(['chat']);
    expect(parsed).toMatchObject({ command: 'chat', prompt: '', maxTokens: DEFAULT_MAX_TOKENS, model: null });
  });

  it('rejects a bad cap and an unknown verb', () => {
    expect(() => parseNimArgs(['chat', '--max-tokens', '0', 'x'])).toThrow(UsageError);
    expect(() => parseNimArgs(['frobnicate'])).toThrow(/unknown command/);
  });
});

describe('defaults', () => {
  it('is a model that is still served, overridable', () => {
    expect(DEFAULT_MODEL).not.toMatch(/llama-3\.(1-8b|3-70b)/);
    expect(defaultModel({})).toBe(DEFAULT_MODEL);
    expect(defaultModel({ NIM_MODEL: 'a/b' })).toBe('a/b');
    expect(baseUrl({})).toBe('https://integrate.api.nvidia.com/v1');
    expect(baseUrl({ NIM_BASE_URL: 'http://gpu:8000/v1/' })).toBe('http://gpu:8000/v1');
  });
});

describe('resolveKey', () => {
  it('prefers NVIDIA_API_KEY, then the alias, then the NGC key', () => {
    expect(resolveKey({}, { NVIDIA_API_KEY: 'a', NGC_API_KEY: 'c' })).toEqual({ key: 'a', variable: 'NVIDIA_API_KEY' });
    expect(resolveKey({ NVIDIA_NIM_API_KEY: 'b' }, { NGC_API_KEY: 'c' })).toEqual({
      key: 'b',
      variable: 'NVIDIA_NIM_API_KEY',
    });
    expect(resolveKey({}, { NGC_API_KEY: 'c' })).toEqual({ key: 'c', variable: 'NGC_API_KEY' });
    expect(resolveKey({}, {})).toBeNull();
  });
});

describe('errorDetail and explain', () => {
  it('pulls detail out of a problem+json body, and copes with plain text', () => {
    expect(errorDetail(JSON.stringify(GONE))).toBe(GONE.detail);
    expect(errorDetail(JSON.stringify({ error: { message: 'bad model' } }))).toBe('bad model');
    expect(errorDetail('Header of type `authorization` was missing')).toBe(
      'Header of type `authorization` was missing',
    );
  });

  it('says what a 403 actually means', () => {
    expect(explain(403, 'Authorization failed')).toBe(FORBIDDEN_EXPLANATION);
    expect(FORBIDDEN_EXPLANATION).toMatch(/Public API Endpoints/);
  });

  it('surfaces the end-of-life detail of a 410', () => {
    expect(explain(410, GONE.detail)).toMatch(/^410 Gone: The model 'meta\/llama-3\.1-8b-instruct' has reached its end of life on 2026-08-26/);
  });
});

describe('listModels', () => {
  it('lists sorted ids without a key, filtered', async () => {
    let auth: string | null = 'unset';
    const fetchImpl: Fetch = async (_url, init) => {
      auth = new Headers(init?.headers).get('authorization');
      return json({ data: [{ id: 'openai/gpt-oss-20b' }, { id: 'nvidia/nemotron-4-340b-instruct' }, { id: 'a/b' }] });
    };
    expect(await listModels({ fetchImpl })).toEqual(['a/b', 'nvidia/nemotron-4-340b-instruct', 'openai/gpt-oss-20b']);
    expect(auth).toBeNull();
    expect(await listModels({ fetchImpl, filter: 'NEMOTRON' })).toEqual(['nvidia/nemotron-4-340b-instruct']);
  });
});

describe('chat', () => {
  it('posts one user message with a bearer key and returns the reply', async () => {
    let seen: { url: string; auth: string | null; body: Record<string, unknown> } | null = null;
    const fetchImpl: Fetch = async (url, init) => {
      seen = {
        url,
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      };
      return json({ choices: [{ message: { content: 'hi!' }, finish_reason: 'stop' }] });
    };
    const reply = await chat({ key: 'k', model: 'm/x', prompt: 'hello', maxTokens: 7, fetchImpl });
    expect(reply.text).toBe('hi!');
    expect(seen!.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(seen!.auth).toBe('Bearer k');
    expect(seen!.body).toMatchObject({ model: 'm/x', max_tokens: 7, messages: [{ role: 'user', content: 'hello' }] });
  });

  it('throws the 410 detail', async () => {
    const fetchImpl: Fetch = async () => json(GONE, 410);
    const error = await chat({ key: 'k', model: 'meta/llama-3.1-8b-instruct', prompt: 'x', fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(NimError);
    expect(error.status).toBe(410);
    expect(error.message).toContain('end of life on 2026-08-26');
  });
});

describe('checkKey', () => {
  const found = { key: 'nvapi-secret', variable: 'NGC_API_KEY' };

  it('reports ok on a 200', async () => {
    let maxTokens: unknown;
    const fetchImpl: Fetch = async (_url, init) => {
      maxTokens = JSON.parse(String(init?.body)).max_tokens;
      return json({ choices: [{ message: { content: 'p' }, finish_reason: 'length' }] });
    };
    expect(await checkKey(found, { fetchImpl })).toEqual({ ok: true, model: DEFAULT_MODEL, variable: 'NGC_API_KEY' });
    expect(maxTokens).toBe(1);
  });

  it('explains a 403 and never echoes the key', async () => {
    const result = await checkKey(found, { fetchImpl: async () => json(FORBIDDEN, 403) });
    expect(result).toMatchObject({ ok: false, status: 403, variable: 'NGC_API_KEY', message: FORBIDDEN_EXPLANATION });
    expect(JSON.stringify(result)).not.toContain('nvapi-secret');
  });

  it('passes a 410 through', async () => {
    const result = await checkKey(found, { model: 'meta/llama-3.3-70b-instruct', fetchImpl: async () => json(GONE, 410) });
    expect(result).toMatchObject({ ok: false, status: 410 });
  });

  it('says how to set a key when there is none', async () => {
    const result = await checkKey(null, { fetchImpl: async () => json({}) });
    expect(result).toMatchObject({ ok: false, status: null });
    expect(!result.ok && result.message).toMatch(/cli-tools config set nvidia/);
  });
});
