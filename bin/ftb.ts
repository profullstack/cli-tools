#!/usr/bin/env node
/**
 * ftb — create and activate MyFTB accounts, business and personal, from the
 * returns already on disk.
 *
 *   ftb secrets                                  what each return can prove, best first
 *   ftb register business --email a@b.c --dry-run
 *   ftb register business --email a@b.c --declare
 *   ftb register personal --email a@b.c --declare
 *   ftb activate business --pin 1234             after the PIN letter arrives
 *   ftb status
 *
 * src/ftb.ts says why it works this way.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UsageError, parseArgs } from '../src/args.ts';
import {
  type Account,
  type BusinessSecret,
  type Extracted,
  FtbError,
  LOGIN_URL,
  type PersonalSecret,
  type Plan,
  REGISTER_URL,
  ROLES,
  type Role,
  type State,
  VAULT,
  addressNumbers,
  businessSecrets,
  formatAmount,
  generatePassword,
  generateUsername,
  handoffCard,
  latestIdentity,
  maskSsn,
  parseExtracted,
  personalSecrets,
  rulesFor,
  statePath,
  toEnvFile,
  vaultKeys,
} from '../src/ftb.ts';
import { goto, openSession, walk } from '../src/ftb-run.ts';
import { isMain } from '../src/is-main.ts';
import { pullVault } from '../src/vault.ts';
import { WcagError } from '../src/wcag.ts';

const DEFAULT_DIR = join(homedir(), 'dottemplates', 'docs', 'taxes', 'years');

const USAGE = `Usage:
  ftb secrets [--dir D] [--json]       the shared secrets each filed CA return supports, best first
  ftb register <business|personal>     create the MyFTB account in headless Chrome
  ftb activate <business|personal>     log in and enter the PIN from FTB's letter
  ftb status                           which accounts exist, and what each is waiting on

register options:
  --email ADDR         where FTB sends the confirmation (required)
  --declare            tick the penalty-of-perjury box: your statement that the values are true
  --dry-run            fill the first form page, print it, submit nothing
  --year YYYY          use this tax year's return instead of the newest
  --line 15|20         business: which 100S line is the net income (default 20)
  --amount=N           override the amount (a loss is --amount=-12345)
  --phone N            10 digits FTB texts a verification code to (required)
  --call               have FTB phone the code in instead of texting it

activate options:
  --pin N              the PIN from the letter (21 days from registration)

Common:
  --dir D              where the returns are (default: ${DEFAULT_DIR})
  --headful            show the browser (needs a display)
  --chrome PATH        the browser to use (default: CHROME_PATH, then the usual places)
  --no-handoff         do not post the PIN-letter card to myna
  --no-vault           keep the login only in ${statePath()}

One shared secret is sent per run. When FTB says it does not match, the run
stops and \`ftb secrets\` lists what else the returns support; nothing is retried
on its own. Logins go to the ${VAULT.project} vault (${VAULT.team}) and a 0600
state file; the myna card carries steps only, never a PIN, password or SSN.
`;

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

// ---------------------------------------------------------------------------

const EXTRACTOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ftb-extract.py');

export function extract(dir: string): Extracted[] {
  if (!existsSync(dir)) throw new FtbError(`${dir} does not exist; point --dir at the folder of returns`);
  const result = spawnSync('python3', [EXTRACTOR, dir], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw new FtbError(`python3 is needed to read the returns: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-2).join(' ');
    throw new FtbError(/No module named 'pymupdf'/.test(detail) ? 'PyMuPDF is needed to read the returns: pip install pymupdf' : `ftb-extract.py failed: ${detail}`);
  }
  return parseExtracted(result.stdout);
}

function loadState(path = statePath()): State {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as State;
  } catch {
    return { accounts: {} };
  }
}

function saveState(state: State, path = statePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Pull the ftb vault, merge this account in, push it back. The plaintext lives for one call in a 0700 dir. */
function pushVault(account: Account): void {
  let current: Record<string, string> = {};
  try {
    current = pullVault(VAULT);
  } catch {
    // A vault that does not exist yet is created by the push.
  }
  const dir = mkdtempSync(join(tmpdir(), 'ftb-vault-'));
  try {
    const envPath = join(dir, 'ftb.env');
    writeFileSync(envPath, toEnvFile({ ...current, ...vaultKeys(account) }), { mode: 0o600 });
    const result = spawnSync('logicsrc', ['teams', 'push', VAULT.team, VAULT.project, VAULT.env, '--env', envPath], { encoding: 'utf8' });
    if (result.status !== 0) throw new FtbError(`logicsrc teams push failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Post the PIN-letter card to myna; returns its URL, or null when myna is not there. */
function postHandoff(role: Role, at: Date): string | null {
  const card = handoffCard(role, at);
  const args = ['handoff', 'add', 'ftb', '--title', card.title, '--open', LOGIN_URL, ...card.steps.flatMap((step) => ['--step', step])];
  const result = spawnSync('myna', args, { input: card.text, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  // Signed out of myna cloud the card is kept locally and there is no link to record.
  return result.stdout.match(/https:\/\/\S+\/handoff\/\S+/)?.[0] ?? null;
}

/** The message on an FTB result page: its body text between the header and the footer. */
function pageMessage(text: string): string {
  const body = text.replace(/^.*?Franchise Tax Board\s*(e-Services)?/s, '').replace(/Back to top.*$|Copyright ©.*$/s, '').trim();
  return body.slice(0, 600) || 'the information does not match';
}

// ---------------------------------------------------------------------------

function formatSecrets(rows: Extracted[]): string {
  const lines: string[] = [];
  const business = businessSecrets(rows);
  const personal = personalSecrets(rows);
  const identity = latestIdentity(rows);
  lines.push('Business (Form 100S), best first:');
  if (!business.length) lines.push('  none found');
  for (const s of business) lines.push(`  ${s.year}  100S  line ${s.line}  ${formatAmount(s.amount).padStart(9)}  corp ${s.corpId}  ${s.source}`);
  lines.push('', 'Personal (Form 540, line 17 CA AGI), best first:');
  if (!personal.length) lines.push('  none found');
  for (const s of personal) lines.push(`  ${s.year}  540  ${s.filingStatus.padEnd(18)} ${formatAmount(s.amount).padStart(9)}  ${s.source}`);
  if (identity) {
    lines.push('', `Identity (${identity.year} 540): ${identity.firstName} ${identity.lastName}, SSN ${maskSsn(identity.ssn!)}, ${identity.street} ${identity.zip}`);
  }
  return lines.join('\n');
}

function chooseSecret<T extends BusinessSecret | PersonalSecret>(all: T[], year: number | undefined, line: number | undefined): T {
  const found = all.find((s) => (year === undefined || s.year === year) && (line === undefined || !('line' in s) || s.line === line));
  if (!found) throw new FtbError(`no return matches${year ? ` year ${year}` : ''}${line ? ` line ${line}` : ''}; see \`ftb secrets\``);
  return found;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    boolean: ['--help', '-h', '--json', '--declare', '--dry-run', '--headful', '--no-handoff', '--no-vault', '--call'],
    string: ['--dir', '--email', '--year', '--line', '--amount', '--pin', '--chrome', '--phone'],
  });
  const [command, roleArg] = args.positional;
  if (args.flags.has('--help') || args.flags.has('-h') || !command) {
    out(USAGE);
    return command || args.flags.size ? 0 : 1;
  }
  const dir = args.values.get('--dir') ?? DEFAULT_DIR;

  if (command === 'secrets') {
    const rows = extract(dir);
    if (args.flags.has('--json')) {
      const identity = latestIdentity(rows);
      out(JSON.stringify({ business: businessSecrets(rows), personal: personalSecrets(rows), identity: identity && { ...identity, ssn: identity.ssn && maskSsn(identity.ssn) } }, null, 2));
    } else out(formatSecrets(rows));
    return 0;
  }

  if (command === 'status') {
    const state = loadState();
    for (const role of ROLES) {
      const a = state.accounts[role];
      if (!a) out(`${role.padEnd(9)} not registered`);
      else out(`${role.padEnd(9)} ${a.username}  registered ${a.registeredAt.slice(0, 10)}  ${a.activatedAt ? `active since ${a.activatedAt.slice(0, 10)}` : `waiting on the PIN letter${a.handoff ? `  ${a.handoff}` : ''}`}`);
    }
    return 0;
  }

  if (command !== 'register' && command !== 'activate') throw new UsageError(`unknown command: ${command}`);
  if (!ROLES.includes(roleArg as Role)) throw new UsageError(`${command} needs business or personal`);
  const role = roleArg as Role;
  const state = loadState();
  const say = (line: string) => err(line);
  const log = join(dirname(statePath()), 'ftb-pages.jsonl');
  const codeFile = join(dirname(statePath()), `ftb-code-${role}`);
  const headless = !args.flags.has('--headful');

  if (command === 'activate') {
    const account = state.accounts[role];
    if (!account) throw new FtbError(`no ${role} account in ${statePath()}; run \`ftb register ${role}\` first`);
    const pin = args.values.get('--pin');
    if (!pin || !/^\w{4,12}$/.test(pin)) throw new UsageError('--pin is the PIN from the letter');
    const plan: Plan = {
      role, firstName: '', lastName: '', username: account.username, password: account.password, email: account.email,
      addressNumbers: '', zip: '', year: account.secret.year, amount: account.secret.amount, security: { ...account.security }, declare: false, pin,
    };
    const session = await openSession({ chrome: args.values.get('--chrome'), headless });
    try {
      await goto(session, LOGIN_URL);
      say(`Activating the ${role} account ${account.username}:`);
      const result = await walk(session, { plan, rules: rulesFor(plan), dryRun: false, log, codeFile, interactive: process.stdin.isTTY === true, say });
      if (result.outcome === 'rejected') throw new FtbError(`FTB said: ${result.page.errors.join(' ') || 'no'} (${result.page.url})`);
      account.activatedAt = new Date().toISOString();
      saveState(state);
      if (account.handoff) spawnSync('myna', ['handoff', 'done', account.handoff.split('/').pop()!], { encoding: 'utf8' });
      out(`${role} MyFTB account ${account.username} is active.`);
      return 0;
    } finally {
      await session.browser.close();
    }
  }

  // register
  if (state.accounts[role] && !args.flags.has('--dry-run')) {
    throw new FtbError(`a ${role} account (${state.accounts[role]!.username}) is already registered here; \`ftb status\` says what it is waiting on`);
  }
  const email = args.values.get('--email');
  if (!email || !/^[\w.-]+@[\w.-]+\.\w+$/.test(email)) throw new UsageError('--email is required (letters, digits, . _ - and @ only)');
  const year = args.values.has('--year') ? Number(args.values.get('--year')) : undefined;
  const line = args.values.has('--line') ? Number(args.values.get('--line')) : undefined;
  if (line !== undefined && line !== 15 && line !== 20) throw new UsageError('--line is 15 or 20');

  const phone = (args.values.get('--phone') ?? '').replace(/\D/g, '');
  if (phone.length !== 10) throw new UsageError('--phone is the 10-digit number FTB texts a verification code to');
  const rows = extract(dir);
  const identity = latestIdentity(rows);
  if (!identity) throw new FtbError(`no Form 540 with a name, SSN and address under ${dir}`);

  const secret = role === 'business' ? chooseSecret(businessSecrets(rows), year, line) : chooseSecret(personalSecrets(rows), year, undefined);
  const amountOverride = args.values.get('--amount');
  if (amountOverride !== undefined && !/^-?\d+$/.test(amountOverride)) throw new UsageError('--amount is whole dollars, e.g. --amount=-12345');
  const amount = amountOverride !== undefined ? Number(amountOverride) : secret.amount;

  const plan: Plan = {
    role,
    firstName: identity.firstName!,
    lastName: identity.lastName!,
    username: generateUsername(role, `${identity.firstName![0]}${identity.lastName}`),
    password: generatePassword(),
    email,
    addressNumbers: addressNumbers(identity.street!),
    zip: identity.zip!.slice(0, 5),
    year: secret.year,
    amount,
    corpId: 'corpId' in secret ? secret.corpId : undefined,
    ssn: role === 'personal' ? identity.ssn! : undefined,
    filingStatus: 'filingStatus' in secret ? secret.filingStatus : undefined,
    security: {},
    declare: args.flags.has('--declare'),
    phone,
    call: args.flags.has('--call'),
  };

  say(`Registering a ${role} MyFTB account as ${plan.username} <${email}>`);
  say(`  shared secret: ${secret.year} Form ${secret.form}${'line' in secret ? ` line ${secret.line}` : ` (${plan.filingStatus})`} = ${formatAmount(amount)}   from ${secret.source}`);
  say(`  address on file: ${plan.addressNumbers} / ${plan.zip}${plan.corpId ? `   corp ${plan.corpId}` : `   SSN ${maskSsn(plan.ssn!)}`}`);

  const session = await openSession({ chrome: args.values.get('--chrome'), headless });
  try {
    await goto(session, REGISTER_URL);
    const result = await walk(session, { plan, rules: rulesFor(plan), dryRun: args.flags.has('--dry-run'), log, codeFile, interactive: process.stdin.isTTY === true, say });
    if (result.outcome === 'dry-run') {
      out('Dry run: stopped before the first Continue that sends anything to FTB.');
      return 0;
    }
    if (result.outcome === 'rejected') {
      throw new FtbError(`FTB said: ${result.page.errors.join(' ') || pageMessage(result.page.text)} (${result.page.url})\nNothing was retried. \`ftb secrets\` lists the other returns; pick one with --year/--line.`);
    }
    const at = new Date();
    const account: Account = {
      role, username: plan.username, password: plan.password, email, security: plan.security,
      secret: { year: secret.year, form: secret.form, amount }, registeredAt: at.toISOString(),
    };
    state.accounts[role] = account;
    saveState(state);
    out(`Registered: ${role} MyFTB account ${plan.username}. FTB mails a PIN to the address on file.`);
    if (!args.flags.has('--no-vault')) {
      try {
        pushVault(account);
        out(`  login saved to the ${VAULT.project} vault (${VAULT.team}/${VAULT.env}) and ${statePath()}`);
      } catch (error) {
        err(`  vault push failed, the login is only in ${statePath()}: ${(error as Error).message}`);
      }
    }
    if (!args.flags.has('--no-handoff')) {
      const url = postHandoff(role, at);
      if (url) {
        account.handoff = url;
        saveState(state);
        out(`  PIN-letter card: ${url}`);
      } else out('  PIN-letter card kept in myna locally (`myna cloud login` publishes it)');
    }
    out(`  When the letter comes: ftb activate ${role} --pin <PIN>`);
    return 0;
  } finally {
    await session.browser.close();
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof UsageError) {
        err(`ftb: ${error.message}\n\n${USAGE}`);
        process.exit(2);
      }
      if (error instanceof FtbError || error instanceof WcagError) {
        err(`ftb: ${error.message}`);
        process.exit(1);
      }
      throw error;
    },
  );
}
