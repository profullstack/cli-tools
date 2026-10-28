#!/usr/bin/env node
/**
 * terms — an AI lawyer for a site's terms of service and privacy policy.
 *
 *   terms stripe.com
 *   terms https://example.com/legal/terms --as customer
 *
 * moshcode runs this for `/terms <domain>`.
 */

import { readFileSync } from 'node:fs';
import { findDocuments, run, runText, toMarkdown } from '@profullstack/fineprint';
import { UsageError, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import { PERSPECTIVES, PROVIDERS, termsOptions } from '../src/terms.ts';

const USAGE = `Usage:
  terms <domain|link>               find the terms + privacy policy, read them, advise
  terms --file <path|->             review text you already have (a pasted agreement)
  terms find <domain>               which documents it would read (no model, free)

Finds the terms of service, privacy policy and the policies they pull in
(acceptable use, DPA, cookies, refunds, AI terms), reads every word, and says
what you are agreeing to: the verdict and risk score, liabilities, where your
data goes, red flags with the clause quoted, and what to push back on.

Options:
      --as SIDE        ${PERSPECTIVES.join(' | ')} (default: business)
      --context TEXT   what you will use it for; sharpens the advice
      --provider P     ${PROVIDERS.join(' | ')} (default: the first key set)
      --model ID       default claude-opus-5-5 / gpt-5.6-sol / anthropic/claude-opus-5.5
      --effort LEVEL   anthropic only: low | medium | high | xhigh | max
      --also A,B       more policy links to read alongside the ones it finds
      --brief          red flags, data and asks only
      --json           the whole review as JSON
      --remote         use fineprint.agent even with a key here
      --fresh          (remote) ignore its 7-day cache
  -h, --help           show this help

Runs on your own key, any one of:

  cli-tools config set anthropic      # or openai, or openrouter
  cli-tools config set jina           # optional: reads pages only a browser can

With none, it asks https://fineprint.agent.pit.world (cached reviews free, a few
fresh ones a day). Not legal advice: it quotes the clauses so you can check.

The review goes to stdout; progress goes to stderr.
`;

if (isMain(import.meta.url)) {
  try {
    const parsed = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--json', '--brief', '--remote', '--fresh'],
      string: ['--as', '--context', '--provider', '--model', '--effort', '--also', '--file'],
    });
    if (parsed.flags.has('-h') || parsed.flags.has('--help') || (parsed.positional.length === 0 && !parsed.values.has('--file'))) {
      process.stdout.write(USAGE);
      process.exit(parsed.flags.has('-h') || parsed.flags.has('--help') ? 0 : 1);
    }
    const o = termsOptions(parsed);

    if (o.find) {
      const docs = await findDocuments(o.target!);
      process.stdout.write(
        o.json
          ? `${JSON.stringify(docs, null, 2)}\n`
          : docs.length
            ? `${docs.map((d) => `${d.kind.padEnd(8)} ${d.url}`).join('\n')}\n`
            : 'found nothing; pass the policy link itself\n',
      );
      process.exit(docs.length ? 0 : 1);
    }

    // Stored keys first, environment on top — see src/credentials.ts. fineprint
    // reads JINA_API_KEY from the environment, so put a stored one there.
    const env = resolveCredentials(process.env);
    if (env['JINA_API_KEY'] && !process.env['JINA_API_KEY']) process.env['JINA_API_KEY'] = env['JINA_API_KEY'];

    const common = {
      env,
      ...(o.provider ? { provider: o.provider } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(o.perspective ? { perspective: o.perspective } : {}),
      ...(o.context ? { context: o.context } : {}),
      ...(o.effort ? { effort: o.effort } : {}),
      onStep: (message: string) => process.stderr.write(`· ${message}\n`),
    };

    const review =
      o.file !== null
        ? await runText(readFileSync(o.file === '-' || o.file === '' ? 0 : o.file, 'utf8'), {
            ...common,
            name: o.file && o.file !== '-' ? o.file : 'pasted text',
          })
        : await run(o.target!, { ...common, extra: o.extra, remote: o.remote, fresh: o.fresh });

    process.stdout.write(o.json ? `${JSON.stringify(review, null, 2)}\n` : toMarkdown(review, { brief: o.brief }));
    if (review.usage) {
      process.stderr.write(`${review.provider} · ${review.model} · ${review.usage.input_tokens} in / ${review.usage.output_tokens} out\n`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`terms: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`terms: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
