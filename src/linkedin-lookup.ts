/**
 * user-export --full: find LinkedIn URLs for contacts that have none, through
 * Google results (ValueSERP), because LinkedIn's own search needs a login.
 *
 * A person is searched only with a first and a last name, and a result is only
 * taken when it is evidence (the same rules OutreachGraph uses for photos):
 *
 *   - the link is a `linkedin.com/in/<slug>` profile, and its title carries
 *     every part of the name;
 *   - with a company domain, the company's name (the domain's first label)
 *     appears in the title or snippet too;
 *   - with no company, exactly one profile in the results carries the name,
 *     because "John Smith" alone is everybody.
 *
 * Anyone still without a profile but with a company domain gets the company's
 * `linkedin.com/company/<slug>` page instead, taken only when the result
 * mentions the domain or the company's name.
 *
 * Every query's raw results are cached on disk, so a rerun costs only the
 * contacts that are new, and tightening a rule here never re-spends a search.
 * Network access is injectable for the tests.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ContactRow } from './user-clean.ts';

export interface SerpResult {
  title?: string | undefined;
  link?: string | undefined;
  snippet?: string | undefined;
}

/** One search: the organic results, or throws. A 402 throws OutOfCredits. */
export type Search = (query: string) => Promise<SerpResult[]>;

export class OutOfCredits extends Error {
  constructor() {
    super('ValueSERP is out of credits (HTTP 402)');
    this.name = 'OutOfCredits';
  }
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function valueSerp(apiKey: string, { fetchImpl = fetch as unknown as Fetch, pauseMs = 1000 } = {}): Search {
  return async (query) => {
    const url = new URL('https://api.valueserp.com/search');
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '10');
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url.toString());
      if (res.status === 402) throw new OutOfCredits();
      if (res.ok) {
        const body = (await res.json()) as { organic_results?: SerpResult[] };
        return Array.isArray(body.organic_results) ? body.organic_results : [];
      }
      if (attempt >= 3 || (res.status !== 429 && res.status < 500)) throw new Error(`ValueSERP answered ${res.status}`);
      await new Promise((r) => setTimeout(r, pauseMs * 2 ** attempt));
    }
  };
}

export function defaultCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'cli-tools', 'linkedin-lookup.json');
}

/** query -> its organic results (title, link, snippet only). */
export type LookupCache = Map<string, SerpResult[]>;

export function loadCache(path: string): LookupCache {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return new Map(Object.entries(raw).filter((e): e is [string, SerpResult[]] => Array.isArray(e[1])));
  } catch {
    return new Map();
  }
}

export function saveCache(path: string, cache: LookupCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(Object.fromEntries(cache))}\n`, { mode: 0o600 });
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Every part of the name of two or more letters, present in the text. */
export function carriesName(text: string, name: string): boolean {
  const haystack = fold(text);
  const parts = fold(name).split(/[\s,]+/).filter((p) => p.length >= 2);
  return parts.length > 0 && parts.every((p) => haystack.includes(p));
}

/** `shop.acme.co.uk` -> `acme.co.uk`: the domain a company registered. */
export function registrable(domain: string): string {
  const labels = domain.toLowerCase().split('.');
  const keep = labels.length >= 3 && /^(co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)!) && labels.at(-1)!.length === 2 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** `shop.acme.co.uk` -> `acme`: the label a company is usually called by. */
export function companyToken(domain: string): string {
  return registrable(domain).split('.')[0] ?? '';
}

/** The profile or company slug as words: `/in/ada-lovelace-42` -> `ada lovelace 42`. */
function slugWords(url: string): string {
  return url.split('/').pop()!.replace(/[-_.]+/g, ' ');
}

function linkedinPath(link: string | undefined, kind: 'in' | 'company'): string {
  if (!link) return '';
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return '';
    const m = url.pathname.match(kind === 'in' ? /^\/in\/([^/]+)/ : /^\/company\/([^/]+)/);
    return m ? `https://www.linkedin.com/${kind}/${decodeURIComponent(m[1]!)}` : '';
  } catch {
    return '';
  }
}

export function personQuery(contact: ContactRow): string {
  const name = `${contact.first_name} ${contact.last_name}`.trim();
  const company = contact.company_domain ? companyToken(contact.company_domain) : '';
  return `site:linkedin.com/in "${name}"${company ? ` ${company}` : ''}`;
}

export function pickPerson(results: readonly SerpResult[], contact: ContactRow): string {
  const name = `${contact.first_name} ${contact.last_name}`;
  const company = contact.company_domain ? fold(companyToken(contact.company_domain)) : '';
  const profiles = new Set<string>();
  for (const r of results) {
    const url = linkedinPath(r.link, 'in');
    if (!url || !carriesName(r.title ?? '', name)) continue;
    if (company) {
      if (company.length >= 3 && fold(`${r.title} ${r.snippet}`).includes(company)) return url;
    } else if (carriesName(slugWords(url), name)) {
      profiles.add(url);
    }
  }
  return profiles.size === 1 ? [...profiles][0]! : '';
}

export function companyQuery(domain: string): string {
  return `site:linkedin.com/company "${registrable(domain)}"`;
}

/**
 * The company page whose title or slug names the company, or whose text
 * carries the domain itself. A snippet that merely mentions the name is not
 * enough: a school district's name turns up on every one of its schools' pages.
 */
export function pickCompany(results: readonly SerpResult[], domain: string): string {
  const site = registrable(domain);
  const token = fold(companyToken(domain));
  for (const r of results) {
    const url = linkedinPath(r.link, 'company');
    if (!url) continue;
    const named = fold(`${r.title} ${slugWords(url)}`).replace(/\s+/g, '');
    if (fold(`${r.title} ${r.snippet}`).includes(site) || (token.length >= 3 && named.includes(token))) return url;
  }
  return '';
}

export interface LookupResult {
  contacts: ContactRow[];
  people: number;
  companies: number;
  searches: number;
  cached: number;
  /** Why the lookup stopped early, when it did. */
  stopped?: string;
}

/**
 * Fill blank linkedin_url: a person's profile where one is evidenced, else
 * their company's page. At most `maxSearches` new searches; cached answers are
 * free. Contacts are never dropped or reordered.
 */
export async function lookupLinkedin(
  contacts: readonly ContactRow[],
  search: Search,
  { cache = new Map() as LookupCache, maxSearches = 3000, concurrency = 3 } = {},
): Promise<LookupResult> {
  const out = contacts.map((c) => ({ ...c }));
  const result: LookupResult = { contacts: out, people: 0, companies: 0, searches: 0, cached: 0 };
  const inflight = new Map<string, Promise<SerpResult[] | undefined>>();

  /** Results for a query, or undefined when the budget or the credits are gone. */
  const ask = async (query: string): Promise<SerpResult[] | undefined> => {
    if (result.stopped) return undefined;
    if (!inflight.has(query)) {
      if (result.searches >= maxSearches) {
        result.stopped = `reached --linkedin-max ${maxSearches}`;
        return undefined;
      }
      result.searches += 1;
      inflight.set(
        query,
        search(query).catch((error: Error) => {
          if (error instanceof OutOfCredits) result.stopped = error.message;
          return undefined;
        }),
      );
    }
    return inflight.get(query);
  };

  /** The URL `pick` takes from the query's results ('' for none), or undefined when it could not search. */
  const answer = async (query: string, pick: (r: SerpResult[]) => string): Promise<string | undefined> => {
    if (cache.has(query)) {
      result.cached += 1;
      return pick(cache.get(query)!);
    }
    const results = await ask(query);
    if (!results) return undefined;
    cache.set(query, results.map(({ title, link, snippet }) => ({ title, link, snippet })));
    return pick(results);
  };

  const work = out.filter((c) => !c.linkedin_url && ((c.first_name && c.last_name) || c.company_domain));
  let next = 0;
  const worker = async () => {
    while (next < work.length && !result.stopped) {
      const contact = work[next++]!;
      if (contact.first_name && contact.last_name) {
        const url = await answer(personQuery(contact), (r) => pickPerson(r, contact));
        if (url) {
          contact.linkedin_url = url;
          result.people += 1;
          continue;
        }
      }
      if (contact.company_domain) {
        const url = await answer(companyQuery(contact.company_domain), (r) => pickCompany(r, contact.company_domain));
        if (url) {
          contact.linkedin_url = url;
          result.companies += 1;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  return result;
}

export function formatLookupSummary(r: LookupResult): string {
  return (
    `linkedin: +${r.people} profiles, +${r.companies} company pages; ${r.searches} searches, ${r.cached} cached` +
    `${r.stopped ? `; stopped: ${r.stopped}` : ''}\n`
  );
}
