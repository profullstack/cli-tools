import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from '../src/args.ts';
import { termsOptions } from '../src/terms.ts';

const spec = {
  boolean: ['--json', '--brief', '--remote', '--fresh'],
  string: ['--as', '--context', '--provider', '--model', '--effort', '--also', '--file'],
} as const;
const opts = (...argv: string[]) => termsOptions(parseArgs(argv, spec));

describe('terms options', () => {
  it('takes a domain and the flags fineprint needs', () => {
    expect(opts('stripe.com', '--as', 'customer', '--provider', 'openrouter', '--also', 'https://a.test/dpa, https://a.test/aup', '--brief')).toEqual({
      target: 'stripe.com',
      file: null,
      provider: 'openrouter',
      perspective: 'customer',
      extra: ['https://a.test/dpa', 'https://a.test/aup'],
      remote: false,
      fresh: false,
      find: false,
      json: false,
      brief: true,
    });
  });

  it('find is discovery only', () => {
    expect(opts('find', 'vercel.com')).toMatchObject({ target: 'vercel.com', find: true });
  });

  it('a file stands in for a target', () => {
    expect(opts('--file', 'agreement.txt')).toMatchObject({ target: null, file: 'agreement.txt' });
  });

  it('rejects an unknown side or provider, and no input at all', () => {
    expect(() => opts('x.com', '--as', 'lawyer')).toThrow(UsageError);
    expect(() => opts('x.com', '--provider', 'gemini')).toThrow(/anthropic, openai, openrouter/);
    expect(() => opts('--json')).toThrow(UsageError);
  });
});
