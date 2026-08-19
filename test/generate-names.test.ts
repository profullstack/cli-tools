import { describe, expect, it } from 'vitest';
import {
  type Vocabulary,
  buildPrompt,
  expand,
  generateNames,
  parseVocabulary,
  resolveProvider,
} from '../src/generate-names.ts';

describe('resolveProvider', () => {
  it('prefers OpenAI when both keys are set', () => {
    expect(resolveProvider({ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' })).toBe('openai');
  });

  it('falls back to whichever key exists', () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'y' })).toBe('anthropic');
    expect(resolveProvider({ OPENAI_API_KEY: 'x' })).toBe('openai');
  });

  it('honours an explicit choice', () => {
    expect(resolveProvider({ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }, 'anthropic')).toBe(
      'anthropic',
    );
  });

  it('refuses a provider whose key is missing, rather than silently switching', () => {
    expect(() => resolveProvider({ OPENAI_API_KEY: 'x' }, 'anthropic')).toThrow(
      /ANTHROPIC_API_KEY is not set/,
    );
  });

  it('rejects an unknown provider and says what is valid', () => {
    expect(() => resolveProvider({ OPENAI_API_KEY: 'x' }, 'gemini')).toThrow(/expected openai or anthropic/);
  });

  it('explains what to set when there is no key at all', () => {
    expect(() => resolveProvider({})).toThrow(/OPENAI_API_KEY or ANTHROPIC_API_KEY/);
  });
});

describe('buildPrompt', () => {
  it('carries the description and asks for JSON only', () => {
    const prompt = buildPrompt('a tool that finds dead states in agent graphs', 2);
    expect(prompt).toContain('dead states in agent graphs');
    expect(prompt).toContain('Return JSON only');
    expect(prompt).toContain('Two short English words');
  });

  it('switches shape for one-word names', () => {
    expect(buildPrompt('x'.repeat(20), 1)).toContain('One short English word');
  });
});

describe('parseVocabulary', () => {
  const good = '{"heads":["check","proof"],"modifiers":["no","zero"],"exemplars":["nocheck"]}';

  it('parses a bare object', () => {
    expect(parseVocabulary(good).heads).toEqual(['check', 'proof']);
  });

  it('parses through a code fence, which models add unprompted', () => {
    expect(parseVocabulary('```json\n' + good + '\n```').modifiers).toEqual(['no', 'zero']);
  });

  it('parses through surrounding prose', () => {
    expect(parseVocabulary(`Sure! Here you go:\n${good}\nHope that helps.`).heads).toHaveLength(2);
  });

  it('drops words that are not usable as name parts', () => {
    const messy = JSON.stringify({
      heads: ['check', 'a', 'waytoolongawordhere', 'CHECK', 'we-b', 'n0de', ''],
      modifiers: ['zero'],
      exemplars: [],
    });
    // "CHECK" lowercases onto "check" and dedupes; the rest fail length or charset.
    expect(parseVocabulary(messy).heads).toEqual(['check']);
  });

  it('throws when there is no JSON at all', () => {
    expect(() => parseVocabulary('I cannot help with that.')).toThrow(/no JSON object/);
  });

  it('throws when nothing usable survives, rather than returning an empty list', () => {
    expect(() => parseVocabulary('{"heads":["a"],"modifiers":[],"exemplars":[]}')).toThrow(
      /no usable head words/,
    );
  });
});

const vocab: Vocabulary = {
  heads: ['check', 'proof', 'graph', 'state'],
  modifiers: ['no', 'zero', 'lint', 'scan'],
  exemplars: ['sorrycheck', 'sinkstate'],
};

describe('expand', () => {
  it('leads with the exemplars', () => {
    const names = expand(vocab, { count: 5 });
    expect(names.slice(0, 2)).toEqual(['sorrycheck.com', 'sinkstate.com']);
  });

  it('appends the requested tld, with or without a leading dot', () => {
    expect(expand(vocab, { count: 1, tld: 'dev' })[0]).toBe('sorrycheck.dev');
    expect(expand(vocab, { count: 1, tld: '.io' })[0]).toBe('sorrycheck.io');
  });

  it('never repeats a name', () => {
    const names = expand(vocab, { count: 500 });
    expect(new Set(names).size).toBe(names.length);
  });

  it('honours count exactly when supply allows', () => {
    expect(expand(vocab, { count: 12 })).toHaveLength(12);
  });

  it('returns what it can when the vocabulary cannot fill the count', () => {
    // 4x4 in both orders, minus collisions, plus 2 exemplars — far short of 1000.
    const names = expand(vocab, { count: 1000 });
    expect(names.length).toBeGreaterThan(10);
    expect(names.length).toBeLessThan(1000);
  });

  it('is deterministic for a seed, and different across seeds', () => {
    expect(expand(vocab, { count: 20, seed: 7 })).toEqual(expand(vocab, { count: 20, seed: 7 }));
    expect(expand(vocab, { count: 20, seed: 7 })).not.toEqual(
      expand(vocab, { count: 20, seed: 8 }),
    );
  });

  it('drops names longer than the cap', () => {
    const long: Vocabulary = { heads: ['characters'], modifiers: ['exceedingly'], exemplars: [] };
    expect(expand(long, { count: 10, maxLength: 14 })).toEqual([]);
  });

  it('scales to 1000 from a realistic 40x40 vocabulary', () => {
    const many: Vocabulary = {
      heads: Array.from({ length: 40 }, (_, i) => `head${i}`.padEnd(6, 'x').slice(0, 6)),
      modifiers: Array.from({ length: 40 }, (_, i) => `mod${i}`.padEnd(5, 'y').slice(0, 5)),
      exemplars: [],
    };
    expect(expand(many, { count: 1000 })).toHaveLength(1000);
  });
});

describe('generateNames', () => {
  it('sends one prompt and expands the reply — one call regardless of count', async () => {
    let calls = 0;
    const call = async (prompt: string) => {
      calls += 1;
      expect(prompt).toContain('a registry for proofs');
      return JSON.stringify(vocab);
    };
    const names = await generateNames('a registry for proofs', call, { count: 10 });
    expect(calls).toBe(1);
    expect(names).toHaveLength(10);
    expect(names.every((n) => n.endsWith('.com'))).toBe(true);
  });
});
