/**
 * `ftb` — create and activate MyFTB accounts (California Franchise Tax Board),
 * business and personal, from the returns already on disk.
 *
 * FTB has no API and no OAuth: an account is a browser registration, checked
 * against a "shared secret" from a filed return, and activated with a PIN that
 * arrives by US Mail 5–10 business days later. So the automation is:
 *
 * - **Secrets from the returns.** src/ftb-extract.py reads the PDFs (PyMuPDF):
 *   Form 100S line 20 "net income for tax purposes" (and line 15) for a
 *   business, Form 540 line 17 "CA AGI" plus the filing status, name, SSN and
 *   address for a person. Nobody has to know which form or line.
 * - **The forms, page by page.** src/ftb-run.ts fills every page from the
 *   {@link rulesFor} table, matched on field id first and label second, so a
 *   page FTB adds or rewords stops the run with its fields listed instead of
 *   submitting a guess.
 * - **People only where the law or the post office needs one.** The penalty-of-
 *   perjury box is ticked only with `--declare` (the person's own statement),
 *   one shared secret is submitted per run and never retried, and the PIN step
 *   becomes a myna hand-off card (mynaposter.com/handoff/<id>) that carries
 *   steps and never a secret.
 *
 * Everything here is pure and tested; the browser lives in ftb-run.ts.
 */

import { randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class FtbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FtbError';
  }
}

export type Role = 'business' | 'personal';
export const ROLES: readonly Role[] = ['business', 'personal'];

export const REGISTER_URL = 'https://webapp.ftb.ca.gov/MyFTBAccess/Registration/NewAccount';
export const LOGIN_URL = 'https://webapp.ftb.ca.gov/MyFTBAccess/';

// ---------------------------------------------------------------------------
// Secrets from the returns
// ---------------------------------------------------------------------------

export interface BusinessReturn {
  kind: 'business';
  form: '100S';
  year: number;
  file: string;
  page: number;
  /** Line 15, net income (loss) for state purposes. */
  netIncomeForState: number | null;
  /** Line 20, net income for tax purposes: what FTB's own e-file summary calls "taxable income". */
  netIncomeForTax: number | null;
  corpId: string | null;
}

export interface PersonalReturn {
  kind: 'personal';
  form: '540';
  year: number;
  file: string;
  page: number;
  /** Line 17, California adjusted gross income. */
  caAgi: number | null;
}

export type FilingStatus = 'single' | 'married-joint' | 'married-separate' | 'head-of-household' | 'qualifying-surviving-spouse';

export interface Identity {
  kind: 'identity';
  year: number;
  file: string;
  page: number;
  ssn: string | null;
  firstName: string | null;
  lastName: string | null;
  street: string | null;
  zip: string | null;
  filingStatus: FilingStatus | null;
}

export type Extracted = BusinessReturn | PersonalReturn | Identity;

/** Parse ftb-extract.py's output, dropping anything that is not a record it makes. */
export function parseExtracted(json: string): Extracted[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new FtbError('ftb-extract.py printed something that is not JSON');
  }
  if (!Array.isArray(parsed)) throw new FtbError('ftb-extract.py did not print a list');
  return parsed.filter(
    (row): row is Extracted =>
      typeof row === 'object' && row !== null && ['business', 'personal', 'identity'].includes((row as { kind?: string }).kind ?? '') && Number.isInteger((row as { year?: number }).year),
  );
}

/** A year FTB will take: one of the last five, never the current one (it cannot be processed yet). */
export function eligibleYear(year: number, now: Date = new Date()): boolean {
  const current = now.getFullYear();
  return year < current && year >= current - 5;
}

export interface BusinessSecret {
  year: number;
  form: '100S';
  amount: number;
  line: 15 | 20;
  corpId: string;
  source: string;
}

export interface PersonalSecret {
  year: number;
  form: '540';
  amount: number;
  filingStatus: FilingStatus;
  source: string;
}

function newestFirst<T extends { year: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.year - a.year);
}

/**
 * Every business secret the returns support, best first: the newest year, line
 * 20 before line 15. The caller submits one; FTB is never sent a list.
 */
export function businessSecrets(rows: readonly Extracted[], now: Date = new Date()): BusinessSecret[] {
  const out: BusinessSecret[] = [];
  const seen = new Set<string>();
  for (const row of newestFirst(rows.filter((r): r is BusinessReturn => r.kind === 'business' && eligibleYear(r.year, now)))) {
    if (!row.corpId) continue;
    for (const line of [20, 15] as const) {
      const amount = line === 20 ? row.netIncomeForTax : row.netIncomeForState;
      const key = `${row.year}:${line}:${amount}`;
      if (amount === null || seen.has(key)) continue;
      seen.add(key);
      out.push({ year: row.year, form: '100S', amount, line, corpId: row.corpId, source: `${row.file} p${row.page}` });
    }
  }
  return out;
}

export function personalSecrets(rows: readonly Extracted[], now: Date = new Date()): PersonalSecret[] {
  const identities = rows.filter((r): r is Identity => r.kind === 'identity');
  const out: PersonalSecret[] = [];
  const seen = new Set<number>();
  for (const row of newestFirst(rows.filter((r): r is PersonalReturn => r.kind === 'personal' && eligibleYear(r.year, now)))) {
    if (row.caAgi === null || seen.has(row.year)) continue;
    const status = identities.find((i) => i.file === row.file && i.year === row.year)?.filingStatus;
    if (!status) continue;
    seen.add(row.year);
    out.push({ year: row.year, form: '540', amount: row.caAgi, filingStatus: status, source: `${row.file} p${row.page}` });
  }
  return out;
}

/** The newest identity block with every field FTB asks a person for. */
export function latestIdentity(rows: readonly Extracted[]): Identity | null {
  return newestFirst(rows.filter((r): r is Identity => r.kind === 'identity')).find((r) => r.ssn && r.firstName && r.lastName && r.street && r.zip) ?? null;
}

/** "1234 MAPLE ST" -> "1234": FTB wants the numbers in the address and nothing else. */
export function addressNumbers(street: string): string {
  return (street.match(/\d+/g) ?? []).join('');
}

export function maskSsn(ssn: string): string {
  return `***-**-${ssn.replace(/\D/g, '').slice(-4)}`;
}

/** Whole dollars, a dash for a loss, no comma: the only shape FTB's field accepts. */
export function formatAmount(amount: number): string {
  return String(Math.trunc(amount));
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
// Kept to characters every FTB form so far has taken, none of which need escaping anywhere.
const SPECIAL = '!#$*@';

function pick(alphabet: string, random: (max: number) => number): string {
  return alphabet[random(alphabet.length)]!;
}

/** 24 characters: inside FTB's 15–32, with each class it requires. */
export function generatePassword(random: (max: number) => number = randomInt, length = 24): string {
  const all = LOWER + UPPER + DIGIT + SPECIAL;
  const chars = [pick(LOWER, random), pick(UPPER, random), pick(DIGIT, random), pick(SPECIAL, random)];
  while (chars.length < length) chars.push(pick(all, random));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** Letters and digits only, 4–17 characters, one per role (FTB allows one role per account). */
export function generateUsername(role: Role, base: string, random: (max: number) => number = randomInt): string {
  const stem = base.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'ftb';
  let suffix = role === 'business' ? 'b' : 'p';
  while (suffix.length < 5) suffix += pick(LOWER + DIGIT, random);
  return `${stem}${suffix}`.slice(0, 17);
}

/** A security answer: 10 lowercase letters/digits, inside the 3–17 FTB allows. */
export function generateAnswer(random: (max: number) => number = randomInt): string {
  let answer = '';
  while (answer.length < 10) answer += pick(LOWER + DIGIT, random);
  return answer;
}

// ---------------------------------------------------------------------------
// Fields and the rules that fill them
// ---------------------------------------------------------------------------

export interface FieldOption {
  value: string;
  text: string;
}

/** One form control as ftb-run.ts reads it off a page. */
export interface Field {
  /** A CSS selector that finds exactly this control. */
  selector: string;
  id: string;
  name: string;
  type: string;
  label: string;
  required: boolean;
  options?: FieldOption[];
  /** For a text box: the chosen option of the nearest select before it, or the question printed above it. */
  question?: string;
}

export type Action =
  | { kind: 'text'; value: string; secret?: boolean }
  | { kind: 'select'; value: string }
  | { kind: 'check' }
  | { kind: 'declare' };

export interface Rule {
  /** Shown in logs and errors. */
  name: string;
  /** Tried against the id first, then `id name label`. */
  id?: RegExp;
  label?: RegExp;
  /** Radios and checkboxes only match when their type is listed. */
  types?: readonly string[];
  act: (field: Field) => Action | null;
}

export interface Plan {
  role: Role;
  firstName: string;
  lastName: string;
  username: string;
  password: string;
  email: string;
  addressNumbers: string;
  zip: string;
  year: number;
  amount: number;
  /** Business only. */
  corpId?: string | undefined;
  /** Personal only. */
  ssn?: string | undefined;
  filingStatus?: FilingStatus | undefined;
  /** Answers already chosen, keyed by question text; filled as the profile page is met. */
  security: Record<string, string>;
  /** The person's own penalty-of-perjury statement, from `--declare`. */
  declare: boolean;
  /** Ten digits; FTB texts a verification code to it during registration. */
  phone?: string | undefined;
  /** Have FTB phone the code in rather than text it (a text can be throttled or lost). */
  call?: boolean | undefined;
  /** Activation only. */
  pin?: string;
}

/** The box FTB's texted (or spoken) verification code goes in. */
export const CODE_LABEL = /verification code|security code|one[- ]time|passcode|access code|enter (the )?code/i;

function option(field: Field, pattern: RegExp): Action | null {
  const found = field.options?.find((o) => o.value !== '' && (pattern.test(o.text) || pattern.test(o.value)));
  return found ? { kind: 'select', value: found.value } : null;
}

const FILING_STATUS_TEXT: Record<FilingStatus, RegExp> = {
  single: /^\s*single/i,
  'married-joint': /joint/i,
  'married-separate': /separate/i,
  'head-of-household': /head of household/i,
  'qualifying-surviving-spouse': /surviving|widow/i,
};

/** A question this plan has not answered yet, chosen in page order so the three differ. */
function securityQuestion(plan: Plan, field: Field): Action | null {
  const used = new Set(Object.keys(plan.security));
  const choice = field.options?.find((o) => o.value !== '' && !used.has(o.text.trim()));
  if (!choice) return null;
  plan.security[choice.text.trim()] = generateAnswer();
  return { kind: 'select', value: choice.value };
}

/**
 * The answer to a question: the one chosen in the select before this box at
 * registration, or the stored question whose text the login page prints.
 */
function securityAnswer(plan: Plan, field: Field): Action | null {
  const context = `${field.question ?? ''} ${field.label}`.toLowerCase();
  const known = Object.entries(plan.security).find(([question]) => context.includes(question.toLowerCase()));
  if (known) return { kind: 'text', value: known[1], secret: true };
  const index = Number(field.id.match(/(\d)\s*$/)?.[1] ?? field.label.match(/answer\s*(\d)/i)?.[1] ?? 0);
  const answer = index ? Object.values(plan.security)[index - 1] : undefined;
  return answer ? { kind: 'text', value: answer, secret: true } : null;
}

const SUBMIT_TYPES = ['text', 'password', 'email', 'tel', 'number', 'select-one'];

/**
 * The rule table. Field ids seen on FTB's pages come first and are exact; the
 * label patterns after them cover pages not yet seen, and anything required that
 * nothing matches stops the run.
 */
export function rulesFor(plan: Plan): Rule[] {
  const text = (value: string, secret = false) => (): Action => ({ kind: 'text', value, secret });
  const rules: Rule[] = [
    { name: 'read terms', id: /^ReadTerms$/, types: ['checkbox'], act: () => ({ kind: 'check' }) },
    { name: 'accept terms', id: /^AcceptTerms$/, types: ['checkbox'], act: () => ({ kind: 'check' }) },
    { name: 'first name', id: /^FstName$/, act: text(plan.firstName.slice(0, 11)) },
    { name: 'middle initial', id: /^MInitial$/, act: () => null },
    { name: 'last name', id: /^LstName$/, act: text(plan.lastName.slice(0, 13)) },
    { name: 'suffix', id: /^Sffx$/, act: () => null },
    { name: 'user name again', id: /^ReUserName$/, act: text(plan.username) },
    { name: 'user name', id: /^UserName$/, act: text(plan.username) },
    { name: 'email again', id: /^ReEmail$/, act: text(plan.email) },
    { name: 'email', id: /^Email$/, act: text(plan.email) },
    { name: 'password again', id: /^RePassword$/, act: text(plan.password, true) },
    { name: 'password', id: /^Password$/, act: text(plan.password, true) },

    // Profile: three security questions and their answers.
    { name: 'security question', label: /question/i, types: ['select-one'], act: (f) => securityQuestion(plan, f) },
    { name: 'security question', label: /question/i, types: ['text', 'password'], act: (f) => securityAnswer(plan, f) },
    { name: 'security answer', label: /answer/i, types: ['text', 'password'], act: (f) => securityAnswer(plan, f) },

    // Role.
    {
      name: 'role',
      label: /individual|business representative/i,
      types: ['radio'],
      // By how the option starts: "Tax Professional - ... your individual or business entity client" names both.
      act: (f) => ((plan.role === 'business' ? /^\s*business representative/i : /^\s*individual\b/i).test(f.label) ? { kind: 'check' } : null),
    },

    // Address on file.
    { name: 'zip', label: /zip|postal/i, types: SUBMIT_TYPES, act: text(plan.zip) },
    { name: 'address numbers', label: /numbers in (the |your )?(business )?(mailing )?address/i, types: SUBMIT_TYPES, act: text(plan.addressNumbers) },

    // The shared secret.
    { name: 'tax year', label: /year (of|on) the tax return|tax year/i, types: ['select-one'], act: (f) => option(f, new RegExp(`^\\s*${plan.year}\\s*$`)) },
    { name: 'tax year', label: /year (of|on) the tax return|tax year/i, types: ['text', 'number', 'tel'], act: text(String(plan.year)) },
    { name: 'net income', label: /net income|income \(loss\)|adjusted gross|\bagi\b/i, types: SUBMIT_TYPES, act: text(formatAmount(plan.amount)) },

    // The penalty-of-perjury statement: only ever the person's own.
    { name: 'declaration', label: /perjury|i declare|under penalty/i, types: ['checkbox'], act: () => ({ kind: 'declare' }) },

    // Phone verification: a text by default, a call with --call.
    { name: 'phone', label: /phone number/i, types: SUBMIT_TYPES, act: () => (plan.phone ? { kind: 'text', value: plan.phone } : null) },
    { name: plan.call ? 'call me' : 'send a text', label: /send me a text|text message|call me/i, types: ['radio'], act: (f) => ((plan.call ? /call me/i : /text/i).test(f.label) ? { kind: 'check' } : null) },
    { name: 'foreign number', id: /^Phone_Foreign$/, act: () => null },
    { name: 'foreign address', id: /^Address_Foreign$|^Address_No(MailAddress|PostalCode)$/, act: () => null },

    // Login.
    { name: 'user name', label: /^user name/i, types: ['text'], act: text(plan.username) },
    { name: 'password', label: /^password/i, types: ['password'], act: text(plan.password, true) },

    // Activation.
    { name: 'pin', label: /\bpin\b|personal identification number/i, types: SUBMIT_TYPES, act: () => (plan.pin ? { kind: 'text', value: plan.pin, secret: true } : null) },
  ];

  if (plan.role === 'business') {
    rules.push(
      { name: 'company type', label: /type of company|company type|entity type/i, types: ['select-one'], act: (f) => option(f, /^\s*corporation\s*$/i) ?? option(f, /corporation/i) },
      { name: 'account number', label: /account number|entity id|corporation (id|number)/i, types: SUBMIT_TYPES, act: text(plan.corpId ?? '') },
      { name: 'form type', label: /form type|type of (tax )?(return|form)/i, types: ['select-one'], act: (f) => option(f, /100\s*S\b/i) },
    );
  } else {
    const digits = (plan.ssn ?? '').replace(/\D/g, '');
    rules.push(
      { name: 'filing status', label: /filing status/i, types: ['select-one'], act: (f) => option(f, FILING_STATUS_TEXT[plan.filingStatus ?? 'single']) },
      { name: 'filing status', label: /filing status|single|joint|separate|head of household|surviving/i, types: ['radio'], act: (f) => (FILING_STATUS_TEXT[plan.filingStatus ?? 'single'].test(f.label) ? { kind: 'check' } : null) },
      {
        name: 'ssn',
        label: /social security|\bssn\b|itin/i,
        types: SUBMIT_TYPES,
        act: (f) => {
          // Split SSN boxes are 3, 2 and 4 wide; one box takes all nine digits.
          const part = f.id.match(/(\d)$/)?.[1];
          const slices: Record<string, string> = { '1': digits.slice(0, 3), '2': digits.slice(3, 5), '3': digits.slice(5) };
          return { kind: 'text', value: part && slices[part] !== undefined ? slices[part]! : digits, secret: true };
        },
      },
      { name: 'form type', label: /form type|type of (tax )?(return|form)/i, types: ['select-one'], act: (f) => option(f, /^\s*(form\s*)?540\s*$/i) },
    );
  }
  return rules;
}

/** The first rule whose pattern and type fit, and the action it chooses for the field. */
export function decide(rules: readonly Rule[], field: Field): { rule: Rule; action: Action } | null {
  const haystack = `${field.id} ${field.name} ${field.label}`;
  for (const pass of ['id', 'label'] as const) {
    for (const rule of rules) {
      if (rule.types && !rule.types.includes(field.type)) continue;
      const pattern = pass === 'id' ? rule.id : rule.label;
      if (!pattern) continue;
      if (!(pass === 'id' ? pattern.test(field.id) : pattern.test(haystack))) continue;
      const action = rule.act(field);
      // An id match is deliberate, even when it says "leave this alone"; a label match that cannot act lets the next rule try.
      if (action || pass === 'id') return action ? { rule, action } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// What a page says about how it went
// ---------------------------------------------------------------------------

export type Outcome = 'registered' | 'activated' | 'rejected' | 'continue';

export function outcomeOf(text: string): Outcome {
  if (/does not match our records|there is a problem|unable to (verify|process) your|account (is|has been) locked|account locked|exceeded the allowed number of attempts/i.test(text)) return 'rejected';
  if (/account (has been )?activated|activation (is )?complete/i.test(text)) return 'activated';
  if (/registration confirmation|successfully (registered|created)|we will (mail|send) you a (letter|pin)|pin .*(mail|letter)/i.test(text)) return 'registered';
  return 'continue';
}

// ---------------------------------------------------------------------------
// State, vault and the hand-off card
// ---------------------------------------------------------------------------

export interface Account {
  role: Role;
  username: string;
  password: string;
  email: string;
  security: Record<string, string>;
  secret: { year: number; form: string; amount: number };
  registeredAt: string;
  activatedAt?: string;
  handoff?: string;
}

export interface State {
  accounts: Partial<Record<Role, Account>>;
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'cli-tools', 'ftb.json');
}

/** The vault holding the logins: its own project, so pushing it can never drop another team key. */
export const VAULT = { team: 'profullstack', project: 'ftb', env: 'prod' } as const;

export function vaultKeys(account: Account): Record<string, string> {
  const prefix = `FTB_${account.role.toUpperCase()}`;
  return {
    [`${prefix}_USERNAME`]: account.username,
    [`${prefix}_PASSWORD`]: account.password,
    [`${prefix}_EMAIL`]: account.email,
    [`${prefix}_SECURITY_ANSWERS`]: JSON.stringify(account.security),
  };
}

/** .env text with every value quoted, so `#`, `$` and spaces survive. */
export function toEnvFile(values: Record<string, string>): string {
  return `${Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')}\n`;
}

/** The myna card for the PIN letter. Steps only: no PIN, password or SSN ever goes on it. */
export function handoffCard(role: Role, registeredAt: Date): { title: string; steps: string[]; text: string } {
  const deadline = new Date(registeredAt.getTime() + 21 * 86_400_000).toISOString().slice(0, 10);
  return {
    title: `FTB PIN letter: ${role} MyFTB account`,
    steps: [
      `Watch the mail at the address FTB has on file for the MyFTB PIN letter (5 to 10 business days).`,
      `Activate before ${deadline}: the PIN expires 21 days after registration.`,
      `Run the command below on the dev box with the PIN, or send the PIN to riotcoder to run it.`,
    ],
    text: `ftb activate ${role} --pin <PIN from the letter>\n`,
  };
}
