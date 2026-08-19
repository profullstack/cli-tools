/**
 * Bulk domain availability, read from the registry.
 *
 * Availability comes from RDAP and never from DNS, because DNS cannot tell
 * registration apart from configuration:
 *
 * - a parked domain resolves fine and is taken;
 * - a domain registered with no nameservers returns NXDOMAIN, which is exactly
 *   what an unregistered name returns.
 *
 * Measured over 8,513 generated candidates, the DNS shortcut
 * (`dig NAME | grep "ANSWER: 0"`) reported 20 registered domains as free and
 * missed none that were genuinely free. `oubliette.com` is the instructive
 * case: registered in 1996, paid through 2034, three nameservers, no A record.
 * Good enough as a cheap prefilter, wrong as a buy signal.
 */

export const DEFAULT_JOBS = 16;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRY_DELAY_MS = 300;

/** Registries that answer RDAP directly. Everything else goes via rdap.org. */
const ENDPOINTS: Record<string, (domain: string, tld: string) => string> = {
  com: (d, t) => `https://rdap.verisign.com/${t}/v1/domain/${d}`,
  net: (d, t) => `https://rdap.verisign.com/${t}/v1/domain/${d}`,
  org: (d) => `https://rdap.publicinterestregistry.org/rdap/domain/${d}`,
};

export type Availability = 'available' | 'taken' | 'unknown';

export interface Result {
  domain: string;
  status: Availability;
  /** HTTP status behind the verdict, or null when the request never completed. */
  code: number | null;
}

export function rdapEndpoint(domain: string): string {
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  const build = ENDPOINTS[tld];
  return build ? build(domain, tld) : `https://rdap.org/domain/${domain}`;
}

/**
 * 404 means the registry holds no record for the name, which is the only
 * evidence of availability there is. Anything else that is not a clean 200 is
 * reported as unknown rather than guessed at — reading a rate limit as
 * "available" is how you try to buy a name someone already owns.
 */
export function classify(code: number | null): Availability {
  if (code === 404) return 'available';
  if (code === 200) return 'taken';
  return 'unknown';
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Lowercase, strip whitespace, drop anything that is not a bare domain, dedupe. */
export function normalizeNames(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(/\r?\n/)) {
    const name = raw.trim().toLowerCase().replace(/\s+/g, '');
    if (!name || name.startsWith('#')) continue;
    if (!DOMAIN_RE.test(name)) continue;
    seen.add(name);
  }
  return [...seen].sort();
}

export type Fetcher = (url: string, timeoutMs: number) => Promise<number | null>;

/** Default fetcher: HEAD-like GET, following redirects, body discarded. */
export const httpFetcher: Fetcher = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'application/rdap+json, application/json' },
    });
    // The body is irrelevant; only the status carries the verdict. Cancel it so
    // the socket is released instead of being held until GC.
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export async function checkOne(
  domain: string,
  { timeout = DEFAULT_TIMEOUT_MS, fetcher = httpFetcher }: CheckOptions = {},
): Promise<Result> {
  const code = await fetcher(rdapEndpoint(domain), timeout);
  return { domain, status: classify(code), code };
}

export interface CheckOptions {
  jobs?: number;
  timeout?: number;
  fetcher?: Fetcher;
  /** Pause before the serial retry pass. Zero in tests; 300ms in practice, to
   *  let a rate limit clear. */
  retryDelayMs?: number;
  /** Called after each lookup settles, for progress reporting. */
  onResult?: (result: Result) => void;
}

/**
 * Run lookups through a fixed-size pool, then retry anything indeterminate once
 * serially — rate limiting is the usual cause and it clears at low concurrency.
 */
export async function checkMany(
  domains: readonly string[],
  options: CheckOptions = {},
): Promise<Result[]> {
  const { jobs = DEFAULT_JOBS, retryDelayMs = DEFAULT_RETRY_DELAY_MS, onResult } = options;
  const results: Result[] = new Array(domains.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= domains.length) return;
      const result = await checkOne(domains[index]!, options);
      results[index] = result;
      onResult?.(result);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(jobs, domains.length)) }, worker),
  );

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    if (result.status !== 'unknown') continue;
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    const retried = await checkOne(result.domain, options);
    results[index] = retried;
    onResult?.(retried);
  }

  return results;
}

export function summarize(results: readonly Result[]): {
  available: number;
  taken: number;
  unknown: number;
} {
  let available = 0;
  let taken = 0;
  let unknown = 0;
  for (const { status } of results) {
    if (status === 'available') available += 1;
    else if (status === 'taken') taken += 1;
    else unknown += 1;
  }
  return { available, taken, unknown };
}
