/**
 * nim — NVIDIA's hosted NIM inference API (build.nvidia.com), from the terminal.
 *
 * The API is OpenAI-compatible at https://integrate.api.nvidia.com/v1, so this
 * is three calls and the error reporting around them, which is most of the
 * value: NVIDIA's failures are terse ("Authorization failed") and the reasons
 * behind them are not on the response.
 *
 *   403 Authorization failed   the key is real but cannot call the hosted API:
 *                              the build.nvidia.com account is not verified
 *                              ("API Access Unavailable"), or the key was made
 *                              without the "Public API Endpoints" service. An
 *                              NGC catalog key does exactly this.
 *   410 Gone                   the model reached end of life; `detail` says when.
 *
 * Key, first found: NVIDIA_API_KEY, NVIDIA_NIM_API_KEY, NGC_API_KEY. The first
 * and last also come from `cli-tools config` / `config pull`. Never printed.
 *
 *   NIM_MODEL      the default chat model
 *   NIM_BASE_URL   another OpenAI-compatible endpoint (a self-hosted NIM)
 */

import { UsageError, parseArgs } from './args.ts';

export const NIM_API = 'https://integrate.api.nvidia.com/v1';

/**
 * A current general chat model that /v1/models lists. Llama 3.1 8B and 3.3 70B
 * were the usual defaults and answer 410 since their 2026-08-26 end of life.
 */
export const DEFAULT_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_MAX_TOKENS = 1024;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NIM_BASE_URL || NIM_API).replace(/\/+$/, '');
}

export function defaultModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.NIM_MODEL || DEFAULT_MODEL;
}

export interface KeyFound {
  key: string;
  variable: string;
}

/**
 * The key to send, and which variable it came from.
 *
 * `creds` is resolveCredentials(): the stored keys with the environment on top,
 * so NVIDIA_API_KEY and NGC_API_KEY there already honour both sources.
 */
export function resolveKey(
  env: NodeJS.ProcessEnv,
  creds: Record<string, string | undefined>,
): KeyFound | null {
  const order: [string, string | undefined][] = [
    ['NVIDIA_API_KEY', creds.NVIDIA_API_KEY ?? env.NVIDIA_API_KEY],
    ['NVIDIA_NIM_API_KEY', env.NVIDIA_NIM_API_KEY],
    ['NGC_API_KEY', creds.NGC_API_KEY ?? env.NGC_API_KEY],
  ];
  for (const [variable, value] of order) {
    if (value && value.trim()) return { key: value.trim(), variable };
  }
  return null;
}

export const MISSING_KEY =
  'nim: no key. Set NVIDIA_API_KEY (a build.nvidia.com key), or store one:\n' +
  '  cli-tools config set nvidia     # or: cli-tools config pull';

export type NimCommand =
  | { command: 'help' }
  | { command: 'models'; json: boolean; filter: string | null }
  | { command: 'chat'; json: boolean; model: string | null; maxTokens: number; prompt: string }
  | { command: 'key'; json: boolean; model: string | null };

/** Parse argv. The chat prompt may be empty here; the bin fills it from stdin. */
export function parseNimArgs(argv: readonly string[]): NimCommand {
  const { flags, values, positional } = parseArgs(argv, {
    boolean: ['-h', '--help', '--json'],
    string: ['--model', '-m', '--max-tokens'],
  });
  if (flags.has('-h') || flags.has('--help') || positional.length === 0) return { command: 'help' };

  const [verb, ...rest] = positional;
  const json = flags.has('--json');
  const model = values.get('--model') ?? values.get('-m') ?? null;

  if (verb === 'models') return { command: 'models', json, filter: rest.join(' ').trim() || null };
  if (verb === 'key') return { command: 'key', json, model };
  if (verb === 'chat') {
    let maxTokens = DEFAULT_MAX_TOKENS;
    const raw = values.get('--max-tokens');
    if (raw !== undefined) {
      maxTokens = Number(raw);
      if (!Number.isInteger(maxTokens) || maxTokens < 1) {
        throw new UsageError(`--max-tokens must be a positive integer, got "${raw}"`);
      }
    }
    return { command: 'chat', json, model, maxTokens, prompt: rest.join(' ').trim() };
  }
  throw new UsageError(`unknown command: ${verb} (expected models, chat or key)`);
}

/** A failed API call, with the reason already phrased for a person. */
export class NimError extends Error {
  // Assigned by hand: node's type stripping cannot run parameter properties.
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string, message: string) {
    super(message);
    this.name = 'NimError';
    this.status = status;
    this.detail = detail;
  }
}

/** The useful sentence out of an error body: JSON detail/title/message, or the text. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = parsed.error as Record<string, unknown> | string | undefined;
    const pick =
      parsed.detail ??
      (typeof nested === 'object' && nested ? nested.message : nested) ??
      parsed.message ??
      parsed.title;
    if (typeof pick === 'string' && pick.trim()) return pick.trim();
  } catch {
    // Not JSON; NVIDIA's 401 is plain text.
  }
  return body.trim().slice(0, 500);
}

export const FORBIDDEN_EXPLANATION =
  "403 Authorization failed: the key does not include the hosted API (build.nvidia.com account not verified, or key generated without 'Public API Endpoints')";

/** Turn a status and its detail into what to print. */
export function explain(status: number, detail: string): string {
  if (status === 403) return FORBIDDEN_EXPLANATION + (detail && detail !== 'Authorization failed' ? ` [${detail}]` : '');
  if (status === 410) return `410 Gone: ${detail || 'this model is no longer served'}\n  nim models   # pick a current one`;
  if (status === 401) return `401 Unauthorized: ${detail || 'the key was missing or rejected'}`;
  if (status === 404) return `404 Not Found: ${detail || 'no such model'}\n  nim models   # the ids it serves`;
  if (status === 429) return `429 Too Many Requests: ${detail || 'rate limited'}`;
  return `${status}: ${detail || 'request failed'}`;
}

async function failure(res: Response): Promise<NimError> {
  const detail = errorDetail(await res.text().catch(() => ''));
  return new NimError(res.status, detail, explain(res.status, detail));
}

/** GET /models. Needs no key. Sorted ids, optionally filtered by substring. */
export async function listModels(
  { fetchImpl = fetch as Fetch, base = NIM_API, filter = null as string | null } = {},
): Promise<string[]> {
  const res = await fetchImpl(`${base}/models`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { data?: { id?: string }[] };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  const needle = filter?.toLowerCase();
  return ids.filter((id) => !needle || id.toLowerCase().includes(needle)).sort();
}

export interface ChatOptions {
  key: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  fetchImpl?: Fetch;
  base?: string;
}

export interface ChatResult {
  text: string;
  finishReason: string | null;
  raw: unknown;
}

/** POST /chat/completions with one user message. */
export async function chat(options: ChatOptions): Promise<ChatResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as Fetch);
  const res = await fetchImpl(`${options.base ?? NIM_API}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: false,
    }),
  });
  if (!res.ok) throw await failure(res);
  const raw = (await res.json()) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  };
  const choice = raw.choices?.[0];
  return { text: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? null, raw };
}

export type KeyCheck =
  | { ok: true; model: string; variable: string }
  | { ok: false; status: number | null; variable: string | null; message: string };

/**
 * Is this key good for the hosted API? One chat call, one token.
 *
 * The models list cannot answer this: it is public, and a key that lists fine
 * can still be refused every completion.
 */
export async function checkKey(
  found: KeyFound | null,
  { model = DEFAULT_MODEL, fetchImpl = fetch as Fetch, base = NIM_API } = {},
): Promise<KeyCheck> {
  if (!found) return { ok: false, status: null, variable: null, message: MISSING_KEY };
  try {
    await chat({ key: found.key, model, prompt: 'ping', maxTokens: 1, fetchImpl, base });
    return { ok: true, model, variable: found.variable };
  } catch (error) {
    if (error instanceof NimError) {
      return { ok: false, status: error.status, variable: found.variable, message: error.message };
    }
    return { ok: false, status: null, variable: found.variable, message: (error as Error).message };
  }
}
