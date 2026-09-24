import { readFile } from 'node:fs/promises';

import { type Filters, type Workplace, expandHome } from './jobs-config.ts';

/**
 * Find postings worth applying to, from public ATS job-board APIs.
 *
 * The company list is a Markdown page (by default the awesome-ai-startups-hiring
 * README); each company's board is found by guessing its slug on Ashby,
 * Greenhouse, Lever and Workable in turn. None of those need a key, and each
 * exposes a different subset of what a filter wants, so a filter only ever
 * uses a field where the ATS really has it:
 *
 *   | field      | Ashby                 | Greenhouse              | Lever            | Workable      |
 *   |------------|-----------------------|-------------------------|------------------|---------------|
 *   | workplace  | workplaceType         | location text only      | workplaceType    | telecommuting |
 *   | country    | address + location    | location text only      | country (ISO)    | country       |
 *   | pay        | compensation tiers    | pay_input_ranges / text | salaryRange/text | —             |
 *   | description| descriptionPlain      | content                 | description      | —             |
 *
 * Ashby's `isRemote` is true for hybrid roles too, which is why it is not read:
 * `workplaceType` is the field that tells them apart.
 */

export interface Company {
  name: string;
  url: string;
}

export type Ats = 'ashby' | 'greenhouse' | 'lever' | 'workable';

export interface Pay {
  min: number | null;
  max: number | null;
  currency: string;
  interval: 'year' | 'month' | 'hour';
  source: 'ats' | 'text';
}

export interface Posting {
  ats: Ats;
  company: string;
  title: string;
  location: string;
  /** Null when the ATS has no structured field; then it is read from the location text. */
  workplace: Workplace | null;
  /** Countries the ATS itself states (ISO codes or names). */
  countries: string[];
  url: string;
  applyUrl: string;
  description: string;
  pay: Pay | null;
}

export interface Candidate {
  company: string;
  title: string;
  loc: string;
  ats: Ats;
  workplace: Workplace;
  score: number;
  why: string;
  flags: string[];
  url: string;
  applyUrl: string;
  /** Pay as a person reads it: "$150K–$180K USD/yr", or "" when none is stated. */
  comp: string;
  payMin: number | null;
  payMax: number | null;
  payCurrency: string | null;
}

// ---------------------------------------------------------------------------
// The company list
// ---------------------------------------------------------------------------

const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;
const SEPARATOR = /^\s*\|?\s*:?-{3,}/;

/**
 * Companies from a Markdown list.
 *
 * In a table the company is the first cell that is not a row number, linked or
 * not — the awesome lists leave some names unlinked, and taking "the first
 * link on the line" instead picks up a news link from the funding column.
 * Bullets (`- [Name](url)`) are read only when the page has no table, because
 * lists like this one end with a bulleted "other job boards" section.
 */
export function parseCompanies(markdown: string): Company[] {
  const lines = markdown.split('\n');
  const rows: Company[] = [];
  const bullets: Company[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^\s*\|/.test(line)) {
      if (SEPARATOR.test(line) || SEPARATOR.test(lines[index + 1] ?? '')) continue;
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const cell = cells.find((value) => value && !/^#?\d+\.?$/.test(value));
      if (!cell) continue;
      const link = LINK.exec(cell);
      rows.push({ name: (link ? link[1]! : cell).replace(/[*_`]/g, '').trim(), url: link ? link[2]! : '' });
      continue;
    }
    const bullet = /^\s*[-*+] /.test(line) ? LINK.exec(line) : null;
    if (bullet) bullets.push({ name: bullet[1]!.replace(/[*_`]/g, '').trim(), url: bullet[2]! });
  }
  const seen = new Set<string>();
  return (rows.length ? rows : bullets).filter((company) => {
    const key = company.name.toLowerCase();
    if (!company.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function readSource(source: string, fetchText: (url: string) => Promise<string>): Promise<string> {
  if (/^https?:\/\//.test(source)) return fetchText(source);
  return readFile(expandHome(source), 'utf8');
}

/** The board slugs worth trying for a company, most likely first. */
export function slugsFor({ name, url }: Company): string[] {
  const out = new Set<string>();
  const base = name.toLowerCase().replace(/\(.*?\)/g, '').trim();
  out.add(base.replace(/[^a-z0-9]/g, ''));
  out.add(base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  out.add(base.replace(/\b(ai|labs?|inc|hq)\b/g, '').replace(/[^a-z0-9]/g, ''));
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const root = host.split('.')[0]!;
      for (const slug of [root, host.replace(/\./g, ''), `${root}ai`, `${root}hq`, `${root}labs`]) out.add(slug);
    } catch {
      // Not a URL; the name-derived slugs are all there is.
    }
  }
  return [...out].filter((slug) => slug.length > 1);
}

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOL: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

/** Pay in a year, so an hourly contract and a salary compare. 2080 is 40h × 52w. */
export function annual(value: number | null, interval: Pay['interval']): number | null {
  if (value === null) return null;
  return interval === 'hour' ? value * 2080 : interval === 'month' ? value * 12 : value;
}

function intervalFrom(text: string): Pay['interval'] {
  if (/hour|hr\b|hourly/i.test(text)) return 'hour';
  if (/month|\bmo\b|monthly/i.test(text)) return 'month';
  return 'year';
}

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kK])?`;
const PAY_TEXT = new RegExp(
  String.raw`([$€£]|\b(?:USD|EUR|GBP|CAD)\s?\$?)\s?${AMOUNT}` +
    String.raw`(?:\s*(?:-|–|—|to)\s*(?:[$€£]|USD|EUR|GBP|CAD)?\s?${AMOUNT})?` +
    String.raw`(\s*(?:USD|EUR|GBP|CAD)\b)?` +
    String.raw`(\s*(?:\/|per|an|a)\s*(?:hour|hr|year|yr|annum|month|mo)\b)?`,
  'g',
);

function amount(digits: string | undefined, k: string | undefined): number | null {
  if (!digits) return null;
  const value = Number(digits.replace(/,/g, ''));
  return Number.isFinite(value) ? value * (k ? 1000 : 1) : null;
}

/**
 * The first plausible pay range stated in free text.
 *
 * Descriptions quote money that is not pay — "$100M Series B", "$5 lunch
 * stipend" — so a figure only counts when it annualises to something a salary
 * could be, and never when it is followed by M or B.
 */
export function parsePayText(text: string): Pay | null {
  let single: Pay | null = null;
  for (const match of text.matchAll(PAY_TEXT)) {
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 9);
    if (/^\s?(m\b|mm\b|b\b|million|billion)/i.test(after)) continue;
    // "$", or a code written before the figure ("USD 150,000", "CAD $150,000").
    const prefix = match[1]!.trim();
    const symbol = prefix.length > 1 ? prefix.replace(/\s?\$$/, '') : prefix;
    const currency = (match[6]?.trim() || CURRENCY_SYMBOL[symbol] || symbol).toUpperCase();
    const interval = intervalFrom(match[7] ?? '');
    let min = amount(match[2], match[3]);
    let max = amount(match[4], match[5] ?? match[3]);
    // "$150-180k": the k on the upper bound belongs to both.
    if (min !== null && max !== null && !match[3] && match[5] && min < 1000) min *= 1000;
    if (max !== null && min !== null && max < min) max = null;
    const low = annual(min, interval);
    if (low === null || low < 20_000 || low > 2_000_000) continue;
    const pay: Pay = { min, max, currency, interval, source: 'text' };
    if (max !== null) return pay;
    single ??= pay;
  }
  return single;
}

export function formatPay(pay: Pay | null): string {
  if (!pay) return '';
  const symbol = pay.currency === 'USD' ? '$' : pay.currency === 'EUR' ? '€' : pay.currency === 'GBP' ? '£' : '';
  const short = (value: number) =>
    pay.interval === 'hour' ? `${symbol}${value}` : `${symbol}${Math.round(value / 1000)}K`;
  const range = pay.max !== null && pay.max !== pay.min ? `${short(pay.min ?? pay.max)}–${short(pay.max)}` : short((pay.min ?? pay.max)!);
  const per = pay.interval === 'hour' ? '/hr' : pay.interval === 'month' ? '/mo' : '/yr';
  return `${range} ${pay.currency}${per}`;
}

// ---------------------------------------------------------------------------
// Board APIs → Posting
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function stripHtml(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z#0-9]+;/g, ' ');
}

function ashbyPay(job: Json): Pay | null {
  const comp = obj(job.compensation);
  const parts = [
    ...arr(comp.summaryComponents),
    ...arr(comp.compensationTiers).flatMap((tier) => arr(obj(tier).components)),
  ].map(obj).filter((part) => /salary/i.test(str(part.compensationType)));
  if (parts.length) {
    const first = parts[0]!;
    const mins = parts.map((part) => num(part.minValue)).filter((value): value is number => value !== null);
    const maxes = parts.map((part) => num(part.maxValue)).filter((value): value is number => value !== null);
    if (mins.length || maxes.length) {
      return {
        min: mins.length ? Math.min(...mins) : null,
        max: maxes.length ? Math.max(...maxes) : null,
        currency: str(first.currencyCode) || 'USD',
        interval: intervalFrom(str(first.interval)),
        source: 'ats',
      };
    }
  }
  const summary = str(comp.compensationTierSummary);
  return summary ? parsePayText(summary) : null;
}

const ASHBY_WORKPLACE: Record<string, Workplace> = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite' };

export function fromAshby(company: string, data: unknown): Posting[] {
  return arr(obj(data).jobs).map(obj).map((job) => {
    const address = obj(obj(obj(job.address).postalAddress));
    const secondary = arr(job.secondaryLocations).map((loc) => str(obj(obj(obj(loc).address).postalAddress).addressCountry));
    const url = str(job.jobUrl);
    return {
      ats: 'ashby',
      company,
      title: str(job.title),
      location: str(job.location),
      workplace: ASHBY_WORKPLACE[str(job.workplaceType).toLowerCase().replace(/[^a-z]/g, '')] ?? null,
      countries: [str(address.addressCountry), ...secondary].filter(Boolean),
      url,
      applyUrl: `${url}/application`,
      description: str(job.descriptionPlain),
      pay: ashbyPay(job),
    };
  });
}

export function fromGreenhouse(company: string, slug: string, data: unknown): Posting[] {
  return arr(obj(data).jobs).map(obj).map((job) => {
    const description = stripHtml(str(job.content));
    const ranges = arr(job.pay_input_ranges).map(obj);
    const mins = ranges.map((range) => num(range.min_cents)).filter((value): value is number => value !== null);
    const maxes = ranges.map((range) => num(range.max_cents)).filter((value): value is number => value !== null);
    const pay: Pay | null = ranges.length && (mins.length || maxes.length)
      ? {
          min: mins.length ? Math.min(...mins) / 100 : null,
          max: maxes.length ? Math.max(...maxes) / 100 : null,
          currency: str(ranges[0]!.currency_type) || 'USD',
          interval: 'year',
          source: 'ats',
        }
      : parsePayText(description);
    return {
      ats: 'greenhouse',
      company,
      title: str(job.title),
      location: str(obj(job.location).name),
      workplace: null,
      countries: [],
      url: str(job.absolute_url),
      // The embed URL serves the bare form even when a board redirects to the company site.
      applyUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${slug}&token=${String(job.id)}`,
      description,
      pay,
    };
  });
}

const LEVER_WORKPLACE: Record<string, Workplace> = { remote: 'remote', hybrid: 'hybrid', 'on-site': 'onsite', onsite: 'onsite' };

export function fromLever(company: string, data: unknown): Posting[] {
  return arr(data).map(obj).map((job) => {
    const lists = arr(job.lists).map(obj).map((list) => `${str(list.text)} ${stripHtml(str(list.content))}`);
    const description = `${str(job.descriptionPlain)} ${lists.join(' ')} ${str(job.additionalPlain)}`.trim();
    const range = obj(job.salaryRange);
    const pay: Pay | null = num(range.min) !== null || num(range.max) !== null
      ? {
          min: num(range.min),
          max: num(range.max),
          currency: str(range.currency) || 'USD',
          interval: intervalFrom(str(range.interval)),
          source: 'ats',
        }
      : parsePayText(`${str(job.salaryDescriptionPlain)} ${description}`);
    const categories = obj(job.categories);
    return {
      ats: 'lever',
      company,
      title: str(job.text),
      location: [str(categories.location), ...arr(categories.allLocations).map(str)].filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index).join('; '),
      workplace: LEVER_WORKPLACE[str(job.workplaceType).toLowerCase()] ?? null,
      countries: [str(job.country)].filter(Boolean),
      url: str(job.hostedUrl),
      applyUrl: str(job.applyUrl),
      description,
      pay,
    };
  });
}

export function fromWorkable(company: string, data: unknown): Posting[] {
  return arr(obj(data).jobs).map(obj).map((job) => ({
    ats: 'workable',
    company,
    title: str(job.title),
    location: [str(job.city), str(job.state), str(job.country)].filter(Boolean).join(', '),
    // telecommuting is a yes/no: "no" may still be hybrid, so only "yes" is structured.
    workplace: job.telecommuting === true ? 'remote' : null,
    countries: [str(job.country), ...arr(job.locations).map((loc) => str(obj(loc).countryCode))].filter(Boolean),
    url: str(job.url),
    applyUrl: str(job.application_url) || str(job.url),
    description: '',
    pay: null,
  }));
}

export type FetchJson = (url: string) => Promise<unknown>;

/** The first board that answers for any of the company's slugs. */
export async function probeCompany(company: Company, fetchJson: FetchJson): Promise<Posting[]> {
  for (const slug of slugsFor(company)) {
    const ashby = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    if (arr(obj(ashby).jobs).length) return fromAshby(company.name, ashby);
    const greenhouse = await fetchJson(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true&pay_transparency=true`,
    );
    if (arr(obj(greenhouse).jobs).length) return fromGreenhouse(company.name, slug, greenhouse);
    const lever = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (arr(lever).length) return fromLever(company.name, lever);
    const workable = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
    if (arr(obj(workable).jobs).length) return fromWorkable(company.name, workable);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

/**
 * Country and region words as they appear in location text.
 *
 * US deliberately counts "Americas", which is how remote roles open to the US
 * are usually labelled. A location that names no place at all ("Remote")
 * passes any country filter: it excludes nobody.
 */
export const PLACES: Record<string, RegExp> = {
  US: /united states|\bus\b|\busa\b|\bu\.s\.|americas|north america/i,
  CA: /canada|toronto|vancouver|montr[eé]al/i,
  GB: /london|\buk\b|united kingdom|england|scotland/i,
  IE: /dublin|ireland/i,
  DE: /berlin|munich|germany/i,
  FR: /paris|france/i,
  NL: /amsterdam|netherlands/i,
  ES: /spain|madrid|barcelona/i,
  PL: /poland|warsaw/i,
  CH: /zurich|z[üu]rich|switzerland/i,
  SE: /stockholm|sweden/i,
  IL: /israel|tel aviv/i,
  IN: /india|bangalore|bengaluru|hyderabad|pune/i,
  JP: /japan|tokyo/i,
  SG: /singapore/i,
  KR: /korea|seoul/i,
  TW: /taiwan/i,
  AU: /australia|sydney|melbourne/i,
  BR: /brazil|s[ãa]o paulo/i,
  MX: /mexico/i,
  EUROPE: /europe\b|\beu\b/i,
  EMEA: /emea/i,
  APAC: /apac|asia/i,
  LATAM: /latam|latin america/i,
};

/** Country names the ATSs spell out, to their codes. */
const COUNTRY_NAMES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', canada: 'CA',
  'united kingdom': 'GB', uk: 'GB', ireland: 'IE', germany: 'DE', france: 'FR', netherlands: 'NL',
  spain: 'ES', poland: 'PL', switzerland: 'CH', sweden: 'SE', israel: 'IL', india: 'IN', japan: 'JP',
  singapore: 'SG', 'south korea': 'KR', korea: 'KR', taiwan: 'TW', australia: 'AU', brazil: 'BR', mexico: 'MX',
};

export function placesIn(posting: Pick<Posting, 'location' | 'countries'>): Set<string> {
  const found = new Set<string>();
  for (const country of posting.countries) {
    const code = country.length === 2 ? country.toUpperCase() : COUNTRY_NAMES[country.toLowerCase()];
    if (code) found.add(code);
  }
  for (const [code, pattern] of Object.entries(PLACES)) if (pattern.test(posting.location)) found.add(code);
  return found;
}

export function placeAllowed(posting: Pick<Posting, 'location' | 'countries'>, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const places = placesIn(posting);
  if (places.size === 0) return true;
  return allowed.some((code) => places.has(code.toUpperCase()));
}

export function workplaceOf(posting: Pick<Posting, 'workplace' | 'location' | 'title'>): Workplace {
  if (posting.workplace) return posting.workplace;
  if (/remote|anywhere|distributed/i.test(posting.location) || /\bremote\b/i.test(posting.title)) return 'remote';
  if (/hybrid/i.test(posting.location) || /\bhybrid\b/i.test(posting.title)) return 'hybrid';
  return 'onsite';
}

// ---------------------------------------------------------------------------
// Filtering and scoring
// ---------------------------------------------------------------------------

export function flagsFor(description: string): string[] {
  const flags: string[] = [];
  if (/(monday|mon)\s*[-–]\s*(thursday|friday)\s+onsite|days a week in (the )?office|in[- ]office \d|onsite (required|in)/i.test(description)) flags.push('ONSITE');
  if (/clearance/i.test(description)) flags.push('CLEARANCE');
  if (/\b(primary language|primarily in) (go|golang|java|python|rust|c\+\+)/i.test(description) && !/typescript|node/i.test(description)) flags.push('NON-JS');
  if (/must be based in|required to be based in/i.test(description)) flags.push('LOCATION-BOUND');
  return flags;
}

function anyOf(terms: string[], bounded = false): RegExp | null {
  if (terms.length === 0) return null;
  const body = terms.map((term) => `(?:${term})`).join('|');
  return new RegExp(bounded ? `\\b(?:${body})\\b` : body, 'i');
}

export type Verdict = { keep: true; candidate: Candidate } | { keep: false; reason: string };

/**
 * One posting against one profile's filters. `seen` is the dedupe check
 * against everything already applied to, from any profile.
 */
export function evaluate(posting: Posting, filters: Filters, seen: (url: string) => boolean): Verdict {
  const title = posting.title.trim();
  const include = anyOf(filters.title.include);
  const exclude = anyOf(filters.title.exclude, true);
  if (include && !include.test(title)) return { keep: false, reason: 'title' };
  if (exclude?.test(title)) return { keep: false, reason: 'title' };

  const workplace = workplaceOf(posting);
  if (!filters.workplace.includes(workplace)) return { keep: false, reason: 'workplace' };
  if (!placeAllowed(posting, filters.countries)) return { keep: false, reason: 'country' };
  if (seen(posting.url) || seen(posting.applyUrl)) return { keep: false, reason: 'applied' };

  const flags = flagsFor(posting.description);
  const pay = posting.pay;
  if (!pay) {
    if (filters.pay.require) return { keep: false, reason: 'pay' };
    flags.push('pay:unknown');
  } else if (pay.currency !== filters.pay.currency) {
    flags.push(`pay:${pay.currency}`);
  } else if (filters.pay.min !== null) {
    const top = annual(pay.max ?? pay.min, pay.interval);
    if (top !== null && top < filters.pay.min) return { keep: false, reason: 'pay' };
  }
  if (flags.some((flag) => filters.exclude.some((wanted) => wanted.toLowerCase() === flag.toLowerCase()))) {
    return { keep: false, reason: 'flag' };
  }

  let score = 0;
  const why: string[] = [];
  for (const [tag, boost] of Object.entries(filters.boost)) {
    const pattern = anyOf(boost.terms);
    if (!pattern) continue;
    if (pattern.test(title) || (boost.in === 'any' && pattern.test(posting.description))) {
      score += boost.weight;
      why.push(tag);
    }
  }

  return {
    keep: true,
    candidate: {
      company: posting.company,
      title,
      loc: posting.location,
      ats: posting.ats,
      workplace,
      score,
      why: why.join(','),
      flags,
      url: posting.url,
      applyUrl: posting.applyUrl,
      comp: formatPay(pay),
      payMin: pay ? annual(pay.min, pay.interval) : null,
      payMax: pay ? annual(pay.max, pay.interval) : null,
      payCurrency: pay?.currency ?? null,
    },
  };
}

export interface DiscoverResult {
  companies: number;
  withBoards: number;
  matched: number;
  shortlist: Candidate[];
  dropped: Record<string, number>;
}

/** Everything that survived the filters, best first, cut to the score floor and the limit. */
export function rank(
  postings: Posting[],
  filters: Filters,
  seen: (url: string) => boolean,
): { matched: Candidate[]; dropped: Record<string, number> } {
  const matched: Candidate[] = [];
  const dropped: Record<string, number> = {};
  for (const posting of postings) {
    const verdict = evaluate(posting, filters, seen);
    if (verdict.keep) matched.push(verdict.candidate);
    else dropped[verdict.reason] = (dropped[verdict.reason] ?? 0) + 1;
  }
  return { matched: matched.sort((a, b) => b.score - a.score), dropped };
}

export async function fetchJsonDefault(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function fetchTextDefault(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

export async function discover(
  filters: Filters,
  seen: (url: string) => boolean,
  options: {
    fetchJson?: FetchJson;
    fetchText?: (url: string) => Promise<string>;
    minScore?: number;
    limit?: number;
    concurrency?: number;
  } = {},
): Promise<DiscoverResult> {
  const fetchJson = options.fetchJson ?? fetchJsonDefault;
  const companies = parseCompanies(await readSource(filters.source, options.fetchText ?? fetchTextDefault));
  const boards: Posting[][] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: options.concurrency ?? 12 }, async () => {
      while (next < companies.length) {
        const company = companies[next++]!;
        boards.push(await probeCompany(company, fetchJson));
      }
    }),
  );
  const { matched, dropped } = rank(boards.flat(), filters, seen);
  const minScore = options.minScore ?? filters.minScore;
  return {
    companies: companies.length,
    withBoards: boards.filter((board) => board.length).length,
    matched: matched.length,
    shortlist: matched.filter((candidate) => candidate.score >= minScore).slice(0, options.limit ?? filters.limit),
    dropped,
  };
}
