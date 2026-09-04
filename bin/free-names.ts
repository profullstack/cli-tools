#!/usr/bin/env node
/**
 * free-names — describe the thing, get names nobody has registered.
 *
 * `generate-names "..." | domainfree` in one command. The pipe is the right
 * shape in a shell and the wrong one in a pit alias, which appends what you
 * typed to the end of its expansion — so the description would land after the
 * pipe instead of in front of the generator. A command on PATH takes it in the
 * middle without a shell function in a config file.
 */

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { DEFAULT_JOBS, DEFAULT_TIMEOUT_MS } from '../src/domain-free.ts';
import { DEFAULT_COUNT, freeNames } from '../src/free-names.ts';
import {
  DEFAULT_MODELS,
  DEFAULT_TLD,
  anthropicCaller,
  openaiCaller,
  resolveProvider,
} from '../src/generate-names.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  free-names "<what the product does>"
  free-names "a desktop app for fast rsync transfers" -n 200 --words 1

Generates candidate names from one small API call, then asks the registry which
of them can actually be registered. Equivalent to:

  generate-names "..." | domainfree

Only available names go to stdout, so the output pipes and counts cleanly. The
summary goes to stderr.

Options:
  -n, --count N     candidates to generate and check (default: ${DEFAULT_COUNT})
      --tld TLD     extension to append (default: ${DEFAULT_TLD})
      --words N     1 or 2 English words per name (default: 2)
      --provider P  openai | anthropic (default: whichever key is set)
      --model M     override the model (default: ${DEFAULT_MODELS.openai} / ${DEFAULT_MODELS.anthropic})
      --seed N      shuffle seed; the same seed reproduces the same candidates
  -j, --jobs N      parallel registry lookups (default: ${DEFAULT_JOBS})
  -t, --timeout MS  per-lookup timeout (default: ${DEFAULT_TIMEOUT_MS})
      --api-timeout MS  model timeout (default: 60000)
  -a, --all         print every candidate as "STATUS domain", not just the free
  -q, --quiet       suppress the summary
  -h, --help        show this help

The default count is lower than \`generate-names\` alone, because every
candidate here costs a registry lookup rather than a line of output.

Availability is read from RDAP, never inferred from DNS: a parked domain
resolves but is taken, and a registered domain with no nameservers returns
NXDOMAIN exactly like a free one. Exit status is 2 when any lookup stayed
indeterminate — an unknown is never reported as available.

Needs an OpenAI or Anthropic key:

  cli-tools config set openai        # prompts, nothing echoed or logged
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-a', '--all', '-q', '--quiet', '-h', '--help'],
      string: [
        '-n', '--count', '--tld', '--words', '--provider', '--model', '--seed',
        '-j', '--jobs', '-t', '--timeout', '--api-timeout',
      ],
    });

    if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
      const asked = flags.has('-h') || flags.has('--help');
      process[asked ? 'stdout' : 'stderr'].write(USAGE);
      process.exit(asked ? 0 : 1);
    }

    const description = positional.join(' ').trim();
    if (description.length < 8) {
      throw new UsageError('describe the product in a sentence, not a word');
    }

    const count = integer(values, values.has('-n') ? '-n' : '--count', DEFAULT_COUNT, {
      min: 1,
      // Lower than generate-names' own ceiling on purpose: past this, the
      // registry lookups are the whole cost and a person should be piping
      // `generate-names` into `domainfree` themselves, with a file in between.
      max: 5_000,
    });
    const seed = integer(values, '--seed', 1, { min: 0, max: 2 ** 31 });
    const words = integer(values, '--words', 2, { min: 1, max: 2 }) as 1 | 2;
    const jobs = integer(values, values.has('-j') ? '-j' : '--jobs', DEFAULT_JOBS, {
      min: 1,
      max: 128,
    });
    const timeout = integer(
      values,
      values.has('-t') ? '-t' : '--timeout',
      DEFAULT_TIMEOUT_MS,
      { min: 100, max: 120_000 },
    );
    const apiTimeout = integer(values, '--api-timeout', 60_000, { min: 1000, max: 600_000 });

    const tld = (values.get('--tld') ?? DEFAULT_TLD).replace(/^\./, '');
    if (!/^[a-z]{2,}$/i.test(tld)) throw new UsageError(`--tld must be letters, got "${tld}"`);

    const credentials = resolveCredentials(process.env);
    let provider;
    try {
      provider = resolveProvider(credentials, values.get('--provider'));
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const model = values.get('--model') ?? DEFAULT_MODELS[provider];
    const apiKey = credentials[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY']!;
    const call =
      provider === 'openai'
        ? openaiCaller(apiKey, model, apiTimeout)
        : anthropicCaller(apiKey, model, apiTimeout);

    const report = await freeNames(description, call, {
      count, tld, words, seed, jobs, timeout,
    });

    if (flags.has('-a') || flags.has('--all')) {
      for (const result of report.results.slice().sort((a, b) => a.domain.localeCompare(b.domain))) {
        const label =
          result.status === 'available'
            ? 'AVAILABLE'
            : result.status === 'taken'
              ? 'TAKEN'
              : `ERR:${result.code ?? 'timeout'}`;
        process.stdout.write(`${label} ${result.domain}\n`);
      }
    } else {
      for (const domain of report.available) process.stdout.write(`${domain}\n`);
    }

    if (!(flags.has('-q') || flags.has('--quiet'))) {
      const parts = [
        `${report.candidates.length} generated · ${provider}/${model}`,
        `${report.checked} checked`,
        `${report.available.length} available`,
        `${report.taken} taken`,
      ];
      if (report.unknown > 0) parts.push(`${report.unknown} unknown`);
      process.stderr.write(`${parts.join(' · ')}\n`);
    }

    process.exit(report.unknown > 0 ? 2 : 0);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`free-names: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`free-names: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
