#!/usr/bin/env node
/**
 * generate-names — turn a sentence into a long list of candidate names.
 *
 * Pipes straight into `domainfree`, which is the point:
 *
 *   generate-names "a registry that checks Lean proofs" | domainfree
 */

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import {
  DEFAULT_COUNT,
  DEFAULT_MODELS,
  DEFAULT_TLD,
  anthropicCaller,
  generateNames,
  openaiCaller,
  resolveProvider,
} from '../src/generate-names.ts';

const USAGE = `Usage:
  generate-names "<what the product does>"
  generate-names "a registry that checks Lean proofs" | domainfree

Asks a cheap model for naming vocabulary, then expands it locally into
candidates. One small API call regardless of --count: asking a model for a
thousand names directly repeats itself and costs far more.

Options:
  -n, --count N     how many names to print (default: ${DEFAULT_COUNT})
      --tld TLD     extension to append (default: ${DEFAULT_TLD})
      --words N     1 or 2 English words per name (default: 2)
      --provider P  openai | anthropic (default: whichever key is set)
      --model M     override the model (default: ${DEFAULT_MODELS.openai} / ${DEFAULT_MODELS.anthropic})
      --seed N      shuffle seed; the same seed reproduces the same list
      --timeout MS  API timeout (default: 60000)
  -h, --help        show this help

Needs an OpenAI or Anthropic key. Store one once:

  cli-tools config set openai        # prompts, nothing echoed or logged
  cli-tools config                   # what is set, and where it came from

kept 0600 in ~/.config/cli-tools/credentials.json. OPENAI_API_KEY and
ANTHROPIC_API_KEY still work and take precedence over a stored key.

Names go to stdout and nothing else does, so the output pipes cleanly.
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help'],
      string: [
        '-n', '--count', '--tld', '--words', '--provider', '--model', '--seed', '--timeout',
      ],
    });

    if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 && !flags.has('-h') && !flags.has('--help') ? 1 : 0);
    }

    const description = positional.join(' ').trim();
    if (description.length < 8) {
      throw new UsageError('describe the product in a sentence, not a word');
    }

    const count = integer(values, values.has('-n') ? '-n' : '--count', DEFAULT_COUNT, {
      min: 1,
      max: 20_000,
    });
    const seed = integer(values, '--seed', 1, { min: 0, max: 2 ** 31 });
    const timeout = integer(values, '--timeout', 60_000, { min: 1000, max: 600_000 });
    const wordCount = integer(values, '--words', 2, { min: 1, max: 2 }) as 1 | 2;
    const tld = (values.get('--tld') ?? DEFAULT_TLD).replace(/^\./, '');
    if (!/^[a-z]{2,}$/i.test(tld)) throw new UsageError(`--tld must be letters, got "${tld}"`);

    // Stored keys first, environment on top — see src/credentials.ts. Shaped
    // as an environment record so resolveProvider needs no change.
    const credentials = resolveCredentials(process.env);

    let provider;
    try {
      provider = resolveProvider(credentials, values.get('--provider'));
    } catch (error) {
      // A bad --provider is a typo and a missing key is a setup problem; both
      // are the caller's to fix, so report them like any other usage error.
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const model = values.get('--model') ?? DEFAULT_MODELS[provider];
    const apiKey = credentials[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY']!;
    const call =
      provider === 'openai'
        ? openaiCaller(apiKey, model, timeout)
        : anthropicCaller(apiKey, model, timeout);

    const names = await generateNames(description, call, {
      count,
      tld,
      seed,
      words: wordCount,
    });

    for (const name of names) process.stdout.write(`${name}\n`);
    process.stderr.write(`${names.length} names · ${provider}/${model}\n`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`generate-names: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`generate-names: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
