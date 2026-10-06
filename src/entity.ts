import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * entity — the paperwork that keeps a company in good standing, state and
 * federal: who its registered agent is, what each compliance vendor charges and
 * when it renews, when the state's annual filing is due, and the steps for
 * moving off an expensive agent.
 *
 * Nothing here signs up, pays, cancels or files. Those are a person's acts (a
 * Statement of Information ends in an officer's declaration that it is true),
 * so this module plans them, drafts the values and keeps the dates; the clicks
 * stay with the owner. It never talks to a vendor or a state site either, so
 * there is no login to throttle.
 *
 * The profile is the owner's own file (`~/.config/cli-tools/entity.json`):
 * company facts and subscriptions belong there, never in this public repo.
 */

export class EntityError extends Error {
  override name = 'EntityError';
}

export type EntityKind = 'corporation' | 'llc';

export interface Agent {
  /** Exactly as it should appear on the state's record. */
  name: string;
  /** A registered corporate agent (CA Corp Code 1505) is named without an address. */
  corporate: boolean;
  /** Street address, for a natural person only. */
  address?: string;
}

export interface Subscription {
  vendor: string;
  service: string;
  pricePerYear: number;
  /** YYYY-MM-DD the next auto-renewal charges. */
  renews: string;
  /** `agent` is the registered agent itself; it can only go once a new one is on file. */
  kind: 'agent' | 'compliance' | 'other';
  status: 'active' | 'cancelled';
  cancel: { url?: string; phone?: string; note?: string };
}

export interface Profile {
  name: string;
  /** Two-letter state of formation. Only CA has filing rules here so far. */
  state: string;
  kind: EntityKind;
  /** YYYY-MM the articles were filed: it fixes the filing window. */
  formed: string;
  entityNumber?: string;
  principalAddress?: string;
  mailingAddress?: string;
  officers?: { ceo?: string; secretary?: string; cfo?: string };
  directors?: string[];
  businessType?: string;
  agent: Agent;
  newAgent?: Agent;
  subscriptions: Subscription[];
  /** Where agent scans and compliance alerts should be sent. */
  notifyEmail?: string;
}

// --- paths and storage ------------------------------------------------------

export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cli-tools', 'entity.json');
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'cli-tools', 'entity-state.json');
}

export function readProfile(path: string): Profile {
  if (!existsSync(path)) {
    throw new EntityError(`no profile at ${path} — run \`entity init\` and fill it in`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new EntityError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return validateProfile(parsed);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Checks the shape loudly: a typo in a renewal date must not hide a deadline. */
export function validateProfile(value: unknown): Profile {
  const p = value as Partial<Profile> | null;
  const problems: string[] = [];
  if (!p || typeof p !== 'object') throw new EntityError('profile must be a JSON object');
  if (!p.name) problems.push('name is required');
  if (!p.state || !/^[A-Z]{2}$/.test(p.state)) problems.push('state must be a two-letter code, e.g. CA');
  if (p.kind !== 'corporation' && p.kind !== 'llc') problems.push('kind must be "corporation" or "llc"');
  if (!p.formed || !MONTH.test(p.formed)) problems.push('formed must be YYYY-MM');
  if (!p.agent?.name) problems.push('agent.name is required');
  if (!Array.isArray(p.subscriptions)) problems.push('subscriptions must be an array (may be empty)');
  for (const [i, s] of (p.subscriptions ?? []).entries()) {
    if (!s.renews || !DATE.test(s.renews)) problems.push(`subscriptions[${i}].renews must be YYYY-MM-DD`);
    if (!['agent', 'compliance', 'other'].includes(s.kind)) problems.push(`subscriptions[${i}].kind is unknown`);
    if (!['active', 'cancelled'].includes(s.status)) problems.push(`subscriptions[${i}].status is unknown`);
  }
  if (problems.length) throw new EntityError(`profile problems:\n  ${problems.join('\n  ')}`);
  return p as Profile;
}

export interface State {
  done: Record<string, string>;
}

export function readState(path: string): State {
  if (!existsSync(path)) return { done: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>;
  return { done: parsed.done ?? {} };
}

/** Written through a temp file, so an interrupted write never leaves half a ledger. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** A starting profile with every field present and nothing real in it. */
export function templateProfile(): Profile {
  return {
    name: 'Example, Inc.',
    state: 'CA',
    kind: 'corporation',
    formed: '2018-12',
    entityNumber: '',
    principalAddress: '',
    mailingAddress: '',
    officers: { ceo: '', secretary: '', cfo: '' },
    directors: [],
    businessType: '',
    agent: { name: 'Current Agent, Inc.', corporate: true },
    newAgent: { name: 'California Corporate Agents, Inc.', corporate: true },
    subscriptions: [
      {
        vendor: 'Current Agent',
        service: 'Registered Agent',
        pricePerYear: 0,
        renews: '2026-01-01',
        kind: 'agent',
        status: 'active',
        cancel: { url: '', phone: '' },
      },
    ],
    notifyEmail: '',
  };
}

// --- dates -------------------------------------------------------------------

const MS_DAY = 86_400_000;

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days from `today` to `date`; negative once it has passed. */
export function daysUntil(date: string, today: string): number {
  return Math.round((utcDate(date).getTime() - utcDate(today).getTime()) / MS_DAY);
}

function lastDayOfMonth(year: number, month: number): string {
  return iso(new Date(Date.UTC(year, month, 0)));
}

export interface FilingWindow {
  opens: string;
  closes: string;
  /** The form and what it costs, as published by the state. */
  form: string;
  fee: number;
}

/**
 * California's Statement of Information window that contains or follows `today`.
 *
 * Corporations file every year, LLCs every other year (in years of the same
 * parity as formation), each in the six months ending with the last day of the
 * month the entity was formed (Corp Code 1502, 17702.09). An agent-only change
 * filed outside the window costs nothing; inside it, it is the annual filing.
 */
export function filingWindow(profile: Profile, today: string): FilingWindow {
  if (profile.state !== 'CA') {
    throw new EntityError(`no filing rules for ${profile.state} yet — only CA is modelled`);
  }
  const [formedYear, month] = profile.formed.split('-').map(Number) as [number, number];
  const form = profile.kind === 'corporation' ? 'SI-550' : 'LLC-12';
  const fee = profile.kind === 'corporation' ? 25 : 20;
  const step = profile.kind === 'corporation' ? 1 : 2;
  let year = Number(today.slice(0, 4)) - 1;
  if (step === 2 && (year - formedYear) % 2 !== 0) year -= 1;
  for (;; year += step) {
    if (year <= formedYear) continue; // the initial statement is a separate, 90-day filing
    const closes = lastDayOfMonth(year, month);
    const start = new Date(Date.UTC(year, month - 6, 1));
    const window = { opens: iso(start), closes, form, fee };
    if (closes >= today) return window;
  }
}

// --- deadlines -----------------------------------------------------------------

export interface Deadline {
  date: string;
  days: number;
  what: string;
  /** What happens if nothing is done. */
  consequence: string;
  scope: 'state' | 'federal' | 'vendor';
}

/**
 * Everything with a date on it, soonest first.
 *
 * A renewal is reported as "cancel before", because the charge is the default
 * outcome. The old agent's renewal says so too, but it cannot be cancelled until
 * the new agent is on the state's record — the vendor may ask for proof.
 */
export function deadlines(profile: Profile, today: string): Deadline[] {
  const out: Deadline[] = [];
  for (const s of profile.subscriptions) {
    if (s.status !== 'active') continue;
    const prereq = s.kind === 'agent' ? ' (only after the new agent is on file with the state)' : '';
    out.push({
      date: s.renews,
      days: daysUntil(s.renews, today),
      what: `cancel ${s.vendor} ${s.service}${prereq}`,
      consequence: `auto-renews for $${s.pricePerYear}/yr`,
      scope: 'vendor',
    });
  }
  if (profile.state === 'CA') {
    const w = filingWindow(profile, today);
    const open = w.opens <= today;
    out.push({
      date: w.closes,
      days: daysUntil(w.closes, today),
      what: `file Statement of Information ${w.form} ($${w.fee})${open ? ', window open now' : `, window opens ${w.opens}`}`,
      consequence: 'late penalty from FTB, then suspension',
      scope: 'state',
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// --- vendors -------------------------------------------------------------------

export interface Vendor {
  name: string;
  firstYear: number;
  renewal: number;
  /** Does it also file the annual state report, and for how much on top. */
  filesAnnualReport: string;
  scans: string;
  api: string;
  payment: string;
  signup: string;
  phone?: string;
  note: string;
  source: string;
}

/**
 * California registered agents, cheapest renewal first, as published when last
 * checked. Prices move; `source` is where to re-check. None of them advertises
 * crypto or PayPal, and none names its card processor.
 */
export const VENDORS_CHECKED = '2026-10-06';
export const CA_VENDORS: readonly Vendor[] = [
  {
    name: 'LAUNCH Registered Agent',
    firstYear: 34.99,
    renewal: 48.99,
    filesAnnualReport: 'no (free guides)',
    scans: 'same-day, unlimited',
    api: 'none',
    payment: 'card checkout, processor not stated',
    signup: 'https://launchregisteredagent.com/',
    note: '3 years for $98.99, price locked',
    source: 'https://launchregisteredagent.com/blog/northwest-vs-launch-registered-agent',
  },
  {
    name: 'California Registered Agent Inc',
    firstYear: 49,
    renewal: 50,
    filesAnnualReport: 'not stated',
    scans: 'same-day, dashboard',
    api: 'none',
    payment: 'not stated',
    signup: 'https://www.californiaregisteredagent.net/',
    note: 'CA-only since 2006; reviews say $49, its own site says $50 a year',
    source: 'https://www.usepostal.com/blog/best-registered-agent-california',
  },
  {
    name: 'California Corporate Agents',
    firstYear: 50,
    renewal: 50,
    filesAnnualReport: 'yes, $100 + state fee',
    scans: 'portal',
    api: 'none (Corporate Tools platform)',
    payment: 'card checkout, processor not stated; phone orders',
    signup: 'https://www.cacorporateagents.com/order-now/registered-agent-services/',
    phone: '(800) 392-6505',
    note: 'certified 1505 corporate agent, fixed price',
    source: 'https://www.cacorporateagents.com/',
  },
  {
    name: 'Postal',
    firstYear: 0,
    renewal: 49,
    filesAnnualReport: 'no',
    scans: 'AI summaries with action dates',
    api: 'not documented',
    payment: 'not stated',
    signup: 'https://www.usepostal.com/',
    note: 'first 6 months free; RA price from their blog, not the pricing page',
    source: 'https://www.usepostal.com/blog/best-registered-agent-california',
  },
  {
    name: 'Northwest Registered Agent',
    firstYear: 125,
    renewal: 125,
    filesAnnualReport: 'add-on',
    scans: 'same-day',
    api: 'none public',
    payment: 'card checkout, processor not stated',
    signup: 'https://www.northwestregisteredagent.com/',
    note: 'national, 50 states',
    source: 'https://registeredagentcost.com/california/',
  },
  {
    name: 'Stable',
    firstYear: 300,
    renewal: 300,
    filesAnnualReport: 'no',
    scans: 'virtual mailbox (separate plan)',
    api: 'REST API + webhooks for agents and mail',
    payment: 'not stated',
    signup: 'https://www.usestable.com/',
    note: '$25/mo per state; the only one with a documented API',
    source: 'https://www.usestable.com/pricing',
  },
];

// --- federal ---------------------------------------------------------------------

export interface Obligation {
  item: string;
  applies: string;
  action: string;
  source: string;
}

/**
 * The federal side. There is no federal registered agent; what remains is
 * keeping the IRS's record current and knowing what no longer applies. Dates
 * only, never amounts: tax figures stay with the owner.
 */
export function federalObligations(profile: Profile): Obligation[] {
  return [
    {
      item: 'Registered agent',
      applies: 'no federal requirement',
      action: 'nothing: the agent is a state appointment only',
      source: 'https://www.sos.ca.gov/business-programs/business-entities/service-of-process/',
    },
    {
      item: 'Beneficial ownership (BOI) report',
      applies: 'exempt for companies formed in the US (FinCEN interim final rule, March 2025)',
      action: 'nothing, unless FinCEN reinstates it',
      source: 'https://www.fincen.gov/boi',
    },
    {
      item: 'IRS address / responsible party (Form 8822-B)',
      applies: 'only when the mailing address or responsible party changes',
      action: 'changing agents does not trigger it; file within 60 days of a responsible-party change',
      source: 'https://www.irs.gov/forms-pubs/about-form-8822-b',
    },
    {
      item: profile.kind === 'corporation' ? 'Federal income tax return' : 'Federal return (by tax classification)',
      applies: 'every year',
      action: 'calendar-year S corporation: Form 1120-S by March 15 (the owner and their preparer handle it)',
      source: 'https://www.irs.gov/forms-pubs/about-form-1120-s',
    },
  ];
}

// --- the switch plan -----------------------------------------------------------------

export interface Step {
  id: string;
  title: string;
  how: string[];
  dueBy?: string;
}

/**
 * The order that never leaves the company without an agent: cancel the
 * compliance add-on first (it renews soonest and has no prerequisite), sign up
 * with the new agent, put it on the state's record, and only then let the old
 * agent go, with the filed statement as proof.
 */
export function switchPlan(profile: Profile, today: string): Step[] {
  const next = profile.newAgent;
  if (!next) throw new EntityError('profile has no newAgent — name the agent you are moving to');
  const vendor = CA_VENDORS.find((v) => v.name.toLowerCase().startsWith(next.name.toLowerCase().replace(/,? inc\.?$/i, '')));
  const active = profile.subscriptions.filter((s) => s.status === 'active');
  const oldAgent = active.find((s) => s.kind === 'agent');
  const steps: Step[] = [];

  for (const s of active.filter((x) => x.kind === 'compliance')) {
    steps.push({
      id: `cancel-${slug(s.vendor)}-${slug(s.service)}`,
      title: `Cancel ${s.vendor} ${s.service} ($${s.pricePerYear}/yr)`,
      how: [s.cancel.url && `online: ${s.cancel.url}`, s.cancel.phone && `phone: ${s.cancel.phone}`, s.cancel.note]
        .filter((x): x is string => Boolean(x)),
      dueBy: dayBefore(s.renews),
    });
  }

  steps.push({
    id: 'signup-agent',
    title: `Sign up with ${next.name}`,
    how: [
      vendor ? `order: ${vendor.signup}` : 'order on the agent\'s site',
      vendor?.phone ? `or by phone: ${vendor.phone} (ask for check/ACH/PayPal if the checkout is Stripe)` : '',
      'ask for the exact name to enter as your agent on the state form',
      profile.notifyEmail ? `send scans and alerts to ${profile.notifyEmail}` : 'set where scans and alerts go',
    ].filter(Boolean),
    ...(oldAgent ? { dueBy: weekBefore(oldAgent.renews) } : {}),
  });

  const w = profile.state === 'CA' ? filingWindow(profile, today) : null;
  const inWindow = w ? w.opens <= today : false;
  steps.push({
    id: 'file-si',
    title: `File the Statement of Information naming ${next.name}`,
    how: [
      'https://bizfileonline.sos.ca.gov → log in → search the entity → File Statement of Information',
      'paste the values from `entity si-draft`; an officer reviews and signs the declaration',
      inWindow && w
        ? `this is also the annual filing (window ${w.opens} to ${w.closes}): $${w.fee}`
        : 'outside the filing window an agent-only change is free',
    ],
    ...(oldAgent ? { dueBy: weekBefore(oldAgent.renews) } : {}),
  });

  steps.push({
    id: 'save-si-pdf',
    title: 'Download the filed statement (PDF) from bizfile',
    how: ['My Work Queue → the filing → download; keep it with the corporate records'],
  });

  if (oldAgent) {
    steps.push({
      id: `cancel-${slug(oldAgent.vendor)}-agent`,
      title: `Cancel ${oldAgent.vendor} ${oldAgent.service} ($${oldAgent.pricePerYear}/yr), filed PDF as proof`,
      how: [oldAgent.cancel.url && `online: ${oldAgent.cancel.url}`, oldAgent.cancel.phone && `phone: ${oldAgent.cancel.phone}`, oldAgent.cancel.note]
        .filter((x): x is string => Boolean(x)),
      dueBy: dayBefore(oldAgent.renews),
    });
  }

  steps.push({
    id: 'update-profile',
    title: 'Mark the old subscriptions cancelled and make the new agent current in the profile',
    how: [`edit the profile: agent = newAgent, cancelled subscriptions status "cancelled", add the new one with its renewal date`],
  });
  return steps;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function dayBefore(date: string): string {
  return iso(new Date(utcDate(date).getTime() - MS_DAY));
}

function weekBefore(date: string): string {
  return iso(new Date(utcDate(date).getTime() - 7 * MS_DAY));
}

// --- the Statement of Information draft -------------------------------------------------

export interface DraftField {
  field: string;
  value: string;
  missing: boolean;
}

/**
 * The values bizfile's Statement of Information asks for, in its order, to
 * paste by hand. Missing values are flagged rather than guessed: this goes on a
 * public record under an officer's declaration.
 */
export function siDraft(profile: Profile, agent: Agent | undefined = profile.newAgent ?? profile.agent): DraftField[] {
  const field = (name: string, value: string | undefined): DraftField => ({
    field: name,
    value: value?.trim() || '',
    missing: !value?.trim(),
  });
  const rows = [
    field('Entity name', profile.name),
    field('Entity number', profile.entityNumber),
    field('Principal office address', profile.principalAddress),
    field('Mailing address', profile.mailingAddress || profile.principalAddress),
  ];
  if (profile.kind === 'corporation') {
    rows.push(
      field('Chief Executive Officer', profile.officers?.ceo),
      field('Secretary', profile.officers?.secretary),
      field('Chief Financial Officer', profile.officers?.cfo),
      field('Director(s)', profile.directors?.join('; ')),
    );
  }
  rows.push(field('Type of business', profile.businessType));
  if (agent.corporate) {
    rows.push(field('Agent for service of process (registered corporate agent, no address)', agent.name));
  } else {
    rows.push(field('Agent for service of process (individual)', agent.name), field('Agent street address in CA', agent.address));
  }
  return rows;
}
