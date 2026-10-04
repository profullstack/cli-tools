#!/usr/bin/env node
/**
 * statements — download the PDF statements behind every SimpleFIN account.
 *
 *   statements accounts                   the institutions and accounts, and which are signed in
 *   statements login chase                sign in once, in a window; the session is kept
 *   statements fetch                      every new statement from every signed-in bank
 *   statements fetch --import coinpay     ...and keep each in CoinPay's statement library
 *
 * src/statements.ts says why this exists and what it never stores.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  type Account,
  type AccountSource,
  type Institution,
  type State,
  StatementsError,
  claimSetupToken,
  coinpayAccountFor,
  coinpayAccounts,
  coinpayImportArgs,
  dataDir,
  defaultOutDir,
  fetchSimplefinAccounts,
  groupInstitutions,
  loadManifest,
  loadState,
  saveManifest,
  saveState,
  startUrls,
} from '../src/statements.ts';
import { assistWindow, fetchInstitution, loginWindow, openBrowser } from '../src/statements-run.ts';
import { NO_CHROME, WcagError, findChrome } from '../src/wcag.ts';

const USAGE = `Usage:
  statements accounts [--from simplefin|coinpay] [--refresh] [--json]
                                  institutions and accounts, with each bank's sign-in and last fetch
  statements claim <setup-token>  connect to SimpleFIN with a token from the Bridge (optional: without
                                  one, the account list comes from \`coinpay finances accounts\`)
  statements login <bank> [--url URL]
                                  open the bank in a window to sign in once. Go on to the page that
                                  lists statements before closing it: that page is where fetch starts
  statements fetch [bank…] [options]
                                  download every statement not already on disk, from every signed-in
                                  bank (or the ones named)
  statements assist <bank>        a window on the statements page; every PDF you download is filed
  statements list [--json]        the statements on disk
  statements import coinpay [-n]  keep every filed statement in CoinPay's statement library

Options:
  --out DIR            where statements are filed (default: STATEMENTS_DIR, else ~/Documents/statements)
  --since YYYY-MM      fetch: skip statements that closed before this month
  --max N              fetch: at most N new statements per bank (default: 24)
  --headed             fetch: show the window (headless by default)
  --render S           fetch: seconds a statements page gets to show its list (default: 25)
  --import coinpay     fetch: import what was filed into CoinPay (\`coinpay login\` first)
  --from SOURCE        where accounts come from: simplefin (an access URL) or coinpay
  --refresh            ask SimpleFIN again instead of using the list from the last 12 hours
  --chrome PATH        the browser to use (default: CHROME_PATH, then the usual places)
  -n, --dry-run        import: say what would be imported
  --json               machine-readable output
  --help               show this help

Files land as <out>/<bank>/<account>/<YYYY-MM>.pdf with <out>/manifest.json
listing each one's hash, account and period. Nothing here asks for or keeps a
bank password: each bank has its own Chrome profile under
${dataDir()}/profiles, signed in by you. When a bank ends
that session, fetch says so and moves on; run \`statements login <bank>\` again.

Exit status: 0 when every bank fetched, 3 when any needs a sign-in or showed no
statements (so a cron job can tell you), 2 on a usage error.

  SIMPLEFIN_ACCESS_URL   a SimpleFIN access URL, instead of \`statements claim\`
  STATEMENTS_DIR         the default --out
  CHROME_PATH            a Chrome or Chromium binary
`;

const ACCOUNTS_TTL_MS = 12 * 60 * 60 * 1000;

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function hasCoinpay(): boolean {
  return spawnSync('sh', ['-c', 'command -v coinpay'], { stdio: 'ignore' }).status === 0;
}

async function loadAccounts(state: State, from: string | undefined, refresh: boolean): Promise<{ accounts: Account[]; source: AccountSource; cached: boolean; errors: string[] }> {
  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL || state.accessUrl;
  if (from && from !== 'simplefin' && from !== 'coinpay') throw new UsageError('--from is simplefin or coinpay');
  const source: AccountSource | null = (from as AccountSource | undefined) ?? (accessUrl ? 'simplefin' : hasCoinpay() ? 'coinpay' : null);
  if (!source) {
    throw new StatementsError('no account list: run `statements claim <setup-token>` with a token from the SimpleFIN Bridge, set SIMPLEFIN_ACCESS_URL, or install and log in to coinpay');
  }

  const cache = state.accounts;
  if (!refresh && cache && cache.source === source && Date.now() - Date.parse(cache.at) < ACCOUNTS_TTL_MS) {
    return { accounts: cache.accounts, source, cached: true, errors: [] };
  }

  let accounts: Account[];
  let errors: string[] = [];
  if (source === 'simplefin') {
    if (!accessUrl) throw new StatementsError('--from simplefin needs `statements claim <setup-token>` or SIMPLEFIN_ACCESS_URL');
    ({ accounts, errors } = await fetchSimplefinAccounts(accessUrl));
  } else {
    accounts = coinpayAccounts();
  }
  state.accounts = { at: new Date().toISOString(), source, accounts };
  saveState(state);
  return { accounts, source, cached: false, errors };
}

/** A bank named on the command line: its key, or the start of its key or name. */
function pick(institutions: readonly Institution[], name: string): Institution {
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const exact = institutions.find((entry) => entry.key === wanted);
  if (exact) return exact;
  const loose = institutions.filter((entry) => entry.key.startsWith(wanted) || entry.name.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(wanted));
  if (loose.length === 1) return loose[0]!;
  const known = institutions.map((entry) => entry.key).join(', ');
  throw new UsageError(loose.length ? `"${name}" matches ${loose.map((entry) => entry.key).join(', ')}; be more specific` : `no bank called "${name}" in the account list (${known || 'which is empty'})`);
}

function profileDir(key: string): string {
  return join(dataDir(), 'profiles', key);
}

function chromePath(values: Map<string, string>): string {
  const chrome = values.get('--chrome') ?? findChrome();
  if (!chrome) throw new StatementsError(NO_CHROME);
  return chrome;
}

function signedIn(key: string): boolean {
  return existsSync(join(profileDir(key), 'Default'));
}

function ago(iso: string | undefined): string {
  if (!iso) return 'never';
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function commandAccounts(flags: Set<string>, values: Map<string, string>): Promise<number> {
  const state = loadState();
  const { accounts, source, cached, errors } = await loadAccounts(state, values.get('--from'), flags.has('--refresh'));
  const institutions = groupInstitutions(accounts);
  if (flags.has('--json')) {
    out(JSON.stringify({ source, cached, errors, institutions: institutions.map((entry) => ({ ...entry, signedIn: signedIn(entry.key), ...state.institutions[entry.key] })) }, null, 2));
    return 0;
  }
  out(`${plural(accounts.length, 'account')} at ${plural(institutions.length, 'institution')}, from ${source}${cached ? ' (cached; --refresh to ask again)' : ''}\n`);
  for (const entry of institutions) {
    const known = state.institutions[entry.key] ?? {};
    const session = signedIn(entry.key) ? `signed in ${ago(known.loggedInAt)}` : 'not signed in';
    out(`${entry.key}  ${entry.name}  ·  ${session}  ·  last fetch ${ago(known.lastFetchAt)}${known.lastStatus ? ` (${known.lastStatus})` : ''}`);
    for (const item of entry.accounts) out(`    ${item.name}${item.last4 ? '' : '  (no last four digits: statements will need filing by hand)'}`);
  }
  for (const message of errors) err(`simplefin: ${message}`);
  const missing = institutions.filter((entry) => !signedIn(entry.key)).map((entry) => entry.key);
  if (missing.length) out(`\nNext: statements login ${missing[0]}${missing.length > 1 ? `   (then ${missing.slice(1).join(', ')})` : ''}`);
  return 0;
}

async function commandClaim(positional: string[]): Promise<number> {
  const token = positional[0];
  if (!token) throw new UsageError('claim takes the setup token the SimpleFIN Bridge gave you');
  const state = loadState();
  state.accessUrl = await claimSetupToken(token);
  delete state.accounts;
  saveState(state);
  out(`claimed; the access URL is kept in ${join(dataDir(), 'state.json')} (owner-only). Next: statements accounts`);
  return 0;
}

async function commandLogin(positional: string[], values: Map<string, string>): Promise<number> {
  if (positional.length !== 1) throw new UsageError('login takes one bank');
  const state = loadState();
  const { accounts } = await loadAccounts(state, values.get('--from'), false);
  const institution = pick(groupInstitutions(accounts), positional[0]!);
  const url = values.get('--url') ?? startUrls(institution, undefined).login;
  if (!url) throw new StatementsError(`SimpleFIN gives no site for ${institution.name}; pass --url with its sign-in page`);

  out(`Opening ${institution.name}. Sign in, then go to the page that lists your statements and close the window.`);
  const browser = await openBrowser({ chrome: chromePath(values), profile: profileDir(institution.key), headless: false });
  const last = await loginWindow(browser, url);
  const known = (state.institutions[institution.key] ??= {});
  known.loggedInAt = new Date().toISOString();
  if (last) known.start = last;
  saveState(state);
  out(last ? `Saved. fetch will start at ${last}` : 'Saved. The window closed on a sign-in page, so fetch will start from the bank\'s known statements page.');
  return 0;
}

function since(values: Map<string, string>): string | null {
  const value = values.get('--since');
  if (value === undefined) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new UsageError('--since is YYYY-MM');
  return value;
}

async function commandFetch(positional: string[], flags: Set<string>, values: Map<string, string>): Promise<number> {
  const importTo = values.get('--import');
  if (importTo !== undefined && importTo !== 'coinpay') throw new UsageError('--import takes coinpay');
  const outDir = values.get('--out') ?? defaultOutDir();
  const max = integer(values, '--max', 24, { min: 1, max: 500 });
  const renderMs = integer(values, '--render', 25, { min: 3, max: 300 }) * 1000;
  const from = since(values);

  const state = loadState();
  const { accounts } = await loadAccounts(state, values.get('--from'), flags.has('--refresh'));
  const institutions = groupInstitutions(accounts);
  const chosen = positional.length ? positional.map((name) => pick(institutions, name)) : institutions.filter((entry) => signedIn(entry.key));
  if (!chosen.length) throw new StatementsError(`no bank is signed in yet. Start with: statements login ${institutions[0]?.key ?? '<bank>'}`);

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifest = loadManifest(outDir);
  const chrome = chromePath(values);
  const json = flags.has('--json');
  const log = json ? (): void => undefined : out;
  const summary: { bank: string; status: string; filed: number; duplicates: number; silent: number; candidates: number; url?: string; error?: string }[] = [];

  for (const institution of chosen) {
    const known = (state.institutions[institution.key] ??= {});
    const start = startUrls(institution, known.start).fetch;
    log(`${institution.key}: ${start ?? 'no start page'}`);
    if (!signedIn(institution.key) || !start) {
      summary.push({ bank: institution.key, status: 'login-needed', filed: 0, duplicates: 0, silent: 0, candidates: 0 });
      log(`  not signed in: statements login ${institution.key}`);
      continue;
    }
    let browser;
    try {
      browser = await openBrowser({ chrome, profile: profileDir(institution.key), headless: !flags.has('--headed') });
      const result = await fetchInstitution(browser, institution, { start, outDir, manifest, since: from, max, renderMs, log });
      const filed = result.results.filter((item) => item.status === 'filed').length;
      const duplicates = result.results.filter((item) => item.status === 'duplicate').length;
      summary.push({ bank: institution.key, status: result.status, filed, duplicates, silent: result.silent.length, candidates: result.candidates, url: result.url });
      if (result.status === 'login-needed') log(`  the session ended (the page asks for a password): statements login ${institution.key}`);
      else if (result.status === 'no-statements') log(`  no statement links found at ${result.url}. Sign in again and close the window on the statements list, or use: statements assist ${institution.key}`);
      else log(`  ${result.candidates} on the page, ${filed} new, ${duplicates} already had${result.silent.length ? `, ${result.silent.length} clicked without a download` : ''}`);
      for (const label of result.silent) log(`  ? no download from: ${label}`);
      known.lastStatus = result.status === 'ok' ? `${filed} new` : result.status;
    } catch (error) {
      const message = (error as Error).message;
      summary.push({ bank: institution.key, status: 'error', filed: 0, duplicates: 0, silent: 0, candidates: 0, error: message });
      log(`  failed: ${message}`);
      known.lastStatus = 'error';
    } finally {
      await browser?.close();
      known.lastFetchAt = new Date().toISOString();
      saveManifest(outDir, manifest);
      saveState(state);
    }
  }

  let imported: ImportSummary | null = null;
  if (importTo === 'coinpay') imported = importCoinpay(outDir, state, false, log);
  if (json) out(JSON.stringify({ outDir, banks: summary, imported }, null, 2));
  return summary.every((item) => item.status === 'ok') && (!imported || imported.failed.length === 0) ? 0 : 3;
}

async function commandAssist(positional: string[], values: Map<string, string>): Promise<number> {
  if (positional.length !== 1) throw new UsageError('assist takes one bank');
  const outDir = values.get('--out') ?? defaultOutDir();
  const state = loadState();
  const { accounts } = await loadAccounts(state, values.get('--from'), false);
  const institution = pick(groupInstitutions(accounts), positional[0]!);
  const start = startUrls(institution, state.institutions[institution.key]?.start).fetch;
  if (!start) throw new StatementsError(`no page to start ${institution.name} from; run statements login ${institution.key} --url <its sign-in page>`);

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifest = loadManifest(outDir);
  out(`Opening ${institution.name}. Download each statement you want; each is filed as it lands. Close the window when done.`);
  const browser = await openBrowser({ chrome: chromePath(values), profile: profileDir(institution.key), headless: false });
  try {
    const results = await assistWindow(browser, institution, { start, outDir, manifest, log: out, save: () => saveManifest(outDir, manifest) });
    out(`${results.filter((item) => item.status === 'filed').length} filed under ${outDir}`);
  } finally {
    await browser.close();
    saveManifest(outDir, manifest);
  }
  return 0;
}

function commandList(flags: Set<string>, values: Map<string, string>): number {
  const outDir = values.get('--out') ?? defaultOutDir();
  const manifest = loadManifest(outDir);
  if (flags.has('--json')) {
    out(JSON.stringify({ outDir, entries: manifest.entries }, null, 2));
    return 0;
  }
  if (!manifest.entries.length) {
    out(`no statements in ${outDir} yet`);
    return 0;
  }
  const rows = [...manifest.entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of rows) out(`${entry.path}  ${entry.month ?? '????-??'}  ${entry.coinpay ? `coinpay ${entry.coinpay.statementId}` : ''}`.trimEnd());
  out(`\n${rows.length} statements in ${outDir}; ${rows.filter((entry) => !entry.accountId).length} unfiled, ${rows.filter((entry) => entry.coinpay).length} in CoinPay`);
  return 0;
}

interface ImportSummary {
  imported: string[];
  skipped: string[];
  failed: string[];
}

function importCoinpay(outDir: string, state: State, dryRun: boolean, log: (line: string) => void): ImportSummary {
  const manifest = loadManifest(outDir);
  const pending = manifest.entries.filter((entry) => !entry.coinpay);
  const summary: ImportSummary = { imported: [], skipped: [], failed: [] };
  if (!pending.length) {
    log('coinpay: nothing new to import');
    return summary;
  }
  const coinpay = coinpayAccounts();
  const accounts = state.accounts?.accounts ?? coinpay;
  const names = new Map(groupInstitutions(accounts).map((entry) => [entry.key, entry.name]));

  for (const entry of pending) {
    const target = entry.accountId ? coinpayAccountFor(entry, accounts, coinpay) : null;
    if (!target?.coinpayId) {
      summary.skipped.push(entry.path);
      log(`coinpay: skip ${entry.path} (${entry.accountId ? 'no matching CoinPay account' : 'account not recognised'})`);
      continue;
    }
    let args: string[];
    try {
      args = coinpayImportArgs(join(outDir, entry.path), target.coinpayId, entry, names.get(entry.institution) ?? entry.institution);
    } catch (error) {
      summary.skipped.push(entry.path);
      log(`coinpay: skip ${entry.path} (${(error as Error).message})`);
      continue;
    }
    if (dryRun) {
      summary.imported.push(entry.path);
      log(`coinpay: would run coinpay ${args.join(' ')}`);
      continue;
    }
    const result = spawnSync('coinpay', args, { encoding: 'utf8', timeout: 120_000 });
    const id = parseImported(String(result.stdout ?? ''));
    if (result.status !== 0 || !id) {
      summary.failed.push(entry.path);
      log(`coinpay: failed ${entry.path}: ${`${result.stderr ?? ''}${result.stdout ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 300)}`);
      continue;
    }
    entry.coinpay = { statementId: id, importedAt: new Date().toISOString() };
    summary.imported.push(entry.path);
    log(`coinpay: ${entry.path} → ${id}`);
    saveManifest(outDir, manifest);
  }
  return summary;
}

export function parseImported(stdout: string): string | null {
  try {
    const data = JSON.parse(stdout) as { statement?: { id?: unknown } };
    return typeof data.statement?.id === 'string' ? data.statement.id : null;
  } catch {
    return null;
  }
}

function commandImport(positional: string[], flags: Set<string>, values: Map<string, string>): number {
  if (positional[0] !== 'coinpay') throw new UsageError('import takes one destination: coinpay');
  const outDir = values.get('--out') ?? defaultOutDir();
  const summary = importCoinpay(outDir, loadState(), flags.has('--dry-run') || flags.has('-n'), out);
  out(`${summary.imported.length} imported, ${summary.skipped.length} skipped, ${summary.failed.length} failed`);
  return summary.failed.length ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const { flags, values, positional } = parseArgs(argv, {
    boolean: ['--json', '--help', '-h', '--refresh', '--headed', '--dry-run', '-n'],
    string: ['--out', '--since', '--max', '--render', '--import', '--from', '--chrome', '--url'],
  });
  const [command, ...rest] = positional;
  if (flags.has('--help') || flags.has('-h') || !command) {
    out(USAGE);
    return command || flags.has('--help') || flags.has('-h') ? 0 : 2;
  }
  switch (command) {
    case 'accounts':
      return commandAccounts(flags, values);
    case 'claim':
      return commandClaim(rest);
    case 'login':
      return commandLogin(rest, values);
    case 'fetch':
      return commandFetch(rest, flags, values);
    case 'assist':
      return commandAssist(rest, values);
    case 'list':
      return commandList(flags, values);
    case 'import':
      return commandImport(rest, flags, values);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

if (isMain(import.meta.url)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`statements: ${error.message}\n\n${USAGE}`);
      process.exit(2);
    }
    process.stderr.write(`statements: ${(error as Error).message}\n`);
    process.exit(error instanceof StatementsError || error instanceof WcagError ? 2 : 1);
  }
}
