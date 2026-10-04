/**
 * statements — the original PDF statements behind every SimpleFIN account.
 *
 * SimpleFIN gives an app balances and transactions and nothing else: the
 * protocol has no document endpoint, and the Bridge does not keep the PDFs its
 * banks issue. Anyone who needs the real statement (taxes, a lender, a
 * reconciliation in CoinPay's statement library) has to log in to every bank
 * and click through each month by hand. This does that clicking.
 *
 * - **The account list comes from SimpleFIN** (an access URL of your own) or
 *   from CoinPay, which already holds a SimpleFIN connection; either way it
 *   says which institutions exist and the last four digits of each account.
 * - **Every bank gets its own Chrome profile**, logged in once by a person in a
 *   real window (`statements login`). No bank password is ever asked for or
 *   stored here; the session is the bank's own cookie, and when the bank
 *   expires it `fetch` says so instead of trying to sign in.
 * - **`fetch` drives that profile**: open the statements page, find every
 *   control that downloads a dated statement, click the ones not yet seen,
 *   catch the PDF through the DevTools download events, and file it as
 *   `<institution>/<account>/<YYYY-MM>.pdf` beside a manifest.
 * - **`assist` is the fallback** for a bank whose page the finder cannot read:
 *   the same profile in a window, and every PDF the person downloads is filed
 *   the same way.
 *
 * Bank pages change without notice, so nothing here claims to know a page's
 * markup. The finder looks for what every statements page has in common (a
 * dated row with a download or PDF control) and reports what it saw.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export class StatementsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementsError';
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  name: string;
  /** The last four digits the bank prints on the statement, when the name carries them. */
  last4: string | null;
  institution: string;
  institutionName: string;
  /** The institution's own site, from SimpleFIN's org record. */
  url: string | null;
  /** SimpleFIN's account id, when known: CoinPay keeps it as `external_id`. */
  externalId: string | null;
  /** CoinPay's account id, when the list came from CoinPay. */
  coinpayId: string | null;
}

export interface Institution {
  key: string;
  name: string;
  url: string | null;
  accounts: Account[];
}

export type AccountSource = 'simplefin' | 'coinpay';

/** The four digits an account name ends with: "SAPPHIRE (6496)", "Checking ...1234", "Visa x9876". */
export function lastFour(name: string): string | null {
  const tail = /(\d{4})\)?\s*$/.exec(name);
  if (tail) return tail[1]!;
  const all = [...name.matchAll(/(?<!\d)(\d{4})(?!\d)/g)];
  return all.length ? all[all.length - 1]![1]! : null;
}

export function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'account';
}

/**
 * One short, stable key per institution: the name its site goes by.
 * secure.chase.com and chase.com are both `chase`; card.apple.com is `apple`.
 */
export function institutionKey(domain: string | null | undefined, name: string | null | undefined): string {
  const host = (domain ?? '').replace(/^https?:\/\//, '').split(/[/:]/)[0]!.toLowerCase();
  const labels = host.split('.').filter(Boolean);
  if (labels.length >= 2) {
    // co.uk, com.au and friends: the registrable label is one further left.
    const second = labels[labels.length - 2]!;
    const pick = labels.length >= 3 && /^(co|com|org|net|gov|ac)$/.test(second) ? labels[labels.length - 3]! : second;
    return slug(pick);
  }
  return slug(name ?? host ?? 'bank');
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function account(fields: { id: string; name: string; domain: string | null; orgName: string | null; url: string | null; externalId: string | null; coinpayId: string | null }): Account {
  return {
    id: fields.id,
    name: fields.name,
    last4: lastFour(fields.name),
    institution: institutionKey(fields.domain ?? fields.url, fields.orgName),
    institutionName: fields.orgName ?? fields.domain ?? 'Unknown institution',
    url: fields.url ?? (fields.domain ? `https://${fields.domain.replace(/^https?:\/\//, '')}` : null),
    externalId: fields.externalId,
    coinpayId: fields.coinpayId,
  };
}

/**
 * A SimpleFIN `/accounts` answer. Protocol 1 nests `org` in each account;
 * the 2.0 draft lists `connections` once and points at them with `conn_id`.
 */
export function parseSimplefinAccounts(body: unknown): { accounts: Account[]; errors: string[] } {
  const data = (body ?? {}) as Record<string, unknown>;
  const connections = new Map<string, Record<string, unknown>>();
  for (const connection of Array.isArray(data.connections) ? data.connections : []) {
    const record = connection as Record<string, unknown>;
    const id = text(record.conn_id);
    if (id) connections.set(id, record);
  }

  const accounts: Account[] = [];
  for (const raw of Array.isArray(data.accounts) ? data.accounts : []) {
    const record = raw as Record<string, unknown>;
    const id = text(record.id);
    if (!id) continue;
    const org = (record.org ?? {}) as Record<string, unknown>;
    const connection = connections.get(text(record.conn_id) ?? '') ?? {};
    const url = text(org.url) ?? text(connection.org_url);
    const domain = text(org.domain) ?? hostOf(url);
    accounts.push(
      account({
        id,
        name: text(record.name) ?? id,
        domain,
        orgName: text(org.name) ?? text(connection.name),
        url,
        externalId: id,
        coinpayId: null,
      }),
    );
  }

  const errors: string[] = [];
  for (const entry of [...(Array.isArray(data.errors) ? data.errors : []), ...(Array.isArray(data.errlist) ? data.errlist : [])]) {
    const message = typeof entry === 'string' ? entry : text((entry as Record<string, unknown>).msg);
    if (message) errors.push(message);
  }
  return { accounts, errors };
}

/** `coinpay finances accounts --json`: `{accounts: [{id, name, org_name, external_id, ...}]}`. */
export function parseCoinpayAccounts(body: unknown): Account[] {
  const rows = ((body ?? {}) as { accounts?: unknown }).accounts;
  if (!Array.isArray(rows)) throw new StatementsError('coinpay answered without an accounts list');
  return rows.flatMap((raw) => {
    const record = raw as Record<string, unknown>;
    const id = text(record.id);
    if (!id) return [];
    const url = text(record.org_url);
    return [
      account({
        id,
        name: text(record.name) ?? id,
        domain: text(record.org_domain) ?? hostOf(url),
        orgName: text(record.org_name),
        url,
        externalId: text(record.external_id),
        coinpayId: id,
      }),
    ];
  });
}

export function groupInstitutions(accounts: readonly Account[]): Institution[] {
  const byKey = new Map<string, Institution>();
  for (const entry of accounts) {
    const existing = byKey.get(entry.institution);
    if (existing) {
      existing.accounts.push(entry);
      existing.url ??= entry.url;
    } else {
      byKey.set(entry.institution, { key: entry.institution, name: entry.institutionName, url: entry.url, accounts: [entry] });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// SimpleFIN
// ---------------------------------------------------------------------------

/** A setup token is the claim URL, base64-encoded. */
export function decodeSetupToken(token: string): string {
  const decoded = Buffer.from(token.trim(), 'base64').toString('utf8').trim();
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new StatementsError('that is not a SimpleFIN setup token (it should decode to a claim URL)');
  }
  if (url.protocol !== 'https:') throw new StatementsError(`a setup token must claim over https, this one says ${url.protocol}`);
  return url.href;
}

/**
 * fetch() refuses a URL with credentials in it, and SimpleFIN puts them there:
 * `https://user:pass@bridge/simplefin`. Split them into a Basic header.
 */
export function splitAccessUrl(accessUrl: string): { base: string; authorization: string } {
  let url: URL;
  try {
    url = new URL(accessUrl.trim());
  } catch {
    throw new StatementsError('the SimpleFIN access URL is not a URL');
  }
  if (url.protocol !== 'https:') throw new StatementsError('the SimpleFIN access URL must be https');
  if (!url.username) throw new StatementsError('the SimpleFIN access URL carries no credentials');
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  url.username = '';
  url.password = '';
  return { base: url.href.replace(/\/+$/, ''), authorization: `Basic ${Buffer.from(credentials).toString('base64')}` };
}

export async function claimSetupToken(token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const claimUrl = decodeSetupToken(token);
  const response = await fetchImpl(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, redirect: 'error' });
  const body = (await response.text()).trim();
  if (response.status === 403) throw new StatementsError('the bridge refused the claim: a setup token works once, and this one was used or revoked');
  if (!response.ok) throw new StatementsError(`the bridge answered ${response.status} to the claim: ${body.slice(0, 200)}`);
  splitAccessUrl(body);
  return body;
}

/** One request. The Bridge allows about 24 a day per connection, so callers cache the answer. */
export async function fetchSimplefinAccounts(accessUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ accounts: Account[]; errors: string[] }> {
  const { base, authorization } = splitAccessUrl(accessUrl);
  const response = await fetchImpl(`${base}/accounts?balances-only=1`, { headers: { Authorization: authorization }, redirect: 'error' });
  if (response.status === 403) throw new StatementsError('SimpleFIN refused the access URL (403): it was revoked, or the bridge subscription lapsed');
  if (!response.ok) throw new StatementsError(`SimpleFIN answered ${response.status}`);
  return parseSimplefinAccounts(await response.json());
}

export function coinpayAccounts(run: typeof spawnSync = spawnSync): Account[] {
  const result = run('coinpay', ['finances', 'accounts', '--json'], { encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw new StatementsError(`could not run coinpay: ${result.error.message}`);
  const stdout = String(result.stdout ?? '');
  if (result.status !== 0) {
    const reason = `${String(result.stderr ?? '')}${stdout}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
    throw new StatementsError(`coinpay finances accounts failed: ${reason || `exit ${result.status}`} (run \`coinpay login\`)`);
  }
  return parseCoinpayAccounts(JSON.parse(stdout));
}

// ---------------------------------------------------------------------------
// Drivers: where each bank keeps its statements
// ---------------------------------------------------------------------------

export interface Driver {
  key: string;
  name: string;
  /** Where a person signs in. */
  login: string;
  /** A statements page that is known to be reachable directly once signed in. */
  statements?: string;
}

/**
 * Sign-in pages for the banks most SimpleFIN users hold. The statements page
 * itself is learnt: whatever page the person closes the `login` window on is
 * where `fetch` starts, so a bank not listed here works the same way, starting
 * from the site SimpleFIN names for it.
 */
export const DRIVERS: readonly Driver[] = [
  { key: 'chase', name: 'Chase', login: 'https://secure.chase.com/web/auth/dashboard', statements: 'https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index;mode=documents' },
  { key: 'citi', name: 'Citi', login: 'https://online.citi.com/US/login.do' },
  { key: 'apple', name: 'Apple Card', login: 'https://card.apple.com/' },
  { key: 'americanexpress', name: 'American Express', login: 'https://www.americanexpress.com/en-us/account/login', statements: 'https://global.americanexpress.com/activity/statements' },
  { key: 'capitalone', name: 'Capital One', login: 'https://verified.capitalone.com/auth/signin' },
  { key: 'discover', name: 'Discover', login: 'https://portal.discover.com/customersvcs/universalLogin/ac_main' },
  { key: 'wellsfargo', name: 'Wells Fargo', login: 'https://connect.secure.wellsfargo.com/auth/login/present' },
  { key: 'bankofamerica', name: 'Bank of America', login: 'https://secure.bankofamerica.com/login/sign-in/signOnV2Screen.go' },
  { key: 'usbank', name: 'U.S. Bank', login: 'https://onlinebanking.usbank.com/auth/login/' },
  { key: 'dcu', name: 'DCU', login: 'https://digital.dcu.org/' },
];

export function driverFor(key: string): Driver | undefined {
  return DRIVERS.find((driver) => driver.key === key);
}

/** Where `login` opens and where `fetch` starts, best first. */
export function startUrls(institution: Pick<Institution, 'key' | 'url'>, learnt: string | undefined): { login: string | null; fetch: string | null } {
  const driver = driverFor(institution.key);
  return {
    login: driver?.login ?? institution.url,
    fetch: learnt ?? driver?.statements ?? driver?.login ?? institution.url,
  };
}

/** A page a person would not want `fetch` to start from. */
export function isSignInUrl(url: string): boolean {
  return /log-?in|log-?on|sign-?in|sign-?on|logout|log-?off|sign-?off|auth\/(login|signin)|universallogin/i.test(url);
}

// ---------------------------------------------------------------------------
// Dates, periods and filing
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface DateFound {
  /** YYYY-MM-DD; a month-only date is the 1st. */
  date: string;
  /** Day known, or only the month. */
  precise: boolean;
}

function iso(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return date.toISOString().slice(0, 10);
}

function fullYear(value: string): number {
  const year = Number(value);
  return value.length === 2 ? 2000 + year : year;
}

/** Every date in a piece of statement text or a file name, in the order written. */
export function findDates(source: string): DateFound[] {
  const found: { at: number; value: DateFound }[] = [];
  const add = (at: number, date: string | null, precise: boolean): void => {
    if (date) found.push({ at, value: { date, precise } });
  };
  const monthIndex = (word: string): number => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
  const monthWord = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

  for (const match of source.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) add(match.index, iso(+match[1]!, +match[2]!, +match[3]!), true);
  for (const match of source.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g)) add(match.index, iso(+match[1]!, +match[2]!, +match[3]!), true);
  for (const match of source.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g)) add(match.index, iso(fullYear(match[3]!), +match[1]!, +match[2]!), true);
  for (const match of source.matchAll(new RegExp(`(?<![a-z])${monthWord}\\.?[\\s_-]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s_-]+(\\d{4})(?!\\d)`, 'gi'))) {
    add(match.index, iso(+match[3]!, monthIndex(match[1]!), +match[2]!), true);
  }
  for (const match of source.matchAll(new RegExp(`(?<![a-z])${monthWord}\\.?[\\s_,-]+(\\d{4})(?!\\d)`, 'gi'))) {
    add(match.index, iso(+match[2]!, monthIndex(match[1]!), 1), false);
  }
  for (const match of source.matchAll(/(?<!\d)(\d{4})-(\d{2})(?![-\d])/g)) add(match.index, iso(+match[1]!, +match[2]!, 1), false);

  found.sort((a, b) => a.at - b.at);
  // "Aug 15, 2026" also matched as "15, 2026"-less "Aug ... 2026": keep the precise one.
  return found
    .filter((entry, index, all) => entry.value.precise || !all.some((other) => other.value.precise && other.value.date.slice(0, 7) === entry.value.date.slice(0, 7) && Math.abs(other.at - entry.at) < 20))
    .map((entry) => entry.value);
}

export interface Period {
  /** YYYY-MM: the month the statement closed in. */
  month: string;
  /** The statement's own range when the text gave one; `to` is the closing date. */
  from: string | null;
  to: string | null;
}

/**
 * The period a statement covers. A statement names its closing date; a range
 * ("07/16/2026 - 08/15/2026") gives both ends. The month is the closing one,
 * which is the month every bank files the statement under.
 */
export function periodOf(...sources: readonly (string | null | undefined)[]): Period | null {
  for (const source of sources) {
    if (!source) continue;
    const dates = findDates(source);
    if (!dates.length) continue;
    const precise = dates.filter((entry) => entry.precise).map((entry) => entry.date).sort();
    if (precise.length >= 2) {
      const from = precise[0]!;
      const to = precise[precise.length - 1]!;
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      if (days >= 20 && days <= 100) return { month: to.slice(0, 7), from, to };
    }
    const latest = dates.map((entry) => entry.date).sort().at(-1)!;
    return { month: latest.slice(0, 7), from: null, to: precise.includes(latest) ? latest : null };
  }
  return null;
}

/** The account a statement belongs to: by the last four digits it shows, or the only account there is. */
export function matchAccount(accounts: readonly Account[], ...sources: readonly (string | null | undefined)[]): Account | null {
  if (accounts.length === 1) return accounts[0]!;
  const known = accounts.filter((entry) => entry.last4);
  for (const source of sources) {
    if (!source) continue;
    const hits = known.filter((entry) => new RegExp(`(?<!\\d)${entry.last4}(?!\\d)`).test(source));
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

export function accountDir(entry: Account): string {
  const name = slug(entry.name);
  return entry.last4 && !name.includes(entry.last4) ? `${name}-${entry.last4}` : name;
}

// ---------------------------------------------------------------------------
// State and the manifest
// ---------------------------------------------------------------------------

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'cli-tools', 'statements');
}

export function defaultOutDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STATEMENTS_DIR || join(homedir(), 'Documents', 'statements');
}

export interface InstitutionState {
  start?: string;
  loggedInAt?: string;
  lastFetchAt?: string;
  lastStatus?: string;
}

export interface State {
  accessUrl?: string;
  accounts?: { at: string; source: AccountSource; accounts: Account[] };
  institutions: Record<string, InstitutionState>;
}

/** Bank sessions and a bank-read credential live here: owner-only, written whole. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new StatementsError(`${path} is not valid JSON (${(error as Error).message}); fix or remove it`);
  }
}

export function loadState(dir: string = dataDir()): State {
  const state = readJson<State>(join(dir, 'state.json'), { institutions: {} });
  state.institutions ??= {};
  return state;
}

export function saveState(state: State, dir: string = dataDir()): void {
  writePrivateJson(join(dir, 'state.json'), state);
}

export interface ManifestEntry {
  sha256: string;
  /** Relative to the output directory. */
  path: string;
  institution: string;
  accountId: string | null;
  accountName: string | null;
  month: string | null;
  from: string | null;
  to: string | null;
  bytes: number;
  how: 'fetch' | 'assist';
  /** The label and row text the file was downloaded from, for a person checking the filing. */
  label: string;
  suggestedName: string;
  downloadedAt: string;
  /** Candidate key, so the same row is not clicked again. */
  key: string | null;
  coinpay?: { statementId: string; importedAt: string };
}

export interface Manifest {
  version: 1;
  entries: ManifestEntry[];
}

export function loadManifest(outDir: string): Manifest {
  const manifest = readJson<Manifest>(join(outDir, 'manifest.json'), { version: 1, entries: [] });
  manifest.entries ??= [];
  return manifest;
}

export function saveManifest(outDir: string, manifest: Manifest): void {
  writePrivateJson(join(outDir, 'manifest.json'), manifest);
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes('%PDF-');
}

/** The relative path a statement is filed under, never one already taken. */
export function filePath(institution: string, entry: Account | null, period: Period | null, suggestedName: string, taken: (relative: string) => boolean): string {
  const folder = entry ? join(institution, accountDir(entry)) : join(institution, '_unfiled');
  const stem = period && entry ? period.month : slug(basename(suggestedName, '.pdf')) || 'statement';
  for (let attempt = 1; ; attempt += 1) {
    const relative = join(folder, `${stem}${attempt === 1 ? '' : `-${attempt}`}.pdf`);
    if (!taken(relative)) return relative;
  }
}

export interface Downloaded {
  bytes: Uint8Array;
  suggestedName: string;
  label: string;
  context: string;
  key: string | null;
}

export type FileResult =
  | { status: 'filed'; entry: ManifestEntry }
  | { status: 'duplicate'; entry: ManifestEntry }
  | { status: 'not-pdf'; suggestedName: string };

/** Classify one download, write it under `outDir`, and add it to the manifest. */
export function fileStatement(outDir: string, manifest: Manifest, institution: Institution, download: Downloaded, how: ManifestEntry['how'], now: Date = new Date()): FileResult {
  if (!isPdf(download.bytes)) return { status: 'not-pdf', suggestedName: download.suggestedName };
  const hash = sha256(download.bytes);
  const existing = manifest.entries.find((entry) => entry.sha256 === hash);
  if (existing) return { status: 'duplicate', entry: existing };

  const matched = matchAccount(institution.accounts, download.context, download.suggestedName, download.label);
  const period = periodOf(download.context, download.suggestedName, download.label);
  const relative = filePath(institution.key, matched, period, download.suggestedName, (candidate) => existsSync(join(outDir, candidate)));
  const absolute = join(outDir, relative);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, download.bytes, { mode: 0o600 });

  const entry: ManifestEntry = {
    sha256: hash,
    path: relative,
    institution: institution.key,
    accountId: matched?.id ?? null,
    accountName: matched?.name ?? null,
    month: period?.month ?? null,
    from: period?.from ?? null,
    to: period?.to ?? null,
    bytes: download.bytes.length,
    how,
    label: download.label.slice(0, 200),
    suggestedName: download.suggestedName,
    downloadedAt: now.toISOString(),
    key: download.key,
  };
  manifest.entries.push(entry);
  return { status: 'filed', entry };
}

// ---------------------------------------------------------------------------
// CoinPay's statement library
// ---------------------------------------------------------------------------

/** The CoinPay account a manifest entry belongs to, by id, SimpleFIN id, or institution + last four. */
export function coinpayAccountFor(entry: ManifestEntry, accounts: readonly Account[], coinpay: readonly Account[]): Account | null {
  const local = accounts.find((candidate) => candidate.id === entry.accountId);
  if (!local) return null;
  if (local.coinpayId) return coinpay.find((candidate) => candidate.coinpayId === local.coinpayId) ?? local;
  const byExternal = coinpay.find((candidate) => candidate.externalId && candidate.externalId === local.externalId);
  if (byExternal) return byExternal;
  const byDigits = coinpay.filter((candidate) => candidate.institution === local.institution && candidate.last4 && candidate.last4 === local.last4);
  return byDigits.length === 1 ? byDigits[0]! : null;
}

/** The arguments for `coinpay finances statements import`. CoinPay's `--to` is exclusive. */
export function coinpayImportArgs(file: string, coinpayAccountId: string, entry: ManifestEntry, institutionName: string): string[] {
  const args = ['finances', 'statements', 'import', file, '--account', coinpayAccountId];
  if (entry.from && entry.to) {
    const end = new Date(`${entry.to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    args.push('--from', entry.from, '--to', end.toISOString().slice(0, 10), '--cycle', 'custom');
  } else if (entry.month) {
    args.push('--period', entry.month);
  } else {
    throw new StatementsError(`${entry.path} has no period; rename it to YYYY-MM.pdf or import it by hand`);
  }
  args.push('--institution', institutionName, '--json');
  return args;
}

// ---------------------------------------------------------------------------
// In-page scripts (run by Runtime.evaluate in the bank's own page)
// ---------------------------------------------------------------------------

/** True when the page is asking for a password: the session is gone. */
export const SIGNED_OUT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
  return docs.some((doc) => [...doc.querySelectorAll('input[type=password]')].some(visible));
})()`;

/** Follow the page's own "Statements" link, if it has one. Returns its label, or null. */
export const OPEN_STATEMENTS = `(() => {
  const want = /^(e-?)?statements?(\\s*(&|and)\\s*(documents|disclosures))?$|^(view |my )?statements?$|^documents$|^statements?\\s*&\\s*documents$/i;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  for (const el of document.querySelectorAll('a, button, [role=link], [role=tab], [role=menuitem]')) {
    const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (label.length < 40 && want.test(label) && visible(el)) { el.click(); return label; }
  }
  return null;
})()`;

/**
 * Every control that looks like it downloads one dated statement. Each is
 * tagged with data-stmt-i so CLICK can find it again; the row text around it
 * is what dates the statement and names the account.
 */
export const COLLECT = `(() => {
  const DATE = /((?<![a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+(\\d{1,2},?\\s+)?\\d{4}\\b)|(\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b)|(\\b\\d{4}-\\d{2}(-\\d{2})?\\b)/i;
  const SKIP = /preference|paperless|setting|notification|tax form|1099|privacy|agreement|terms|help|learn more|go paperless|enroll/i;
  const ACTION = /statement|download|pdf|view|open|save/i;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  // innerText keeps the break between table cells; textContent runs "1234" into "July".
  const textOf = (el) => clean(el.innerText || el.textContent);
  const rowOf = (el) => {
    const row = el.closest('tr, li, [role=row], [role=listitem], article');
    if (row && textOf(row).length < 400) return row;
    let node = el;
    for (let i = 0; i < 4 && node.parentElement; i += 1) {
      node = node.parentElement;
      if (DATE.test(textOf(node)) && textOf(node).length < 300) return node;
    }
    return el;
  };
  const docs = [document];
  for (let i = 0; i < docs.length; i += 1) {
    for (const frame of docs[i].querySelectorAll('iframe, frame')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
  }
  const out = [];
  let index = 0;
  for (const doc of docs) {
    for (const el of doc.querySelectorAll('a, button, [role=button], [role=link]')) {
      if (!visible(el)) continue;
      const label = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent);
      const href = el.getAttribute('href') || '';
      const pdf = /\\.pdf(\\b|$)/i.test(href);
      if (!pdf && !ACTION.test(label)) continue;
      if (SKIP.test(label)) continue;
      const context = textOf(rowOf(el)).slice(0, 300);
      if (!DATE.test(label + ' ' + context + ' ' + href)) continue;
      el.setAttribute('data-stmt-i', String(index));
      let absolute = null;
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) { try { absolute = new URL(href, doc.baseURI).href; } catch {} }
      out.push({ index, label: label.slice(0, 120), context, href: absolute });
      index += 1;
    }
  }
  return JSON.stringify(out);
})()`;

export function clickScript(index: number): string {
  return `(() => {
  const docs = [document];
  for (let i = 0; i < docs.length; i += 1) {
    for (const frame of docs[i].querySelectorAll('iframe, frame')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
  }
  for (const doc of docs) { const el = doc.querySelector('[data-stmt-i="${index}"]'); if (el) { el.click(); return true; } }
  return false;
})()`;
}

/** A click that opened a dialog instead of downloading: press its Download button. */
export const SECOND_STEP = `(() => {
  const want = /^(download( pdf| statement)?|pdf|save( pdf)?|view pdf)$/i;
  for (const el of document.querySelectorAll('[role=dialog] button, [role=dialog] a, dialog button, dialog a, .modal button, .modal a, button, a')) {
    const r = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (r.width > 0 && r.height > 0 && want.test(label) && !el.hasAttribute('data-stmt-i')) { el.click(); return label; }
  }
  return null;
})()`;

/** In `assist`, remember the row text of whatever the person clicked last, to file the download that follows. */
export const CLICK_RECORDER = `document.addEventListener('click', (event) => {
  const el = event.target instanceof Element ? event.target.closest('a, button, [role=button], [role=link]') || event.target : null;
  if (!el) return;
  const row = el.closest('tr, li, [role=row], [role=listitem], article') || el.parentElement || el;
  window.__statementsLastClick = JSON.stringify({
    label: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    context: (row.innerText || row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
  });
}, true);`;

/** The stable identity of a candidate: its link, else its label and the date in its row. */
export function candidateKey(candidate: { label: string; context: string; href: string | null }): string {
  if (candidate.href && !/[?&](token|session|nonce|ts|_)=/i.test(candidate.href)) return candidate.href;
  const period = periodOf(candidate.context, candidate.label);
  return `${candidate.label}|${period ? `${period.month}|${period.to ?? ''}` : candidate.context.slice(0, 80)}`;
}

/**
 * Make Chrome download a PDF instead of showing it. Without this a statement
 * link in a window opens the built-in viewer, and nothing is ever saved.
 */
export function preferPdfDownloads(profile: string): void {
  const path = join(profile, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      prefs = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      prefs = {};
    }
  }
  const plugins = (prefs.plugins ?? {}) as Record<string, unknown>;
  const download = (prefs.download ?? {}) as Record<string, unknown>;
  if (plugins.always_open_pdf_externally === true && download.prompt_for_download === false) return;
  prefs.plugins = { ...plugins, always_open_pdf_externally: true };
  prefs.download = { ...download, prompt_for_download: false };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(prefs));
}
