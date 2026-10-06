#!/usr/bin/env node
/**
 * websearch — one query across Ceramic, Exa, Linkup, Perplexity and Serper, ranked by us.
 *
 *   websearch "bun vs node performance"
 *   /search bun vs node performance        # the pit alias
 *
 * Not named `search`: the pit alias is `/search`, and an alias may not share a
 * name with a command (a shell function beats PATH, and the two would drift).
 */

import { UsageError, csv, integer, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import {
  CLOUDFLARE_PROVIDERS,
  DEFAULT_GATEWAY,
  type DirectCaller,
  MAX_LIMIT,
  MAX_QUERY,
  PROVIDERS,
  type Provider,
  authCandidates,
  cloudflareCaller,
  costOf,
  ceramicCaller,
  discoverAccountId,
  exaCaller,
  linkupCaller,
  formatResults,
  perplexitySearchCaller,
  rank,
  searchAll,
  serperCaller,
} from '../src/websearch.ts';

const USAGE = `Usage:
  websearch "<query>"
  websearch "bun vs node" --providers ceramic,linkup --top 5 --explain

Asks every configured provider at once and merges the results into one ranked
list: rank fusion, cross-provider agreement, query match and per-host diversity.
Ceramic, Exa and Linkup go through Cloudflare Web Search; Perplexity (its own
index) and Serper (Google) are called directly with our keys. [CELPS] shows
which providers found each page.

Options:
      --providers A,B  any of ${PROVIDERS.join(', ')}
                       (default: every one with a key)
      --limit N        results asked of each provider, 1-${MAX_LIMIT} (default: ${MAX_LIMIT})
      --top N          print only the best N after ranking (default: all)
      --explain        print the score breakdown for each result
      --snippet N      description characters to show, 0 for none (default: 160)
      --urls           print URLs only, one per line, for piping
      --json           ranked results and per-provider status as JSON
      --account ID     Cloudflare account id (default: CLOUDFLARE_ACCOUNT_ID,
                       else discovered from the credential)
      --gateway ID     AI Gateway id (default: ${DEFAULT_GATEWAY})
      --timeout MS     per-request timeout (default: 30000)
  -h, --help           show this help

Keys, stored once (any subset works; providers without one are skipped):

  cli-tools config set ceramic             # CERAMIC_API_KEY  platform.ceramic.ai/keys
  cli-tools config set exa                 # EXA_API_KEY      dashboard.exa.ai
  cli-tools config set linkup              # LINKUP_API_KEY   app.linkup.so
  cli-tools config set perplexity          # PERPLEXITY_API_KEY
  cli-tools config set serper              # SERPER_API_KEY (serper.dev)
  # Without their own keys, Ceramic, Exa and Linkup go through Cloudflare:
  cli-tools config set cloudflare          # CLOUDFLARE_API_TOKEN, Workers AI +
                                           #   AI Gateway Read
  cli-tools config set cloudflare_email    # with cloudflare_global, the
  cli-tools config set cloudflare_global   #   fallback when the token lacks scope

Per 1,000 requests: Ceramic $0.25, Exa $7, Linkup $5 (Cloudflare AI Gateway
credits), Perplexity $5, Serper about $1. The stderr line prints the estimate.
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--explain', '--json', '--urls'],
      string: ['--providers', '--limit', '--top', '--snippet', '--account', '--gateway', '--timeout'],
    });

    if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 && !flags.has('-h') && !flags.has('--help') ? 1 : 0);
    }

    const query = positional.join(' ').trim();
    if (!query) throw new UsageError('search for something');
    if (query.length > MAX_QUERY) throw new UsageError(`query is ${query.length} chars; the API takes ${MAX_QUERY}`);

    const asked = csv(values, '--providers').map((p) => p.toLowerCase());
    for (const p of asked) {
      if (!PROVIDERS.includes(p as Provider)) {
        throw new UsageError(`unknown provider: ${p} (expected ${PROVIDERS.join(', ')})`);
      }
    }

    const limit = integer(values, '--limit', MAX_LIMIT, { min: 1, max: MAX_LIMIT });
    const top = values.has('--top') ? integer(values, '--top', 0, { min: 1, max: 1000 }) : undefined;
    const snippet = integer(values, '--snippet', 160, { min: 0, max: 8000 });
    const timeout = integer(values, '--timeout', 30_000, { min: 1000, max: 600_000 });
    const gateway = values.get('--gateway') ?? DEFAULT_GATEWAY;

    const credentials = { ...resolveCredentials(process.env) };
    const auths = authCandidates(credentials);
    const direct: Partial<Record<Provider, DirectCaller>> = {};
    const perplexityKey = credentials['PERPLEXITY_API_KEY'];
    const serperKey = credentials['SERPER_API_KEY'];
    if (perplexityKey) direct.perplexity = perplexitySearchCaller(perplexityKey, timeout);
    if (serperKey) direct.serper = serperCaller(serperKey, timeout);
    // A provider's own key beats going through Cloudflare: no gateway credits
    // needed, and it is the same index either way.
    const ceramicKey = credentials['CERAMIC_API_KEY'];
    const exaKey = credentials['EXA_API_KEY'];
    const linkupKey = credentials['LINKUP_API_KEY'];
    if (ceramicKey) direct.ceramic = ceramicCaller(ceramicKey, timeout);
    if (exaKey) direct.exa = exaCaller(exaKey, timeout);
    if (linkupKey) direct.linkup = linkupCaller(linkupKey, timeout);

    const isCloudflare = (p: Provider) => (CLOUDFLARE_PROVIDERS as readonly string[]).includes(p);
    const configured = PROVIDERS.filter((p) => !!direct[p] || (isCloudflare(p) && auths.length > 0));
    const providers = (asked.length ? [...new Set(asked)] : configured) as Provider[];
    if (providers.length === 0) {
      throw new UsageError(
        'no search provider is configured — run `cli-tools config set serper` or ' +
          '`cli-tools config set perplexity`, or `cli-tools config set cloudflare` for Ceramic, Exa and Linkup',
      );
    }

    // The account id is needed only when a Cloudflare provider is asked. If it
    // cannot be found, those providers fail and the direct ones still answer.
    let accountId = values.get('--account') ?? credentials['CLOUDFLARE_ACCOUNT_ID'] ?? '';
    if (!accountId && auths.length > 0 && providers.some((p) => isCloudflare(p) && !direct[p])) {
      for (const auth of auths) {
        try {
          accountId = await discoverAccountId(auth, timeout);
          break;
        } catch (error) {
          process.stderr.write(`websearch: cloudflare account lookup failed: ${error instanceof Error ? error.message : error}\n`);
        }
      }
    }

    const started = Date.now();
    const results = await searchAll(query, providers, cloudflareCaller(accountId, timeout), auths, {
      limit,
      gateway,
      direct,
    });
    const ranked = rank(query, results);
    const shown = top ? ranked.slice(0, top) : ranked;

    if (flags.has('--json')) {
      process.stdout.write(
        `${JSON.stringify(
          {
            query,
            results: shown,
            providers: results.map(({ provider, hits, latencyMs, error }) => ({
              provider,
              count: hits.length,
              latencyMs,
              error,
            })),
          },
          null,
          2,
        )}\n`,
      );
    } else if (flags.has('--urls')) {
      process.stdout.write(shown.map((item) => `${item.url}\n`).join(''));
    } else {
      process.stdout.write(formatResults(shown, { explain: flags.has('--explain'), snippet }));
    }

    // Status on stderr so it never lands in a pipe.
    // One line per distinct error: the three Cloudflare providers fail together
    // (no credits, bad token), and saying it three times is noise.
    const failures = new Map<string, string[]>();
    for (const result of results) {
      if (result.error) failures.set(result.error, [...(failures.get(result.error) ?? []), result.provider]);
    }
    for (const [error, names] of failures) {
      process.stderr.write(`websearch: ${names.join(', ')} failed: ${error}\n`);
    }
    const ok = results.filter((r) => !r.error);
    const parts = ok.map((r) => `${r.provider} ${r.hits.length}${r.latencyMs !== null ? ` (${r.latencyMs}ms)` : ''}`);
    process.stderr.write(
      `${ranked.length} unique from ${parts.join(', ') || 'no provider'} · ` +
        `${Date.now() - started}ms · ~$${costOf(results).toFixed(4)}\n`,
    );

    if (ok.length === 0) process.exit(2);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`websearch: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`websearch: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
