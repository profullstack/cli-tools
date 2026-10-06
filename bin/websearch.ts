#!/usr/bin/env node
/**
 * websearch — one query across Ceramic, Exa and Linkup, ranked by us.
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
  DEFAULT_GATEWAY,
  MAX_LIMIT,
  MAX_QUERY,
  PROVIDERS,
  type Provider,
  authCandidates,
  cloudflareCaller,
  costOf,
  discoverAccountId,
  formatResults,
  rank,
  searchAll,
} from '../src/websearch.ts';

const USAGE = `Usage:
  websearch "<query>"
  websearch "bun vs node" --providers ceramic,linkup --top 5 --explain

Asks all three Cloudflare Web Search providers at once (Ceramic, Exa, Linkup)
and merges their results into one ranked list: rank fusion, cross-provider
agreement, query match and per-host diversity. [CEL] shows which providers
found each page.

Options:
      --providers A,B  any of ${PROVIDERS.join(', ')} (default: all three)
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

Needs a Cloudflare credential: a token with Workers AI Read + AI Gateway Read,
or the global key. Store once:

  cli-tools config set cloudflare          # CLOUDFLARE_API_TOKEN
  cli-tools config set cloudflare_email    # with cloudflare_global, the
  cli-tools config set cloudflare_global   #   fallback when the token lacks scope

Billed by Cloudflare per request from AI Gateway credits: Ceramic $0.25,
Exa $7, Linkup $5 per 1,000. One full run is three requests (about 1.2c).
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
    const providers = (asked.length ? [...new Set(asked)] : [...PROVIDERS]) as Provider[];

    const limit = integer(values, '--limit', MAX_LIMIT, { min: 1, max: MAX_LIMIT });
    const top = values.has('--top') ? integer(values, '--top', 0, { min: 1, max: 1000 }) : undefined;
    const snippet = integer(values, '--snippet', 160, { min: 0, max: 8000 });
    const timeout = integer(values, '--timeout', 30_000, { min: 1000, max: 600_000 });
    const gateway = values.get('--gateway') ?? DEFAULT_GATEWAY;

    const credentials = { ...resolveCredentials(process.env) };
    const auths = authCandidates(credentials);
    if (auths.length === 0) {
      throw new UsageError(
        'no Cloudflare credential — run `cli-tools config set cloudflare`, ' +
          'or export CLOUDFLARE_API_TOKEN (or CLOUDFLARE_EMAIL + CLOUDFLARE_GLOBAL_API_KEY)',
      );
    }

    let accountId = values.get('--account') ?? credentials['CLOUDFLARE_ACCOUNT_ID'];
    if (!accountId) {
      let lastError: unknown;
      for (const auth of auths) {
        try {
          accountId = await discoverAccountId(auth, timeout);
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!accountId) throw lastError;
    }

    const started = Date.now();
    const results = await searchAll(query, providers, cloudflareCaller(accountId, timeout), auths, {
      limit,
      gateway,
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
    for (const result of results) {
      if (result.error) process.stderr.write(`websearch: ${result.provider} failed: ${result.error}\n`);
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
