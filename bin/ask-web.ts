#!/usr/bin/env -S npx --yes tsx
/**
 * ask-web — answer a question from the live web, with the sources attached.
 *
 *   ask-web "what changed in the EU AI act this month" --recency month
 *
 * Not named `ask`: that name is already taken on PATH here, and a command that
 * shadows another one silently is worse than a longer name.
 */

import { UsageError, csv, integer, parseArgs } from '../src/args.ts';
import {
  DEFAULT_MODEL,
  MODELS,
  type Model,
  RECENCY,
  type Recency,
  askWeb,
  formatAnswer,
  perplexityCaller,
} from '../src/ask-web.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  ask-web "<question>"
  ask-web "what shipped in Node 24" --recency month --domains nodejs.org

Answers from a live web search and prints the pages it used, numbered to match
the [n] markers in the answer.

Options:
      --model M      ${MODELS.join(' | ')}
                     (default: ${DEFAULT_MODEL})
      --recency R    only pages from the last ${RECENCY.join(' | ')}
      --domains A,B  restrict the search to these hosts
      --max-tokens N cap the answer length
      --bare         print the answer only, no source list
      --json         the whole answer as JSON, sources included
      --timeout MS   API timeout (default: 60000)
  -h, --help         show this help

Needs a Perplexity key. Store one once:

  cli-tools config set perplexity     # prompts, nothing echoed or logged
  cli-tools config                    # what is set, and where it came from

kept 0600 in ~/.config/cli-tools/credentials.json. PERPLEXITY_API_KEY still
works and takes precedence over a stored key.

The answer goes to stdout and nothing else does, so it pipes cleanly.
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--bare', '--json'],
      string: ['--model', '--recency', '--domains', '--max-tokens', '--timeout'],
    });

    if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 && !flags.has('-h') && !flags.has('--help') ? 1 : 0);
    }

    const question = positional.join(' ').trim();
    if (question.length < 3) throw new UsageError('ask an actual question');

    const model = values.get('--model') ?? DEFAULT_MODEL;
    if (!MODELS.includes(model as Model)) {
      throw new UsageError(`unknown model: ${model} (expected ${MODELS.join(', ')})`);
    }

    const recency = values.get('--recency');
    if (recency !== undefined && !RECENCY.includes(recency as Recency)) {
      throw new UsageError(`--recency must be ${RECENCY.join(', ')}, got "${recency}"`);
    }

    const timeout = integer(values, '--timeout', 60_000, { min: 1000, max: 600_000 });
    const maxTokens = values.has('--max-tokens')
      ? integer(values, '--max-tokens', 0, { min: 1, max: 32_000 })
      : undefined;

    // Stored keys first, environment on top — see src/credentials.ts.
    const credentials = resolveCredentials(process.env);
    const apiKey = credentials['PERPLEXITY_API_KEY'];
    if (!apiKey) {
      throw new UsageError(
        'no Perplexity key — run `cli-tools config set perplexity`, ' +
          'or export PERPLEXITY_API_KEY',
      );
    }

    const answer = await askWeb(question, perplexityCaller(apiKey, timeout), {
      model,
      ...(recency ? { recency: recency as Recency } : {}),
      domains: csv(values, '--domains'),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });

    process.stdout.write(
      flags.has('--json')
        ? `${JSON.stringify(answer, null, 2)}\n`
        : formatAnswer(answer, { bare: flags.has('--bare') }),
    );

    // Status on stderr so it never lands in a pipe. The dangling-citation line
    // is the one worth reading: it means the answer cited something the search
    // did not return.
    process.stderr.write(`${answer.sources.length} sources · ${answer.model}\n`);
    if (answer.danglingCitations.length > 0) {
      process.stderr.write(
        `warning: cites [${answer.danglingCitations.join('], [')}] with no matching source\n`,
      );
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`ask-web: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`ask-web: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
