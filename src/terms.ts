/**
 * `terms`: an AI lawyer for a site's terms of service and privacy policy.
 *
 * The reading happens in @profullstack/fineprint (the same code behind
 * fineprint.agent, its CLI and its MCP server). This file only turns the
 * command line and the keys stored here into its options, so moshcode's
 * `/terms <domain>` and a shell get exactly the same review.
 */
import { UsageError, csv, type ParsedArgs } from './args.ts';

export const PERSPECTIVES = ['business', 'customer', 'developer', 'vendor'] as const;
export const PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type Perspective = (typeof PERSPECTIVES)[number];

export interface TermsOptions {
  target: string | null;
  file: string | null;
  provider?: string;
  model?: string;
  perspective?: Perspective;
  context?: string;
  effort?: string;
  extra: string[];
  remote: boolean;
  fresh: boolean;
  find: boolean;
  json: boolean;
  brief: boolean;
}

export function termsOptions({ flags, values, positional }: ParsedArgs): TermsOptions {
  const [first, ...rest] = positional;
  const find = first === 'find';
  const target = (find ? rest[0] : first) ?? null;
  const file = values.get('--file') ?? null;
  if (!target && file === null) throw new UsageError('give a domain or a link to the terms, or --file');

  const perspective = values.get('--as');
  if (perspective !== undefined && !PERSPECTIVES.includes(perspective as never)) {
    throw new UsageError(`--as must be ${PERSPECTIVES.join(', ')}, got "${perspective}"`);
  }
  const provider = values.get('--provider');
  if (provider !== undefined && !PROVIDERS.includes(provider as never)) {
    throw new UsageError(`--provider must be ${PROVIDERS.join(', ')}, got "${provider}"`);
  }

  return {
    target,
    file,
    ...(provider ? { provider } : {}),
    ...(values.get('--model') ? { model: values.get('--model')! } : {}),
    ...(perspective ? { perspective: perspective as Perspective } : {}),
    ...(values.get('--context') ? { context: values.get('--context')! } : {}),
    ...(values.get('--effort') ? { effort: values.get('--effort')! } : {}),
    extra: csv(values, '--also'),
    remote: flags.has('--remote'),
    fresh: flags.has('--fresh'),
    find,
    json: flags.has('--json'),
    brief: flags.has('--brief'),
  };
}
