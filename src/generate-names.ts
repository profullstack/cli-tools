/**
 * Turn a sentence describing a product into a long list of candidate names.
 *
 * The model is asked for *vocabulary*, not for a thousand names. Asking any
 * model to emit 1,000 names directly goes repetitive within a few hundred,
 * costs far more, and drifts off-brief; asking for ~40 head words and ~40
 * modifiers and expanding the cross product in code is one cheap call, has no
 * duplicates by construction, and stays on theme.
 *
 * Output is bare names, one per line, so it pipes into `domainfree`.
 */

export const DEFAULT_COUNT = 1000;
export const DEFAULT_TLD = 'com';

/** Cheap-tier default per provider. Overridable with --model. */
export const DEFAULT_MODELS = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
} as const;

export type Provider = keyof typeof DEFAULT_MODELS;

export interface Vocabulary {
  /** Nouns naming the thing itself: check, registry, proof, graph… */
  heads: string[];
  /** Words that pair in front of or behind a head: no, zero, lint, scan… */
  modifiers: string[];
  /** A handful the model liked enough to write out whole. */
  exemplars: string[];
}

/**
 * Pick a provider from the environment. Explicit choice wins; otherwise
 * whichever key is actually present, preferring OpenAI when both are.
 */
export function resolveProvider(
  env: Record<string, string | undefined>,
  requested?: string,
): Provider {
  if (requested) {
    if (requested !== 'openai' && requested !== 'anthropic') {
      throw new Error(`unknown provider: ${requested} (expected openai or anthropic)`);
    }
    const key = requested === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!env[key]) throw new Error(`${requested} requested but ${key} is not set`);
    return requested;
  }
  if (env['OPENAI_API_KEY']) return 'openai';
  if (env['ANTHROPIC_API_KEY']) return 'anthropic';
  throw new Error(
    'no API key — run `cli-tools config set openai` (or anthropic), ' +
      'or export OPENAI_API_KEY / ANTHROPIC_API_KEY',
  );
}

export function buildPrompt(description: string, words: 1 | 2): string {
  const shape =
    words === 2
      ? 'Two short English words joined without a space, like "sorrycheck" or "graphtrap".'
      : 'One short English word, or a tight blend of two, like "proofdex".';

  return `You are naming a software product. Here is what it does:

${description}

Return JSON only, no prose, matching exactly:

{"heads": [...], "modifiers": [...], "exemplars": [...]}

- "heads": 40 short, concrete English nouns naming the thing or what it acts on.
- "modifiers": 40 short English words that read naturally next to a head — verbs,
  qualities, negations, or actions. No articles, no prepositions.
- "exemplars": 10 complete names you would actually pick.

Rules:
- ${shape}
- Real English words only. No invented words, no misspellings, no numbers, no hyphens.
- All lowercase, 2-9 letters each.
- Prefer words a practitioner in this field would recognise over generic startup vocabulary.
- Avoid: hub, lab, ify, ly, sync, flow, stack, cloud, ai.`;
}

/** Both providers speak plain HTTP; this repo has no runtime dependencies. */
export type Caller = (body: string) => Promise<string>;

export function openaiCaller(apiKey: string, model: string, timeoutMs: number): Caller {
  return async (prompt) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        }),
      });
      if (!response.ok) throw new Error(`openai ${response.status}: ${await response.text()}`);
      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  };
}

export function anthropicCaller(apiKey: string, model: string, timeoutMs: number): Caller {
  return async (prompt) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) throw new Error(`anthropic ${response.status}: ${await response.text()}`);
      const data = (await response.json()) as { content?: { type: string; text?: string }[] };
      return data.content?.find((b) => b.type === 'text')?.text ?? '';
    } finally {
      clearTimeout(timer);
    }
  };
}

// 2 letters minimum: "no", "up", "on" are among the most useful
// modifiers in this space (nosorry, noexit) and a 3-letter floor loses them.
const WORD = /^[a-z]{2,9}$/;

/** Models wrap JSON in prose or fences often enough to be worth handling. */
export function parseVocabulary(raw: string): Vocabulary {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1]! : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('model returned no JSON object');

  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Vocabulary>;
  const clean = (list: unknown): string[] =>
    Array.isArray(list)
      ? [...new Set(list.map((w) => String(w).toLowerCase().trim()).filter((w) => WORD.test(w)))]
      : [];

  const vocab = {
    heads: clean(parsed.heads),
    modifiers: clean(parsed.modifiers),
    exemplars: clean(parsed.exemplars),
  };
  if (vocab.heads.length === 0) throw new Error('model returned no usable head words');
  return vocab;
}

/** Deterministic PRNG so a given seed reproduces a given list. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ExpandOptions {
  count?: number;
  tld?: string;
  seed?: number;
  maxLength?: number;
}

/**
 * Expand vocabulary into candidate domains. Exemplars lead, then the shuffled
 * cross product in both orders — shuffled so a truncated list is still varied
 * rather than every name starting with the same word.
 */
export function expand(vocab: Vocabulary, options: ExpandOptions = {}): string[] {
  const { count = DEFAULT_COUNT, tld = DEFAULT_TLD, seed = 1, maxLength = 14 } = options;
  const suffix = `.${tld.replace(/^\./, '').toLowerCase()}`;

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (base: string): void => {
    if (base.length > maxLength || seen.has(base)) return;
    seen.add(base);
    out.push(base + suffix);
  };

  for (const name of vocab.exemplars) push(name);

  const pairs: string[] = [];
  for (const head of vocab.heads) {
    for (const modifier of vocab.modifiers) {
      if (head === modifier) continue;
      pairs.push(modifier + head);
      pairs.push(head + modifier);
    }
  }

  const random = mulberry32(seed);
  for (let i = pairs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!];
  }

  for (const pair of pairs) {
    if (out.length >= count) break;
    push(pair);
  }

  return out.slice(0, count);
}

export async function generateNames(
  description: string,
  call: Caller,
  options: ExpandOptions & { words?: 1 | 2 } = {},
): Promise<string[]> {
  const raw = await call(buildPrompt(description, options.words ?? 2));
  return expand(parseVocabulary(raw), options);
}
