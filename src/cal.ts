/**
 * The calendar from the terminal, over CalDAV.
 *
 * Every host that still takes a password speaks the same protocol: PROPFIND
 * to find the principal and its calendars, REPORT to read a window of events,
 * PUT and DELETE to write. Nothing here depends on a library, because the
 * three requests involved are short and the XML they return is shallow.
 *
 * Accounts are configuration (`~/.config/cli-tools/cal.json`, 0600, or the
 * `cli-tools-cal` team vault) and mirror `mail`: a provider names the server
 * and the kind of password it wants, and `cal login` says which before
 * asking. Google Calendar is listed but not reachable — its CalDAV endpoint
 * takes only OAuth2 — for the same reason `mail` lists Outlook.
 *
 * Recurring events are expanded by the server (`<C:expand>` in the REPORT),
 * so a weekly standup shows up on every day it happens without this file
 * implementing RRULE.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export class CalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalError';
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type PasswordKind = 'account' | 'app' | 'alias';

export interface Provider {
  label: string;
  /** Where discovery starts. The principal and calendars may live elsewhere. */
  url: string;
  passwordKind: PasswordKind;
  passwordHint: string;
  passwordUrl?: string;
  domains: string[];
  note?: string;
}

export type BuiltInProvider =
  | 'forwardemail'
  | 'icloud'
  | 'fastmail'
  | 'zoho'
  | 'yahoo'
  | 'aol'
  | 'gmx'
  | 'mailbox'
  | 'posteo';

export type ProviderName = BuiltInProvider | 'custom';

export const PROVIDERS: Record<BuiltInProvider, Provider> = {
  forwardemail: {
    label: 'Forward Email',
    url: 'https://caldav.forwardemail.net',
    passwordKind: 'alias',
    passwordHint:
      'the alias password generated in the Forward Email dashboard (Aliases → the address → ' +
      'Generate Password) — the same one IMAP takes',
    passwordUrl: 'https://forwardemail.net/my-account/domains',
    domains: ['forwardemail.net'],
  },
  icloud: {
    label: 'iCloud Calendar',
    url: 'https://caldav.icloud.com',
    passwordKind: 'app',
    passwordHint:
      'an app-specific password from the Apple Account page (Sign-In and Security → App-Specific ' +
      'Passwords) — the same one iCloud Mail takes',
    passwordUrl: 'https://account.apple.com/account/manage',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    note: 'Log in with the Apple Account address; the calendars live on a numbered pNN-caldav host that discovery finds.',
  },
  fastmail: {
    label: 'Fastmail',
    url: 'https://caldav.fastmail.com/dav/',
    passwordKind: 'app',
    passwordHint:
      'an app password from Settings → Privacy & Security → Integrations → New app password, ' +
      'with calendar access',
    passwordUrl: 'https://app.fastmail.com/settings/security/devices',
    domains: ['fastmail.com', 'fastmail.fm', 'fastmail.us', 'sent.com'],
  },
  zoho: {
    label: 'Zoho Calendar',
    url: 'https://calendar.zoho.com/caldav/',
    passwordKind: 'app',
    passwordHint:
      'the account password, or an application-specific password when two-factor authentication is on',
    passwordUrl: 'https://accounts.zoho.com/home#security/security_password',
    domains: ['zoho.com', 'zohomail.com', 'zoho.eu', 'zoho.in'],
    note: 'An EU or IN data centre uses calendar.zoho.eu / calendar.zoho.in — pass --url.',
  },
  yahoo: {
    label: 'Yahoo Calendar',
    url: 'https://caldav.calendar.yahoo.com',
    passwordKind: 'app',
    passwordHint: 'an app password from Account Security → Generate app password',
    passwordUrl: 'https://login.yahoo.com/account/security',
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.com.au', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com'],
  },
  aol: {
    label: 'AOL Calendar',
    url: 'https://caldav.aol.com',
    passwordKind: 'app',
    passwordHint: 'an app password from Account Security → Generate app password',
    passwordUrl: 'https://login.aol.com/account/security',
    domains: ['aol.com', 'aim.com'],
  },
  gmx: {
    label: 'GMX',
    url: 'https://caldav.gmx.net',
    passwordKind: 'account',
    passwordHint: 'the account password, once CalDAV is enabled (Settings → Calendar → CalDAV)',
    domains: ['gmx.com', 'gmx.us', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
  },
  mailbox: {
    label: 'mailbox.org',
    url: 'https://dav.mailbox.org',
    passwordKind: 'account',
    passwordHint: 'the account password, or an app password when two-factor authentication is on',
    domains: ['mailbox.org'],
  },
  posteo: {
    label: 'Posteo',
    url: 'https://posteo.de:8443',
    passwordKind: 'account',
    passwordHint: 'the account password',
    domains: ['posteo.de', 'posteo.net', 'posteo.eu', 'posteo.org'],
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as BuiltInProvider[];

export function isProviderName(value: unknown): value is ProviderName {
  return value === 'custom' || (typeof value === 'string' && Object.hasOwn(PROVIDERS, value));
}

export function providerFor(name: ProviderName): Provider | null {
  return name === 'custom' ? null : PROVIDERS[name];
}

export interface UnsupportedProvider {
  label: string;
  domains: string[];
  reason: string;
}

/** Calendars a password cannot reach, so `cal login google` explains itself. */
export const UNSUPPORTED_PROVIDERS: Record<string, UnsupportedProvider> = {
  google: {
    label: 'Google Calendar',
    domains: ['gmail.com', 'googlemail.com'],
    reason:
      "Google's CalDAV endpoint takes only OAuth2 tokens; an app password opens Gmail over IMAP but not the calendar. " +
      'Use a client with Google sign-in.',
  },
  outlook: {
    label: 'Outlook.com / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    reason: 'no CalDAV at all; the calendar is only reachable through the Microsoft Graph API with OAuth2',
  },
  proton: {
    label: 'Proton Calendar',
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    reason: 'no CalDAV on any plan, paid or free; the Bridge carries mail only',
  },
};

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

export function guessProvider(email: string): BuiltInProvider | null {
  const domain = domainOf(email);
  for (const name of PROVIDER_NAMES) {
    if (PROVIDERS[name].domains.includes(domain)) return name;
  }
  return null;
}

export function unsupportedProvider(nameOrEmail: string): (UnsupportedProvider & { name: string }) | null {
  const key = nameOrEmail.toLowerCase();
  const domain = domainOf(key);
  for (const [name, provider] of Object.entries(UNSUPPORTED_PROVIDERS)) {
    if (name === key || (domain && provider.domains.includes(domain))) return { name, ...provider };
  }
  return null;
}

export function loginHint(provider: Provider): string {
  const kind: Record<PasswordKind, string> = {
    account: `${provider.label} takes the account password.`,
    app: `${provider.label} takes an app password, not the account password.`,
    alias: `${provider.label} takes a password generated per address.`,
  };
  const lines = [kind[provider.passwordKind], `  ${provider.passwordHint}`];
  if (provider.passwordUrl) lines.push(`  ${provider.passwordUrl}`);
  if (provider.note) lines.push(`  ${provider.note}`);
  return lines.join('\n');
}

export function formatProviders(): string {
  const kinds: Record<PasswordKind, string> = {
    account: 'account password',
    app: 'app password',
    alias: 'per-address password',
  };
  const width = Math.max(...PROVIDER_NAMES.map((name) => name.length), 'custom'.length);
  const rows = PROVIDER_NAMES.map((name) => {
    const provider = PROVIDERS[name];
    return `  ${name.padEnd(width)}  ${provider.label}\n${' '.repeat(width + 4)}${kinds[provider.passwordKind]}; ${provider.url}`;
  });
  rows.push(
    `  ${'custom'.padEnd(width)}  any CalDAV server: --url https://host/dav (Nextcloud: /remote.php/dav; Radicale, Baïkal, Stalwart …)`,
  );
  const unsupported = Object.entries(UNSUPPORTED_PROVIDERS).map(
    ([name, provider]) => `  ${name.padEnd(width)}  ${provider.label}: ${provider.reason}`,
  );
  return ['Providers (`cal login <name> <address>`):', ...rows, '', 'Not reachable with a password:', ...unsupported].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AccountConfig {
  email: string;
  provider: ProviderName;
  /** Login, when it is not the address itself. */
  user?: string;
  password?: string;
  /** Discovery URL, for `custom` or to override a preset (a regional Zoho host). */
  url?: string;
}

export interface CalConfig {
  default?: string;
  accounts: Record<string, AccountConfig>;
}

export type PasswordSource = 'env' | 'file' | 'unset';

export interface Account {
  name: string;
  email: string;
  user: string;
  password: string | null;
  passwordSource: PasswordSource;
  provider: ProviderName;
  url: string;
}

function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

export function calConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLI_TOOLS_CAL_CONFIG || join(xdgConfigHome(env), 'cli-tools', 'cal.json');
}

export function passwordVariable(name: string): string {
  return `CAL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PASSWORD`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CalConfig {
  const path = calConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { accounts: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CalError(`${path}: not valid JSON — ${(error as Error).message}`);
  }
  return normalizeConfig(parsed);
}

export function normalizeConfig(parsed: unknown): CalConfig {
  const config: CalConfig = { accounts: {} };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return config;
  const record = parsed as Record<string, unknown>;
  if (typeof record.default === 'string' && record.default.trim()) config.default = record.default.trim();
  const accounts = record.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) return config;
  for (const [name, raw] of Object.entries(accounts as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.email !== 'string' || !entry.email.includes('@')) continue;
    const account: AccountConfig = {
      email: entry.email.trim().toLowerCase(),
      provider: isProviderName(entry.provider) ? entry.provider : (guessProvider(entry.email) ?? 'custom'),
    };
    for (const key of ['user', 'password', 'url'] as const) {
      const value = entry[key];
      if (typeof value === 'string' && value.trim()) account[key] = value.trim();
    }
    config.accounts[name] = account;
  }
  return config;
}

export function saveConfig(config: CalConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = calConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function resolveAccount(name: string, config: AccountConfig, env: NodeJS.ProcessEnv = process.env): Account {
  const preset = providerFor(config.provider);
  const url = config.url ?? preset?.url;
  if (!url) {
    throw new CalError(
      `account "${name}" is provider "custom" and needs a URL — \`cal login custom ${config.email} --url https://…\``,
    );
  }
  const fromEnv = env[passwordVariable(name)];
  const password = fromEnv || config.password || null;
  return {
    name,
    email: config.email,
    user: config.user ?? config.email,
    password,
    passwordSource: fromEnv ? 'env' : config.password ? 'file' : 'unset',
    provider: config.provider,
    url,
  };
}

/** Which account a selector means — a name, an address, or the default. */
export function selectAccount(config: CalConfig, selector: string | undefined, env: NodeJS.ProcessEnv = process.env): Account {
  const names = Object.keys(config.accounts);
  if (names.length === 0) {
    throw new CalError('no accounts — `cal login <provider> <address>` adds one, `cal accounts pull` imports them');
  }
  let name: string | undefined;
  if (selector) {
    const wanted = selector.toLowerCase();
    name = names.find((candidate) => candidate === wanted || config.accounts[candidate]!.email === wanted);
    if (!name) throw new CalError(`no account "${selector}". Configured: ${names.join(', ')}`);
  } else {
    name = config.default ?? env.CAL_ACCOUNT ?? (names.length === 1 ? names[0] : undefined);
    if (!name || !config.accounts[name]) {
      throw new CalError(`which account? -a one of ${names.join(', ')}, or \`cal accounts default <name>\``);
    }
  }
  return resolveAccount(name, config.accounts[name]!, env);
}

export const CAL_VAULT_PROJECT = 'cli-tools-cal';

/** CAL_<NAME>_EMAIL / _PROVIDER / _PASSWORD / _USER / _URL and CAL_DEFAULT. */
export function accountsFromVault(vault: Record<string, string>): CalConfig {
  const config: CalConfig = { accounts: {} };
  const pattern = /^CAL_([A-Z0-9_]+?)_(EMAIL|PROVIDER|PASSWORD|USER|URL)$/;
  const partial: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(vault)) {
    if (key === 'CAL_DEFAULT') {
      config.default = value.trim().toLowerCase();
      continue;
    }
    const match = pattern.exec(key);
    if (!match) continue;
    (partial[match[1]!.toLowerCase()] ??= {})[match[2]!] = value.trim();
  }
  for (const [name, fields] of Object.entries(partial)) {
    const email = fields.EMAIL;
    if (!email || !email.includes('@')) continue;
    const provider = fields.PROVIDER?.toLowerCase();
    const account: AccountConfig = {
      email: email.toLowerCase(),
      provider: isProviderName(provider) ? provider : (guessProvider(email) ?? (fields.URL ? 'custom' : 'forwardemail')),
    };
    if (fields.PASSWORD) account.password = fields.PASSWORD;
    if (fields.USER) account.user = fields.USER;
    if (fields.URL) account.url = fields.URL;
    config.accounts[name] = account;
  }
  if (config.default && !config.accounts[config.default]) delete config.default;
  return config;
}

/** The vault wins for every field it names; local-only accounts are left alone. */
export function mergeVaultAccounts(local: CalConfig, vault: CalConfig): { merged: CalConfig; changed: string[]; unchanged: string[] } {
  const merged: CalConfig = { accounts: { ...local.accounts } };
  if (local.default) merged.default = local.default;
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [name, account] of Object.entries(vault.accounts)) {
    const before = JSON.stringify(local.accounts[name] ?? null);
    merged.accounts[name] = { ...(local.accounts[name] ?? {}), ...account };
    if (JSON.stringify(merged.accounts[name]) === before) unchanged.push(name);
    else changed.push(name);
  }
  if (vault.default) merged.default = vault.default;
  return { merged, changed, unchanged };
}

// ---------------------------------------------------------------------------
// XML — the little of it CalDAV returns
// ---------------------------------------------------------------------------

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The text of the first `<name>` element, prefix ignored, or null. */
export function xmlText(block: string, name: string): string | null {
  const match = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'i').exec(block);
  return match ? decodeXml(match[1]!).trim() : null;
}

/** Every `<name>` element's inner XML, prefix ignored. */
export function xmlBlocks(text: string, name: string): string[] {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'gi');
  const blocks: string[] = [];
  for (const match of text.matchAll(pattern)) blocks.push(match[1]!);
  return blocks;
}

/** Is an empty or non-empty `<name/>` element present, prefix ignored? */
export function xmlHas(block: string, name: string): boolean {
  return new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?\\/?>`, 'i').test(block);
}

/** A `<D:href>` found inside `<name>`, resolved against the request URL. */
function hrefIn(block: string, name: string, base: string): string | null {
  const inner = xmlText(block, name);
  if (!inner) return null;
  // xmlText decoded the entities, so the href element may now be raw text.
  const href = /<(?:[\w-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i.exec(inner)?.[1] ?? inner;
  return new URL(href.trim(), base).toString();
}

// ---------------------------------------------------------------------------
// CalDAV
// ---------------------------------------------------------------------------

export interface DavResponse {
  status: number;
  text: string;
  etag: string | null;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface Calendar {
  name: string;
  url: string;
  color: string | null;
  /** Component kinds the server allows here; empty means it did not say. */
  components: string[];
}

export interface CalEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  url: string;
  /** ISO instant, or a `YYYY-MM-DD` when `allDay`. */
  start: string;
  /** Exclusive end, same shape as `start`. */
  end: string;
  allDay: boolean;
  status: string;
  recurring: boolean;
  /** Where it lives on the server; null for an event not fetched from one. */
  href: string | null;
  etag: string | null;
  calendar: string | null;
}

export interface CalDav {
  calendars(): Promise<Calendar[]>;
  events(calendar: Calendar, from: Date, to: Date): Promise<CalEvent[]>;
  find(calendar: Calendar, uid: string): Promise<CalEvent | null>;
  put(calendar: Calendar, ics: string, uid: string): Promise<string>;
  remove(href: string, etag: string | null): Promise<void>;
}

/** What a 401 means for this provider, so the fix is named. */
export function loginFailure(account: Account, status: number, detail: string): string {
  const preset = providerFor(account.provider);
  let advice = '';
  if (preset?.passwordKind === 'app') {
    advice = `\n${preset.label} refuses the account password over CalDAV; use an app password` +
      (preset.passwordUrl ? ` (${preset.passwordUrl})` : '') + '.';
  } else if (preset?.passwordKind === 'alias') {
    advice = `\n${preset.label}: ${preset.passwordHint}.`;
  }
  return `CalDAV login to ${account.url} as ${account.user} failed (${status}${detail ? `: ${detail}` : ''})${advice}`;
}

/** A CalDAV client for one account. Requests carry Basic auth over HTTPS only. */
export function openCalDav(account: Account, fetchImpl: Fetcher = fetch): CalDav {
  if (!account.password) {
    const preset = providerFor(account.provider);
    throw new CalError(
      `account "${account.name}" has no password${preset ? ` — ${preset.passwordHint}` : ''}.\n` +
        `Store it with \`cal accounts password ${account.name}\`, export ${passwordVariable(account.name)}, ` +
        'or put it in the vault and run `cal accounts pull`.',
    );
  }
  if (!account.url.startsWith('https://') && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(account.url)) {
    throw new CalError(`account "${account.name}" would send its password in clear over ${account.url}; use https://`);
  }
  const auth = `Basic ${Buffer.from(`${account.user}:${account.password}`).toString('base64')}`;

  async function request(
    method: string,
    url: string,
    options: { depth?: string; body?: string; contentType?: string; headers?: Record<string, string> } = {},
  ): Promise<DavResponse> {
    const headers: Record<string, string> = {
      Authorization: auth,
      'User-Agent': 'cli-tools cal',
      ...(options.depth !== undefined ? { Depth: options.depth } : {}),
      ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      ...(options.headers ?? {}),
    };
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new CalError(`${method} ${url}: ${(error as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CalError(loginFailure(account, response.status, response.statusText));
    }
    // A few servers answer the discovery root with a redirect to the real DAV path.
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) return request(method, new URL(location, url).toString(), options);
    }
    const text = await response.text();
    return { status: response.status, text, etag: response.headers.get('etag') };
  }

  async function propfind(url: string, props: string, depth: string): Promise<DavResponse> {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">' +
      `<D:prop>${props}</D:prop></D:propfind>`;
    const response = await request('PROPFIND', url, { depth, body, contentType: 'application/xml; charset=utf-8' });
    if (response.status < 200 || response.status >= 300) {
      throw new CalError(`PROPFIND ${url} answered ${response.status}${response.text ? `: ${response.text.slice(0, 200)}` : ''}`);
    }
    return response;
  }

  let homeUrl: string | null = null;

  async function calendarHome(): Promise<string> {
    if (homeUrl) return homeUrl;
    const root = await propfind(account.url, '<D:current-user-principal/><C:calendar-home-set/>', '0');
    let home = hrefIn(root.text, 'calendar-home-set', account.url);
    if (!home) {
      const principal = hrefIn(root.text, 'current-user-principal', account.url);
      if (!principal) {
        throw new CalError(`${account.url} did not name a principal; is this the CalDAV URL? (\`cal providers\` lists the usual ones)`);
      }
      const found = await propfind(principal, '<C:calendar-home-set/>', '0');
      home = hrefIn(found.text, 'calendar-home-set', principal);
      if (!home) throw new CalError(`${principal} has no calendar-home-set; the account may have no calendar service`);
    }
    homeUrl = home;
    return home;
  }

  return {
    async calendars() {
      const home = await calendarHome();
      const response = await propfind(
        home,
        '<D:displayname/><D:resourcetype/><C:supported-calendar-component-set/><A:calendar-color/>',
        '1',
      );
      const calendars: Calendar[] = [];
      for (const block of xmlBlocks(response.text, 'response')) {
        const href = xmlText(block, 'href');
        if (!href) continue;
        const type = xmlText(block, 'resourcetype') ?? '';
        if (!xmlHas(type, 'calendar')) continue;
        const comps = xmlText(block, 'supported-calendar-component-set') ?? '';
        const components = [...comps.matchAll(/name="([A-Z]+)"/g)].map((match) => match[1]!);
        if (components.length > 0 && !components.includes('VEVENT')) continue;
        const url = new URL(href, home).toString();
        calendars.push({
          name: xmlText(block, 'displayname') || decodeURIComponent(url.replace(/\/$/, '').split('/').pop() ?? url),
          url,
          color: xmlText(block, 'calendar-color'),
          components,
        });
      }
      return calendars;
    },

    async events(calendar, from, to) {
      const range = `start="${icsUtc(from)}" end="${icsUtc(to)}"`;
      const body =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
        `<D:prop><D:getetag/><C:calendar-data><C:expand ${range}/></C:calendar-data></D:prop>` +
        `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range ${range}/></C:comp-filter></C:comp-filter></C:filter>` +
        '</C:calendar-query>';
      const response = await request('REPORT', calendar.url, { depth: '1', body, contentType: 'application/xml; charset=utf-8' });
      if (response.status < 200 || response.status >= 300) {
        throw new CalError(`REPORT ${calendar.url} answered ${response.status}${response.text ? `: ${response.text.slice(0, 200)}` : ''}`);
      }
      return eventsFromReport(response.text, calendar);
    },

    async find(calendar, uid) {
      const body =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
        '<D:prop><D:getetag/><C:calendar-data/></D:prop>' +
        '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
        `<C:prop-filter name="UID"><C:text-match collation="i;octet">${escapeXml(uid)}</C:text-match></C:prop-filter>` +
        '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';
      const response = await request('REPORT', calendar.url, { depth: '1', body, contentType: 'application/xml; charset=utf-8' });
      if (response.status < 200 || response.status >= 300) return null;
      return eventsFromReport(response.text, calendar).find((event) => event.uid === uid) ?? null;
    },

    async put(calendar, ics, uid) {
      const href = new URL(`${encodeURIComponent(uid)}.ics`, calendar.url).toString();
      const response = await request('PUT', href, {
        body: ics,
        contentType: 'text/calendar; charset=utf-8',
        headers: { 'If-None-Match': '*' },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new CalError(`PUT ${href} answered ${response.status}${response.text ? `: ${response.text.slice(0, 200)}` : ''}`);
      }
      return href;
    },

    async remove(href, etag) {
      const response = await request('DELETE', href, { ...(etag ? { headers: { 'If-Match': etag } } : {}) });
      // Gone already is as good as removed.
      if (response.status < 200 || (response.status >= 300 && response.status !== 404)) {
        throw new CalError(`DELETE ${href} answered ${response.status}`);
      }
    },
  };
}

/** The events in a multistatus REPORT body, one per VEVENT (expanded occurrences included). */
export function eventsFromReport(text: string, calendar: Calendar): CalEvent[] {
  const events: CalEvent[] = [];
  for (const block of xmlBlocks(text, 'response')) {
    const href = xmlText(block, 'href');
    const data = xmlText(block, 'calendar-data');
    if (!href || !data) continue;
    const etag = xmlText(block, 'getetag');
    for (const event of parseIcs(data)) {
      events.push({ ...event, href: new URL(href, calendar.url).toString(), etag, calendar: calendar.name });
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

// ---------------------------------------------------------------------------
// iCalendar
// ---------------------------------------------------------------------------

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Unfold and split an iCalendar text into properties. */
export function icsProperties(text: string): IcsProperty[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const properties: IcsProperty[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // NAME;PARAM=value;PARAM="quoted:value":VALUE — the colon that ends the
    // name is the first one outside quotes.
    let inQuotes = false;
    let colon = -1;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ':' && !inQuotes) {
        colon = index;
        break;
      }
    }
    if (colon === -1) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [rawName, ...rawParams] = head.split(';');
    const params: Record<string, string> = {};
    for (const param of rawParams) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '');
    }
    properties.push({ name: rawName!.toUpperCase(), params, value });
  }
  return properties;
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

export function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** The UTC offset of a zone at an instant, in minutes. */
function zoneOffsetMinutes(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The instant a wall-clock time in a zone names, DST folds resolved to the earlier offset. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - zoneOffsetMinutes(new Date(guess), zone) * 60_000;
  const second = guess - zoneOffsetMinutes(new Date(first), zone) * 60_000;
  return new Date(second);
}

/** An iCalendar DATE or DATE-TIME as an ISO instant or a `YYYY-MM-DD`. */
export function parseIcsDate(value: string, params: Record<string, string>): { value: string; allDay: boolean } | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (params.VALUE === 'DATE' || (date && !value.includes('T'))) {
    if (!date) return null;
    return { value: `${date[1]}-${date[2]}-${date[3]}`, allDay: true };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value);
  if (!match) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((index) => Number(match[index] ?? '0'));
  let instant: Date;
  if (match[7] === 'Z') instant = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
  else if (params.TZID) {
    try {
      instant = zonedToUtc(y!, mo!, d!, h!, mi!, s!, params.TZID);
    } catch {
      instant = new Date(y!, mo! - 1, d!, h!, mi!, s!);
    }
  } else instant = new Date(y!, mo! - 1, d!, h!, mi!, s!);
  return { value: instant.toISOString(), allDay: false };
}

function addDays(day: string, count: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + count));
  return next.toISOString().slice(0, 10);
}

/** Every VEVENT in an iCalendar text, with dates normalised. */
export function parseIcs(text: string): Omit<CalEvent, 'href' | 'etag' | 'calendar'>[] {
  const events: Omit<CalEvent, 'href' | 'etag' | 'calendar'>[] = [];
  let current: IcsProperty[] | null = null;
  for (const property of icsProperties(text)) {
    if (property.name === 'BEGIN' && property.value.toUpperCase() === 'VEVENT') {
      current = [];
      continue;
    }
    if (property.name === 'END' && property.value.toUpperCase() === 'VEVENT' && current) {
      const event = eventFrom(current);
      if (event) events.push(event);
      current = null;
      continue;
    }
    if (current) current.push(property);
  }
  return events;
}

function eventFrom(properties: IcsProperty[]): Omit<CalEvent, 'href' | 'etag' | 'calendar'> | null {
  const first = (name: string) => properties.find((property) => property.name === name);
  const text = (name: string) => unescapeIcs(first(name)?.value ?? '');
  const dtstart = first('DTSTART');
  if (!dtstart) return null;
  const start = parseIcsDate(dtstart.value, dtstart.params);
  if (!start) return null;
  const dtend = first('DTEND');
  let end = dtend ? parseIcsDate(dtend.value, dtend.params) : null;
  if (!end) {
    const duration = first('DURATION')?.value;
    if (start.allDay) end = { value: addDays(start.value, 1), allDay: true };
    else {
      const minutes = duration ? durationMinutes(duration) : 0;
      end = { value: new Date(new Date(start.value).getTime() + minutes * 60_000).toISOString(), allDay: false };
    }
  }
  return {
    uid: text('UID') || `${start.value}-${text('SUMMARY')}`,
    summary: text('SUMMARY'),
    location: text('LOCATION'),
    description: text('DESCRIPTION'),
    url: text('URL'),
    start: start.value,
    end: end.value,
    allDay: start.allDay,
    status: text('STATUS').toUpperCase(),
    recurring: Boolean(first('RRULE') || first('RECURRENCE-ID')),
  };
}

/** An RFC 5545 duration (`PT1H30M`, `P2D`) or a human one (`90m`, `1h30m`, `2d`) in minutes. */
export function durationMinutes(text: string): number {
  const iso = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(text.trim());
  if (iso) {
    const [w, d, h, m, s] = [1, 2, 3, 4, 5].map((index) => Number(iso[index] ?? '0'));
    return w! * 7 * 24 * 60 + d! * 24 * 60 + h! * 60 + m! + Math.round(s! / 60);
  }
  const human = /^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/i.exec(text.trim());
  if (!human || !text.trim()) throw new CalError(`"${text}" is not a duration — 30m, 1h, 1h30m, 2d`);
  const [d, h, m] = [1, 2, 3].map((index) => Number(human[index] ?? '0'));
  return d! * 24 * 60 + h! * 60 + m!;
}

/** `YYYYMMDDTHHMMSSZ` for a CalDAV time-range or a DTSTAMP. */
export function icsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Fold at 75 octets, as RFC 5545 asks; a client that does not fold is a client servers reject. */
export function foldIcs(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let index = 0;
  let width = 75;
  while (index < bytes.length) {
    let cut = Math.min(index + width, bytes.length);
    // Do not split a multi-byte character.
    while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
    out.push(bytes.subarray(index, cut).toString('utf8'));
    index = cut;
    width = 74;
  }
  return out.join('\r\n ');
}

export interface NewEvent {
  uid?: string;
  summary: string;
  /** ISO instant, or `YYYY-MM-DD` when `allDay`. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  url?: string;
}

/** A VCALENDAR holding one VEVENT, ready to PUT. Times go out in UTC. */
export function buildIcs(event: NewEvent, now: Date = new Date()): { uid: string; ics: string } {
  const uid = event.uid ?? randomUUID();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//profullstack//cli-tools cal//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(now)}`,
  ];
  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${event.start.replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${event.end.replace(/-/g, '')}`);
  } else {
    lines.push(`DTSTART:${icsUtc(new Date(event.start))}`);
    lines.push(`DTEND:${icsUtc(new Date(event.end))}`);
  }
  lines.push(`SUMMARY:${escapeIcs(event.summary)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return { uid, ics: `${lines.map(foldIcs).join('\r\n')}\r\n` };
}

// ---------------------------------------------------------------------------
// Times as people type them
// ---------------------------------------------------------------------------

export interface When {
  /** ISO instant, or `YYYY-MM-DD` when `allDay`. */
  value: string;
  allDay: boolean;
}

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * `2026-09-06`, `2026-09-06 14:00`, `2026-09-06T14:00`, `today`, `tomorrow`,
 * `friday`, `tomorrow 9:30`, `fri 14:00`, `14:00` (today), `2pm`.
 * A bare day is all-day; a time makes it an instant in the local zone.
 */
export function parseWhen(input: string, now: Date = new Date()): When {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) throw new CalError('empty time');
  let day: string | null = null;
  let rest = text;

  const iso = /^(\d{4}-\d{2}-\d{2})(?:[t ](.*))?$/.exec(text);
  if (iso) {
    day = iso[1]!;
    rest = iso[2] ?? '';
  } else {
    const [word, ...more] = text.split(' ');
    if (word === 'today') day = localDay(now);
    else if (word === 'tomorrow') day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    else {
      const weekday = WEEKDAYS.findIndex((name) => name === word || name.slice(0, 3) === word);
      if (weekday !== -1) {
        const ahead = (weekday - now.getDay() + 7) % 7 || 7;
        day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead));
      }
    }
    rest = day ? more.join(' ') : text;
    if (!day) day = localDay(now);
  }

  if (!rest) return { value: day, allDay: true };
  const time = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(rest);
  if (!time) throw new CalError(`"${input}" is not a time — 2026-09-06 14:00, tomorrow 9:30, friday, 2pm`);
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? '0');
  if (time[3] === 'pm' && hour < 12) hour += 12;
  if (time[3] === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) throw new CalError(`"${input}" is not a time of day`);
  const [y, m, d] = day.split('-').map(Number);
  return { value: new Date(y!, m! - 1, d!, hour, minute).toISOString(), allDay: false };
}

/** The window a listing covers, from the flags, defaulting to the next 7 days. */
export function windowFrom(
  options: { today?: boolean; tomorrow?: boolean; week?: boolean; days?: number; from?: string; to?: string },
  now: Date = new Date(),
): { from: Date; to: Date; label: string } {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayAfter = (date: Date, count: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
  if (options.today) return { from: startOfDay(now), to: dayAfter(now, 1), label: 'today' };
  if (options.tomorrow) return { from: dayAfter(now, 1), to: dayAfter(now, 2), label: 'tomorrow' };
  if (options.from || options.to) {
    const from = options.from ? new Date(parseWhen(options.from, now).value) : startOfDay(now);
    const to = options.to ? new Date(parseWhen(options.to, now).value) : dayAfter(from, 7);
    if (to <= from) throw new CalError('--to must come after --from');
    return { from, to, label: `${localDay(from)} to ${localDay(to)}` };
  }
  const days = options.week ? 7 : (options.days ?? 7);
  return { from: startOfDay(now), to: dayAfter(now, days), label: `the next ${days} day${days === 1 ? '' : 's'}` };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function localTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]} ${day}`;
}

/** The local day an event starts on, for grouping. */
export function eventDay(event: Pick<CalEvent, 'start' | 'allDay'>): string {
  return event.allDay ? event.start : localDay(new Date(event.start));
}

/** An agenda: one heading per day, one line per event, times local. */
export function formatAgenda(events: CalEvent[], options: { showCalendar?: boolean; width?: number } = {}): string {
  if (events.length === 0) return '(no events)';
  const width = options.width ?? 100;
  const byDay = new Map<string, CalEvent[]>();
  for (const event of events) {
    const day = eventDay(event);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(event);
  }
  const lines: string[] = [];
  for (const day of [...byDay.keys()].sort()) {
    lines.push(dayLabel(day));
    const sorted = byDay.get(day)!.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
    for (const event of sorted) {
      const when = event.allDay ? 'all day     ' : `${localTime(event.start)}–${localTime(event.end)}`;
      const tail = [
        options.showCalendar && event.calendar ? `[${event.calendar}]` : '',
        event.location ? `@ ${event.location}` : '',
        event.status === 'CANCELLED' ? '(cancelled)' : '',
      ]
        .filter(Boolean)
        .join('  ');
      const line = `  ${when}  ${event.summary || '(untitled)'}${tail ? `  ${tail}` : ''}`;
      lines.push(line.length > width ? `${line.slice(0, width - 1)}…` : line);
    }
  }
  return lines.join('\n');
}

export function formatEvent(event: CalEvent): string {
  const when = event.allDay
    ? `${dayLabel(event.start)}${addDays(event.start, 1) === event.end ? '' : ` to ${dayLabel(addDays(event.end, -1))}`} (all day)`
    : `${dayLabel(eventDay(event))} ${localTime(event.start)}–${localTime(event.end)}`;
  const lines = [`Title:    ${event.summary || '(untitled)'}`, `When:     ${when}`];
  if (event.location) lines.push(`Where:    ${event.location}`);
  if (event.calendar) lines.push(`Calendar: ${event.calendar}`);
  if (event.status) lines.push(`Status:   ${event.status.toLowerCase()}`);
  if (event.recurring) lines.push('Repeats:  yes (this is one occurrence)');
  if (event.url) lines.push(`Link:     ${event.url}`);
  lines.push(`Uid:      ${event.uid}`);
  if (event.description) lines.push('', event.description);
  return lines.join('\n');
}

export function formatCalendars(calendars: Calendar[]): string {
  if (calendars.length === 0) return '(no calendars)';
  const width = Math.max(...calendars.map((calendar) => calendar.name.length));
  return calendars.map((calendar) => `${calendar.name.padEnd(width)}  ${calendar.url}`).join('\n');
}

export function formatAccounts(accounts: Account[], defaultName: string | undefined): string {
  if (accounts.length === 0) return '(no accounts — `cal login <provider> <address>`)';
  const width = Math.max(...accounts.map((account) => account.name.length));
  return accounts
    .map((account) => {
      const marker = account.name === defaultName ? '*' : ' ';
      const password =
        account.passwordSource === 'unset'
          ? 'no password'
          : `password from ${account.passwordSource === 'env' ? passwordVariable(account.name) : 'cal.json'}`;
      return `${marker} ${account.name.padEnd(width)}  ${account.email}  ${account.provider}  ${password}`;
    })
    .join('\n');
}
