/**
 * free-names — the two halves of naming something, joined.
 *
 * `generate-names | domainfree` has been the documented pairing since both
 * existed, and it is the right shape for a shell. It is the wrong shape for a
 * pit alias: an alias appends what you typed to the end of its expansion, so
 * the description would land after the pipe rather than where the generator
 * wants it. Every workaround for that is a shell function stored in a config
 * file, which is exactly the thing this repository exists to avoid — a command
 * on PATH works from every caller without anything having been sourced.
 *
 * So the composition lives here instead, and the alias stays thin.
 *
 * Nothing about the two halves changes: names are still expanded locally from
 * one small API call, and availability is still read from RDAP rather than
 * inferred from DNS. This only removes the pipe.
 */

import { checkMany, summarize, type Result } from './domain-free.ts';
import { generateNames, type Caller } from './generate-names.ts';

/**
 * A hundred, where `generate-names` alone defaults to a thousand.
 *
 * The generator prints; this one asks a registry about every line it printed.
 * A thousand candidates is one cheap API call and then a thousand RDAP lookups
 * against servers that rate-limit, which turns a ten-second command into a
 * multi-minute one. A hundred is what fits in the time somebody will actually
 * sit and wait, and `-n` is there for when it is not.
 */
export const DEFAULT_COUNT = 100;

export interface FreeNamesOptions {
  count?: number;
  tld?: string;
  words?: 1 | 2;
  seed?: number;
  jobs?: number;
  timeout?: number;
}

export interface FreeNamesDeps {
  generate?: typeof generateNames;
  check?: typeof checkMany;
}

export interface FreeNamesReport {
  /** Every candidate the generator produced, in the order it produced them. */
  candidates: string[];
  /** The ones a registry says nobody holds, sorted. */
  available: string[];
  /** The raw per-name results, for a caller that wants to explain itself. */
  results: Result[];
  checked: number;
  taken: number;
  /**
   * Lookups that neither confirmed nor denied. Kept separate from `taken` on
   * purpose: an unknown must never be reported as available, because the cost
   * of that mistake is somebody trying to buy a name that is not for sale.
   */
  unknown: number;
}

/**
 * Generate, then check, and hand back both halves of the answer.
 *
 * `generate` and `check` are injectable so the composition can be tested
 * without an API key or a network — the two halves have their own tests for
 * what they each do, and what is worth testing here is only how they join.
 */
export async function freeNames(
  description: string,
  call: Caller,
  options: FreeNamesOptions = {},
  deps: FreeNamesDeps = {},
): Promise<FreeNamesReport> {
  const { generate = generateNames, check = checkMany } = deps;
  const { count = DEFAULT_COUNT, tld, words, seed, jobs, timeout } = options;

  const candidates = await generate(description, call, { count, tld, seed, words });

  // An empty generation is not an error and must not become one: the model
  // answered, the vocabulary was simply too thin to expand. Checking nothing
  // against a registry would be a pointless round trip.
  if (candidates.length === 0) {
    return { candidates: [], available: [], results: [], checked: 0, taken: 0, unknown: 0 };
  }

  const results = await check(candidates, { jobs, timeout });
  const { taken, unknown } = summarize(results);

  return {
    candidates,
    // Filtered from the results rather than counted separately, so the list
    // and the summary can never disagree about what "available" meant.
    available: results
      .filter((r) => r.status === 'available')
      .map((r) => r.domain)
      .sort((a, b) => a.localeCompare(b)),
    results,
    checked: results.length,
    taken,
    unknown,
  };
}
