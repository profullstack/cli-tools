/**
 * email-cleaner: sort a list of email addresses into the ones worth sending to
 * and the ones that are not, the way emaillistcleaner.org does, offline except
 * for DNS.
 *
 * Every check is off-by-default permissive in the other direction: an address
 * is rejected for being a role account, disposable, a duplicate, unlikely, or
 * on a domain with no website, unless the matching `allow*` option is set.
 * Syntax, a missing domain and a domain that cannot take mail are always
 * rejections.
 *
 * DNS is the only network use and it is injectable (`DomainResolver`), so the
 * tests never touch the network. A DNS answer that is neither yes nor no (a
 * timeout, SERVFAIL) never rejects anybody: an address is dropped for what the
 * DNS said, not for what it failed to say.
 */

import { readFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';

export type Reason =
  | 'syntax'
  | 'no-domain'
  | 'no-mx'
  | 'no-website'
  | 'role'
  | 'disposable'
  | 'duplicate'
  | 'unlikely'
  | 'typo';

export const REASONS: readonly Reason[] = [
  'syntax',
  'typo',
  'no-domain',
  'no-mx',
  'no-website',
  'role',
  'disposable',
  'duplicate',
  'unlikely',
];

/** One address to check. `input` is what goes back out, untouched unless a typo is fixed. */
export interface EmailEntry {
  input: string;
  /** The bare address. Parsed out of `input` when missing. */
  email?: string;
  name?: string;
  /** CSV input: the whole record, keyed by header. */
  row?: Record<string, string>;
}

export interface ValidItem {
  input: string;
  email: string;
  name?: string;
  row?: Record<string, string>;
}

export interface InvalidItem {
  input: string;
  email: string;
  reasons: Reason[];
  suggestion?: string;
}

export interface Stats {
  total: number;
  valid: number;
  invalid: number;
  byReason: Partial<Record<Reason, number>>;
  topDomains: [string, number][];
}

export interface LogLine {
  /** 1-based position in the input. */
  index: number;
  email: string;
  message: string;
}

/** Everything known about one entry, in input order. */
export interface Checked {
  index: number;
  entry: EmailEntry;
  /** The address after any typo fix. */
  email: string;
  /** `input` after any typo fix. */
  output: string;
  /** Every property found, allowed or not. */
  found: Reason[];
  /** The subset that rejects the address under the options given. */
  reasons: Reason[];
  suggestion?: string;
  fixedFrom?: string;
}

export interface CleanResult {
  valid: ValidItem[];
  invalid: InvalidItem[];
  stats: Stats;
  items: Checked[];
  log: LogLine[];
  /** How many entries had each property, whether or not it was allowed. */
  special: Partial<Record<Reason, number>>;
}

/** What DNS says about one domain. `null` means "could not tell". */
export interface DomainInfo {
  exists: boolean | null;
  mx: boolean | null;
  apex: boolean | null;
  www: boolean | null;
  error?: string;
}

export interface DomainResolver {
  check(domain: string): Promise<DomainInfo>;
}

export interface CleanOptions {
  allowRole?: boolean;
  allowDisposable?: boolean;
  allowDuplicates?: boolean;
  allowUnlikely?: boolean;
  allowNoWebsite?: boolean;
  /** Default true. False skips every network check. */
  dns?: boolean;
  fixTypos?: boolean;
  resolver?: DomainResolver;
  dnsServer?: string;
  timeoutMs?: number;
  /** Parallel domain lookups. */
  concurrency?: number;
  /** Extra disposable domains on top of the vendored list. */
  disposableDomains?: Iterable<string>;
}

export const DEFAULT_DNS_SERVER = '8.8.8.8';
export const DEFAULT_TIMEOUT_MS = 4000;
export const DEFAULT_CONCURRENCY = 16;

// ---------------------------------------------------------------- lists

/** Role accounts: a department, not a person. Compared with `.`, `-`, `_` removed. */
export const ROLE_LOCAL_PARTS = [
  'abuse', 'accounts', 'accounting', 'admin', 'administrator', 'billing', 'careers',
  'contact', 'contactus', 'customerservice', 'donotreply', 'enquiries', 'feedback',
  'hello', 'help', 'helpdesk', 'hostmaster', 'hr', 'info', 'inquiries', 'jobs',
  'legal', 'mail', 'mailerdaemon', 'marketing', 'media', 'newsletter', 'noreply',
  'notifications', 'office', 'orders', 'postmaster', 'press', 'privacy', 'root',
  'sales', 'security', 'service', 'support', 'team', 'webmaster',
];

/** Local parts people type to get past a form. */
export const UNLIKELY_LOCAL_PARTS = [
  'asdf', 'asdfasdf', 'asdfgh', 'dummy', 'example', 'fake', 'foo', 'foobar', 'na',
  'noemail', 'none', 'nobody', 'nomail', 'nope', 'nothanks', 'null', 'qwerty',
  'sample', 'spam', 'test', 'testing', 'user', 'xxx',
];

/** Domains nobody receives mail at. */
export const UNLIKELY_DOMAINS = [
  'example.com', 'example.net', 'example.org', 'test.com', 'domain.com',
  'yourdomain.com', 'nowhere.com', 'none.com',
];

/** Reserved TLDs (RFC 2606, RFC 6761) and the usual LAN ones. */
export const UNLIKELY_TLDS = ['example', 'invalid', 'localhost', 'test', 'local', 'internal'];

/** Obvious misspellings of the big providers. */
export const TYPO_DOMAINS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com',
  'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmaill.com': 'gmail.com',
  'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com',
  'gmailcom': 'gmail.com', 'gmali.com': 'gmail.com', 'gmil.com': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com',
  'hotmil.com': 'hotmail.com', 'hotamil.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
  'homtail.com': 'hotmail.com', 'hotmaill.com': 'hotmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhoo.com': 'yahoo.com',
  'yahho.com': 'yahoo.com', 'yaoo.com': 'yahoo.com', 'yahoo.cm': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'outlook.co': 'outlook.com',
  'outllok.com': 'outlook.com', 'otlook.com': 'outlook.com',
  'icloud.co': 'icloud.com', 'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com',
  'icluod.com': 'icloud.com', 'iclould.com': 'icloud.com',
  'protonmial.com': 'protonmail.com', 'protonmal.com': 'protonmail.com',
};

/** Providers a near miss is checked against, and real domains one edit away from them. */
const PROVIDERS = ['gmail', 'hotmail', 'yahoo', 'outlook', 'icloud', 'protonmail', 'comcast'];
const REAL_NEAR_PROVIDERS = new Set(['email', 'ymail', 'gmx', 'mail', 'hotmai1']);
const BAD_COM = new Set(['con', 'cmo', 'comm', 'ocm', 'vom', 'xom', 'cpm', 'co', 'cm', 'om', 'c']);

// ---------------------------------------------------------------- parsing addresses

const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Split `Name <addr>`, `"Doe, J" <addr>`, `mailto:addr` or a bare address.
 * Returns the address as written (not lowercased) and the display name.
 */
export function splitAddress(input: string): { email: string; name?: string } {
  const text = input.trim();
  const angle = /^(.*?)\s*<([^<>]*)>\s*$/.exec(text);
  if (angle) {
    const name = angle[1]!.trim().replace(/^"(.*)"$/, '$1').trim();
    return name ? { email: angle[2]!.trim(), name } : { email: angle[2]!.trim() };
  }
  return { email: text.replace(/^mailto:/i, '') };
}

/** The domain part in ASCII (punycode), or null if the address is not an address. */
export function checkSyntax(email: string): { local: string; domain: string } | null {
  if (email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const rawDomain = email.slice(at + 1);
  if (local.length > 64) return null;
  if (local.split('.').some((atom) => !LOCAL_ATOM.test(atom))) return null;
  if (/\s/.test(rawDomain)) return null;
  const domain = domainToASCII(rawDomain.toLowerCase());
  if (!domain || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return null;
  const tld = labels.at(-1)!;
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) return null;
  return { local, domain };
}

/** Lowercase; gmail ignores dots and +tags, everyone else only +tags. */
export function normalizeForDuplicates(email: string): string {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at).toLowerCase();
  let domain = email.slice(at + 1).toLowerCase();
  local = local.replace(/\+.*$/, '');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

export function isRole(local: string): boolean {
  const key = local.toLowerCase().replace(/\+.*$/, '').replace(/[._-]/g, '');
  return ROLE_SET.has(key);
}
const ROLE_SET = new Set(ROLE_LOCAL_PARTS);

export function isUnlikely(local: string, domain: string): boolean {
  const l = local.toLowerCase().replace(/\+.*$/, '');
  const labels = domain.split('.');
  if (UNLIKELY_TLDS.includes(labels.at(-1)!)) return true;
  if (UNLIKELY_DOMAINS.includes(domain)) return true;
  if (UNLIKELY_SET.has(l.replace(/[._-]/g, ''))) return true;
  if (/^(.)\1{2,}$/.test(l)) return true; // aaa@, xxxx@
  if (/^(asdf|qwer|zxcv)/.test(l)) return true; // keyboard mash
  if (labels.length === 2 && l === labels[0]) return true; // test@test.com
  return false;
}
const UNLIKELY_SET = new Set(UNLIKELY_LOCAL_PARTS);

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    // one transposition (gmial -> gmail)
    return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i += 1) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/** The domain someone meant, if this one is an obvious slip; else undefined. */
export function suggestDomain(domain: string): string | undefined {
  const known = TYPO_DOMAINS[domain];
  if (known) return known;
  const labels = domain.split('.');
  if (labels.length !== 2) return undefined;
  const [name, tld] = labels as [string, string];
  if (PROVIDERS.includes(name)) {
    return BAD_COM.has(tld) ? `${name}.com` : undefined;
  }
  if (tld !== 'com' || REAL_NEAR_PROVIDERS.has(name) || name.length < 4) return undefined;
  const near = PROVIDERS.find((p) => editDistanceAtMostOne(name, p));
  return near ? `${near}.com` : undefined;
}

// ---------------------------------------------------------------- disposable list

let vendored: Set<string> | undefined;

/** Parse a domain list file: one per line, `#` comments, blank lines ignored. */
export function parseDomainList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim().toLowerCase())
    .filter(Boolean);
}

export function vendoredDisposableDomains(): Set<string> {
  if (!vendored) {
    const url = new URL('../data/disposable-email-domains.txt', import.meta.url);
    vendored = new Set(parseDomainList(readFileSync(url, 'utf8')));
  }
  return vendored;
}

/** The domain or any parent of it is on the list (mx.throwaway.example counts). */
export function isDisposable(domain: string, list: ReadonlySet<string>): boolean {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (list.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- DNS

function code(error: unknown): string {
  return (error as { code?: string })?.code ?? String(error);
}

/**
 * The real resolver: asks one DNS server (8.8.8.8 by default, like the site),
 * never the system resolver, so results do not depend on the box.
 */
export function dnsResolver({
  server = DEFAULT_DNS_SERVER,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: { server?: string; timeoutMs?: number } = {}): DomainResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  resolver.setServers([server]);

  /** true: records; false: NODATA/NXDOMAIN; null: no answer. */
  async function hasAddress(name: string): Promise<boolean | null> {
    const answers = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)]);
    if (answers.some((a) => a.status === 'fulfilled' && a.value.length > 0)) return true;
    const definite = answers.every(
      (a) => a.status === 'rejected' && ['ENODATA', 'ENOTFOUND'].includes(code(a.reason)),
    );
    return definite ? false : null;
  }

  return {
    async check(domain) {
      let mx: boolean | null;
      try {
        const records = await resolver.resolveMx(domain);
        // RFC 7505 null MX ("0 .") says "no mail here"; node reports it as an empty exchange.
        mx = records.some((r) => r.exchange && r.exchange !== '.');
      } catch (error) {
        const c = code(error);
        if (c === 'ENOTFOUND') return { exists: false, mx: false, apex: false, www: false };
        if (c === 'ENODATA') mx = false;
        else return { exists: null, mx: null, apex: null, www: null, error: c };
      }
      const [apex, www] = await Promise.all([hasAddress(domain), hasAddress(`www.${domain}`)]);
      return { exists: true, mx, apex, www };
    },
  };
}

/** A per-domain cache in front of a resolver, at most `limit` lookups in flight. */
export function limitedResolver(inner: DomainResolver, limit = DEFAULT_CONCURRENCY): DomainResolver {
  const cache = new Map<string, Promise<DomainInfo>>();
  let active = 0;
  const waiting: (() => void)[] = [];

  async function run(domain: string): Promise<DomainInfo> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await inner.check(domain);
    } catch (error) {
      return { exists: null, mx: null, apex: null, www: null, error: code(error) };
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  return {
    check(domain) {
      let hit = cache.get(domain);
      if (!hit) {
        hit = run(domain);
        cache.set(domain, hit);
      }
      return hit;
    },
  };
}

// ---------------------------------------------------------------- the check

function toEntry(value: string | EmailEntry): EmailEntry {
  return typeof value === 'string' ? { input: value } : value;
}

/** Replace the address inside `input` (keeping name, quoting, spacing) with `next`. */
function replaceAddress(input: string, from: string, to: string): string {
  const at = input.lastIndexOf(from);
  return at === -1 ? to : input.slice(0, at) + to + input.slice(at + from.length);
}

/**
 * Check every entry and sort it into valid and invalid.
 *
 * Entries are strings (`a@b.c`, `Name <a@b.c>`) or `EmailEntry` objects; order
 * is kept, and the first of any duplicate group wins.
 */
export async function cleanEmails(
  entries: readonly (string | EmailEntry)[],
  options: CleanOptions = {},
): Promise<CleanResult> {
  const disposable = new Set(vendoredDisposableDomains());
  for (const d of options.disposableDomains ?? []) disposable.add(d.toLowerCase().trim());

  const useDns = options.dns !== false;
  const resolver = useDns
    ? limitedResolver(
        options.resolver ??
          dnsResolver({
            ...(options.dnsServer ? { server: options.dnsServer } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          }),
        options.concurrency ?? DEFAULT_CONCURRENCY,
      )
    : undefined;

  const allowed: Partial<Record<Reason, boolean>> = {
    role: !!options.allowRole,
    disposable: !!options.allowDisposable,
    duplicate: !!options.allowDuplicates,
    unlikely: !!options.allowUnlikely,
    'no-website': !!options.allowNoWebsite,
  };

  const log: LogLine[] = [];
  const seen = new Set<string>();
  const domainCounts = new Map<string, number>();

  const prepared = entries.map((raw, i) => {
    const entry = toEntry(raw);
    const index = i + 1;
    const written = entry.email ?? splitAddress(entry.input).email;
    const name = entry.name ?? (entry.email ? undefined : splitAddress(entry.input).name);
    const found: Reason[] = [];
    let email = written;
    let output = entry.input;
    let suggestion: string | undefined;
    let fixedFrom: string | undefined;

    let parts = checkSyntax(email);
    if (!parts) {
      found.push('syntax');
      log.push({ index, email: written, message: 'syntax: not a valid address' });
    } else {
      const better = suggestDomain(parts.domain);
      if (better) {
        const corrected = `${email.slice(0, email.lastIndexOf('@'))}@${better}`;
        if (options.fixTypos) {
          fixedFrom = email;
          output = replaceAddress(output, email, corrected);
          email = corrected;
          parts = checkSyntax(email)!;
          log.push({ index, email: corrected, message: `typo fixed: ${fixedFrom} -> ${corrected}` });
        } else {
          found.push('typo');
          suggestion = corrected;
          log.push({ index, email, message: `typo: did you mean ${corrected}?` });
        }
      }
    }

    if (parts) {
      domainCounts.set(parts.domain, (domainCounts.get(parts.domain) ?? 0) + 1);
      const key = normalizeForDuplicates(`${parts.local}@${parts.domain}`);
      if (seen.has(key)) {
        found.push('duplicate');
        log.push({ index, email, message: `duplicate of an earlier ${key}` });
      } else seen.add(key);
      if (isRole(parts.local)) found.push('role');
      if (isDisposable(parts.domain, disposable)) found.push('disposable');
      if (isUnlikely(parts.local, parts.domain)) found.push('unlikely');
    }

    return { index, entry, name, email, output, found, parts, suggestion, fixedFrom };
  });

  if (resolver) {
    await Promise.all(
      prepared.map(async (p) => {
        // A typo'd domain is already rejected and may well exist (someone squats gmial.com).
        if (!p.parts || p.found.includes('typo')) return;
        const info = await resolver.check(p.parts.domain);
        if (info.exists === false) p.found.push('no-domain');
        else if (info.exists === null) {
          log.push({ index: p.index, email: p.email, message: `dns: no answer for ${p.parts.domain} (${info.error ?? 'unknown'}), kept` });
        } else if (info.mx === false && info.apex === false) p.found.push('no-mx');
        else if (info.mx === true && info.apex === false && info.www === false) p.found.push('no-website');
      }),
    );
  }

  const items: Checked[] = [];
  const valid: ValidItem[] = [];
  const invalid: InvalidItem[] = [];
  const byReason: Partial<Record<Reason, number>> = {};
  const special: Partial<Record<Reason, number>> = {};

  for (const p of prepared) {
    const found = REASONS.filter((r) => p.found.includes(r));
    const reasons = found.filter((r) => !allowed[r]);
    for (const r of found) special[r] = (special[r] ?? 0) + 1;
    for (const r of reasons) byReason[r] = (byReason[r] ?? 0) + 1;
    for (const r of found) {
      if (['role', 'disposable', 'unlikely', 'no-domain', 'no-mx', 'no-website'].includes(r)) {
        log.push({ index: p.index, email: p.email, message: `${r}${allowed[r] ? ' (allowed)' : ''}` });
      }
    }

    const checked: Checked = { index: p.index, entry: p.entry, email: p.email, output: p.output, found, reasons };
    if (p.suggestion) checked.suggestion = p.suggestion;
    if (p.fixedFrom) checked.fixedFrom = p.fixedFrom;
    items.push(checked);

    if (reasons.length) {
      const item: InvalidItem = { input: p.output, email: p.email, reasons };
      if (p.suggestion) item.suggestion = p.suggestion;
      invalid.push(item);
    } else {
      const item: ValidItem = { input: p.output, email: p.email };
      if (p.name) item.name = p.name;
      if (p.entry.row) item.row = p.entry.row;
      valid.push(item);
    }
  }

  log.sort((a, b) => a.index - b.index);
  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);

  return {
    valid,
    invalid,
    items,
    log,
    special,
    stats: { total: items.length, valid: valid.length, invalid: invalid.length, byReason, topDomains },
  };
}

// ---------------------------------------------------------------- input and output formats

export interface ListInput {
  kind: 'list';
  entries: EmailEntry[];
  /** The separator to write back: "\n", ", ", ";" ... */
  separator: string;
  trailingNewline: boolean;
  newline: string;
}

export interface CsvInput {
  kind: 'csv';
  entries: EmailEntry[];
  header: string[];
  headerLine: string;
  delimiter: string;
  column: number;
  newline: string;
  /** Parsed cells of each data record, parallel to `entries`. */
  records: string[][];
}

export type ParsedInput = ListInput | CsvInput;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

const EMAIL_HEADERS = ['email', 'e-mail', 'email address', 'e-mail address', 'emailaddress', 'mail', 'address'];

/** Parse delimited text into records, each with its raw source text. Quotes per RFC 4180. */
export function parseDelimited(text: string, delimiter: string): { cells: string[]; raw: string }[] {
  const out: { cells: string[]; raw: string }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let start = 0;
  let i = 0;
  const end = (at: number, next: number) => {
    cells.push(cell);
    const raw = text.slice(start, at);
    if (!(cells.length === 1 && cells[0] === '' && raw.trim() === '')) out.push({ cells, raw });
    cells = [];
    cell = '';
    start = next;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i += 1; continue; }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; i += 1; continue; }
    if (ch === delimiter) { cells.push(cell); cell = ''; i += 1; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { end(i, i + 2); i += 2; continue; }
    if (ch === '\n') { end(i, i + 1); i += 1; continue; }
    cell += ch;
    i += 1;
  }
  if (cell !== '' || cells.length) end(text.length, text.length);
  return out;
}

function headerIndex(header: string[]): number {
  const names = header.map((h) => h.trim().toLowerCase());
  for (const want of EMAIL_HEADERS) {
    const at = names.indexOf(want);
    if (at !== -1) return at;
  }
  return -1;
}

/** Split a list on newlines, commas and semicolons, but not inside quotes or <...>. */
function splitList(text: string): { tokens: string[]; separators: string[] } {
  const tokens: string[] = [];
  const separators: string[] = [];
  let token = '';
  let quoted = false;
  let angle = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if (!quoted && !angle && /[\n\r,;]/.test(ch)) {
      let j = i;
      while (j < text.length && /[\s,;]/.test(text[j]!)) j += 1;
      if (token.trim()) {
        tokens.push(token.trim());
        const sep = text.slice(i, j);
        // After a line break, trailing blanks are the next line's indent, not separator.
        separators.push(sep.includes('\n') ? sep.replace(/[ \t]+$/, '') : sep);
      }
      token = '';
      i = j;
      continue;
    }
    token += ch;
    i += 1;
  }
  if (token.trim()) tokens.push(token.trim());
  return { tokens, separators };
}

/** Read text as either a CSV with an email column, or a plain list of addresses. */
export function parseInput(text: string): ParsedInput {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';

  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  const delimiter = best[1] > 0 ? best[0] : ',';
  const firstRecord = parseDelimited(firstLine, delimiter)[0]?.cells ?? [];
  const column = firstLine.includes('@') ? -1 : headerIndex(firstRecord);

  if (column !== -1) {
    const records = parseDelimited(text, delimiter);
    const [head, ...rows] = records;
    const header = head!.cells;
    const entries: EmailEntry[] = rows.map((r) => {
      const row: Record<string, string> = {};
      header.forEach((h, k) => { row[h] = r.cells[k] ?? ''; });
      const { email, name } = splitAddress(r.cells[column] ?? '');
      return name ? { input: r.raw, email, name, row } : { input: r.raw, email, row };
    });
    return {
      kind: 'csv',
      entries,
      header,
      headerLine: head!.raw,
      delimiter,
      column,
      newline,
      records: rows.map((r) => r.cells),
    };
  }

  const { tokens, separators } = splitList(text);
  const tally = new Map<string, number>();
  for (const s of separators) tally.set(s, (tally.get(s) ?? 0) + 1);
  const separator = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n';
  return {
    kind: 'list',
    entries: tokens.map((input) => ({ input })),
    separator,
    trailingNewline: /\n\s*$/.test(text),
    newline,
  };
}

export function csvCell(value: string, delimiter = ','): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

export type Format = 'text' | 'csv' | 'json';

/** Render the kept (or the rejected) entries back in the shape they came in. */
export function render(
  parsed: ParsedInput,
  result: CleanResult,
  { format, which = 'valid' }: { format?: Format; which?: 'valid' | 'invalid' } = {},
): string {
  const shape: Format = format ?? (parsed.kind === 'csv' ? 'csv' : 'text');
  const keep = result.items.filter((c) => (which === 'valid' ? !c.reasons.length : c.reasons.length));

  if (shape === 'json') {
    const body =
      which === 'valid'
        ? { valid: result.valid, invalid: result.invalid, stats: result.stats }
        : { invalid: result.invalid };
    return `${JSON.stringify(body, null, 2)}\n`;
  }

  if (shape === 'csv') {
    if (parsed.kind === 'csv') {
      const nl = parsed.newline;
      const lines = keep.map((c) => {
        if (!c.fixedFrom) return c.entry.input;
        const cells = [...parsed.records[c.index - 1]!];
        cells[parsed.column] = replaceAddress(cells[parsed.column]!, c.fixedFrom, c.email);
        return cells.map((v) => csvCell(v, parsed.delimiter)).join(parsed.delimiter);
      });
      return [parsed.headerLine, ...lines].join(nl) + nl;
    }
    const named = keep.some((c) => splitAddress(c.output).name);
    const header = named ? 'email,name' : 'email';
    const lines = keep.map((c) => {
      const name = splitAddress(c.output).name;
      return named ? `${csvCell(c.email)},${csvCell(name ?? '')}` : csvCell(c.email);
    });
    return [header, ...lines].join('\n') + '\n';
  }

  // text
  if (parsed.kind === 'csv') {
    return keep.length ? keep.map((c) => c.email).join('\n') + '\n' : '';
  }
  if (!keep.length) return '';
  const body = keep.map((c) => c.output).join(parsed.separator);
  return parsed.trailingNewline || parsed.separator.includes('\n') ? body + parsed.newline : body;
}

// ---------------------------------------------------------------- report

const LABELS: Record<Reason, string> = {
  syntax: 'bad syntax',
  typo: 'provider typo',
  'no-domain': 'domain does not exist',
  'no-mx': 'domain takes no mail',
  'no-website': 'domain has no website',
  role: 'role address',
  disposable: 'disposable',
  duplicate: 'duplicate',
  unlikely: 'unlikely valid',
};

function bar(n: number, max: number, width = 30): string {
  if (!n) return '';
  return '#'.repeat(Math.max(1, Math.round((n / max) * width)));
}

/** The human report: log, chart of results, special types, top domains. */
export function formatReport(result: CleanResult, { dns = true }: { dns?: boolean } = {}): string {
  const { stats } = result;
  const out: string[] = [];
  out.push(
    `email-cleaner: ${stats.total} in, ${stats.valid} valid-looking, ${stats.invalid} invalid-looking${dns ? '' : ' (no DNS checks)'}`,
    '',
    'Analysis log',
  );
  if (!result.log.length) out.push('  nothing to report');
  for (const l of result.log) out.push(`  #${String(l.index).padEnd(4)} ${l.email}  ${l.message}`);

  out.push('', 'Results');
  const rows: [string, number][] = [
    ['valid', stats.valid],
    ...REASONS.filter((r) => stats.byReason[r]).map((r) => [LABELS[r], stats.byReason[r]!] as [string, number]),
  ];
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [label, n] of rows) out.push(`  ${label.padEnd(w)}  ${String(n).padStart(5)}  ${bar(n, max)}`);
  if (stats.invalid) out.push('  (an address can fail more than one check)');

  out.push('', 'Special email types');
  const special = (['role', 'disposable', 'duplicate', 'unlikely', 'no-website', 'typo'] as Reason[]).filter(
    (r) => result.special[r],
  );
  if (!special.length) out.push('  none');
  for (const r of special) {
    const total = result.special[r]!;
    const rejected = stats.byReason[r] ?? 0;
    out.push(`  ${LABELS[r].padEnd(22)} ${String(total).padStart(5)}${rejected < total ? '  (allowed)' : ''}`);
  }
  const fixed = result.items.filter((c) => c.fixedFrom).length;
  if (fixed) out.push(`  ${'typos fixed'.padEnd(22)} ${String(fixed).padStart(5)}`);

  out.push('', 'Top 5 input domains');
  if (!stats.topDomains.length) out.push('  none');
  for (const [d, n] of stats.topDomains) out.push(`  ${d.padEnd(30)} ${String(n).padStart(5)}`);
  return `${out.join('\n')}\n`;
}

/** Parse, clean and render in one go: what the CLI does, for other tools to reuse. */
export async function cleanText(
  text: string,
  options: CleanOptions & { format?: Format } = {},
): Promise<{ parsed: ParsedInput; result: CleanResult; output: string; rejected: string }> {
  const parsed = parseInput(text);
  const result = await cleanEmails(parsed.entries, options);
  const fmt = options.format ? { format: options.format } : {};
  return {
    parsed,
    result,
    output: render(parsed, result, fmt),
    rejected: render(parsed, result, { ...fmt, which: 'invalid' }),
  };
}
