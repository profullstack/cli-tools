/**
 * user-export --clean: turn every account row into the list worth mailing.
 *
 * A newsletter that went to the raw export bounced at 16%, because the export
 * holds addresses nobody ever proved they own and addresses the mail provider
 * already gave up on. In order, an address is dropped when it is:
 *
 *   unsubscribed     opted out in myna (never mail them again)
 *   resend-*         bounced, suppressed or complained at Resend
 *   excluded         matches a config pattern (our own test accounts)
 *   never-logged-in  no row for it has a last_login: signups that never came
 *                    back bounced at 36%, against 3% for everyone else
 *   <cleaner reason> what email-cleaner rejects (syntax, dead domain,
 *                    disposable, role, duplicate ...)
 *
 * What is left comes out as email,first_name,last_name, one row per address.
 * Network access (Resend, DNS) is injectable so the tests never touch it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { cleanEmails, type CleanOptions } from './email-cleaner.ts';
import { domainOf, isWebmailDomain } from './mail.ts';
import type { UserRow } from './user-export.ts';

/** The `clean` block of user-export.json. Every field is optional. */
export interface CleanConfig {
  /** Regexes (case-insensitive) on the whole address; a match is dropped. */
  excludePatterns?: string[];
  /** Secret reference for the Resend key; default env:RESEND_API_KEY. "" turns Resend off. */
  resendKey?: string;
  /** How far back to read Resend's sends. Default 31. */
  resendDays?: number;
  /** myna's contacts.json; default ~/.config/myna/contacts.json. "" turns it off. */
  mynaContacts?: string;
}

export interface CleanedRow {
  email: string;
  first_name: string;
  last_name: string;
  /** The --full columns; '' when nothing knew them. */
  company_domain?: string;
  job_title?: string;
  linkedin_url?: string;
}

/** The columns `--full` writes, in order. */
export const FULL_COLUMNS = ['email', 'first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url'] as const;
export type ContactRow = Record<(typeof FULL_COLUMNS)[number], string>;

export interface DroppedRow {
  email: string;
  reason: string;
}

export interface CleanUsersResult {
  kept: CleanedRow[];
  dropped: DroppedRow[];
  /** Unique addresses that went in. */
  unique: number;
  counts: Record<string, number>;
}

export interface CleanUsersOptions {
  /** address -> reason, from the mail provider or anywhere else. */
  suppressed?: ReadonlyMap<string, string>;
  /** Addresses that unsubscribed. */
  optedOut?: ReadonlySet<string>;
  exclude?: readonly RegExp[];
  /** Keep addresses that never logged in. */
  keepNeverLoggedIn?: boolean;
  cleaner?: CleanOptions;
}

/** "Ada Lovelace King" -> Ada / Lovelace King. Handles and addresses are not names. */
export function splitName(name: string): { first_name: string; last_name: string } {
  const clean = name.trim();
  if (!clean || clean.includes('@') || /^[\w.-]+$/.test(clean) && !/^[A-Z]/.test(clean)) {
    return { first_name: '', last_name: '' };
  }
  const [first = '', ...rest] = clean.split(/\s+/);
  return { first_name: first, last_name: rest.join(' ') };
}

/**
 * Mail hosts mail.ts does not know, because nobody sends from them through
 * us, but whose addresses say nothing about an employer. substack.com is a
 * third of our list: publication handles, not people at Substack.
 */
const NOT_A_COMPANY = new Set([
  'substack.com', 'duck.com', 'qq.com', '163.com', '126.com', 'mail.ru', 'web.de', 'naver.com',
  // relay / alias services: the address hides the person, it names no employer
  'passmail.net', 'passinbox.com', 'passfwd.com', 'aleeas.com', 'simplelogin.com', 'simplelogin.co',
  'slmail.me', 'mozmail.com', 'anonaddy.com', 'anonaddy.me', 'addy.io', 'hidingmail.com', 'agentmail.to',
  'foxmail.com', 'free.fr', 'orange.fr', 'laposte.net', 'rambler.ru', 'list.ru', 'bk.ru', 'wp.pl', 'seznam.cz',
  'hotmail.co.uk', 'hotmail.fr', 'outlook.de', 'live.co.uk', 'yahoo.co.in', 'yahoo.co.jp',
  'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'btinternet.com', 'cox.net', 'charter.net',
]);

/** `https://www.Acme.com/about` -> `acme.com`. Webmail hosts are not companies. */
export function normalizeDomain(value: string): string {
  const host = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0] ?? '';
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !isWebmailDomain(host) && !NOT_A_COMPANY.has(host) ? host : '';
}

/** A LinkedIn profile URL from a URL, a bare `linkedin.com/in/x`, or a handle. Anything else is ''. */
export function normalizeLinkedin(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (/^[\w-]{3,100}$/.test(v)) return `https://www.linkedin.com/in/${v}`;
  const m = v.match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/((?:in|company|pub)\/[^?#\s]+)/i);
  return m ? `https://www.linkedin.com/${m[1]!.replace(/\/+$/, '')}` : '';
}

const first = (values: (string | undefined)[]) => values.map((v) => v?.trim() ?? '').find(Boolean) ?? '';

/**
 * One contact from every row that shares an address. Explicit first/last names
 * win over a split full name; the company is whatever a source said, else the
 * address's own domain unless that is webmail.
 */
const NOT_A_PERSON = /^(info|admin|support|sales|contact|hello|hi|team|office|mail|no|noreply|do|billing|accounts?|jobs|careers|hr|press|media|marketing|dev|test|user|bot|ai)$/;

/**
 * `scott.perry@acme.com` -> Scott / Perry. Only the unambiguous shape counts:
 * two alphabetic parts of two or more letters joined by `.`, `_` or `-`.
 * `jsmith`, `john.s` and `john.smith42` say too little to be a name.
 */
export function nameFromEmail(email: string): { first_name: string; last_name: string } {
  const local = email.slice(0, email.lastIndexOf('@')).toLowerCase().replace(/\+.*$/, '');
  const m = local.match(/^([a-z]{2,})[._-]([a-z]{2,})$/);
  if (!m || NOT_A_PERSON.test(m[1]!) || NOT_A_PERSON.test(m[2]!)) return { first_name: '', last_name: '' };
  const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
  return { first_name: cap(m[1]!), last_name: cap(m[2]!) };
}

export function buildContact(email: string, group: readonly UserRow[]): ContactRow {
  let split = splitName(group.map((r) => r.name.trim()).find((n) => n && !n.includes('@')) ?? '');
  const firstName = first(group.map((r) => r.first_name));
  // a name nobody gave us, but the address spells out
  if (!firstName && !split.first_name && !split.last_name) split = nameFromEmail(email);
  return {
    email,
    first_name: firstName || split.first_name,
    last_name: firstName ? first(group.map((r) => r.last_name)) : split.last_name,
    company_domain: first(group.map((r) => normalizeDomain(r.company_domain ?? ''))) || normalizeDomain(domainOf(email)),
    job_title: first(group.map((r) => r.job_title)),
    linkedin_url: first(group.map((r) => normalizeLinkedin(r.linkedin_url ?? ''))),
  };
}

function groupByEmail(rows: readonly UserRow[]): Map<string, UserRow[]> {
  const byEmail = new Map<string, UserRow[]>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email) continue;
    const list = byEmail.get(email);
    if (list) list.push(row);
    else byEmail.set(email, [row]);
  }
  return byEmail;
}

/** Every address once, uncleaned: `--full` without `--clean`. */
export function toContacts(rows: readonly UserRow[]): ContactRow[] {
  return [...groupByEmail(rows)].map(([email, group]) => buildContact(email, group));
}

export interface EnrichResult {
  contacts: ContactRow[];
  /** column -> how many contacts it was filled in for. */
  filled: Record<string, number>;
  /** Contacts that at least one enrichment row matched. */
  matched: number;
}

/**
 * Fill each contact's blank fields from `found` (rows read from the config's
 * `enrich` sources), matched by email. A field a contact already has is never
 * overwritten, and sources earlier in the config win over later ones.
 */
export function enrichContacts(contacts: readonly CleanedRow[], found: readonly UserRow[]): EnrichResult {
  const byEmail = groupByEmail(found);
  const filled: Record<string, number> = {};
  let matched = 0;
  const out = contacts.map((contact) => {
    const base: ContactRow = Object.fromEntries(FULL_COLUMNS.map((c) => [c, contact[c] ?? ''])) as ContactRow;
    const group = byEmail.get(contact.email.toLowerCase());
    if (!group) return base;
    matched += 1;
    const extra = buildContact(base.email, group);
    const bump = (column: string) => (filled[column] = (filled[column] ?? 0) + 1);
    if (!base.first_name && !base.last_name && (extra.first_name || extra.last_name)) {
      base.first_name = extra.first_name;
      base.last_name = extra.last_name;
      bump('name');
    }
    // A company a source names beats one guessed from the address's domain.
    const sourced = first(group.map((r) => normalizeDomain(r.company_domain ?? '')));
    const guessed = normalizeDomain(domainOf(base.email));
    if (sourced && sourced !== base.company_domain && (!base.company_domain || base.company_domain === guessed)) {
      base.company_domain = sourced;
      bump('company_domain');
    }
    for (const column of ['job_title', 'linkedin_url'] as const) {
      if (!base[column] && extra[column]) {
        base[column] = extra[column];
        bump(column);
      }
    }
    return base;
  });
  return { contacts: out, filled, matched };
}

export async function cleanUsers(rows: readonly UserRow[], options: CleanUsersOptions = {}): Promise<CleanUsersResult> {
  const byEmail = groupByEmail(rows);

  const dropped: DroppedRow[] = [];
  const candidates: { email: string; group: UserRow[] }[] = [];
  for (const [email, group] of byEmail) {
    const reason = options.optedOut?.has(email)
      ? 'unsubscribed'
      : options.suppressed?.has(email)
        ? `resend-${options.suppressed.get(email)}`
        : options.exclude?.some((re) => re.test(email))
          ? 'excluded'
          : !options.keepNeverLoggedIn && group.every((r) => !r.last_login.trim())
            ? 'never-logged-in'
            : '';
    if (reason) {
      dropped.push({ email, reason });
      continue;
    }
    candidates.push({ email, group });
  }

  const result = await cleanEmails(
    candidates.map((c) => ({ input: c.email, email: c.email })),
    { allowNoWebsite: true, ...options.cleaner },
  );
  const groups = new Map(candidates.map((c) => [c.email, c.group]));
  const kept = result.valid.map((v) => buildContact(v.email, groups.get(v.email.toLowerCase()) ?? []));
  for (const bad of result.invalid) dropped.push({ email: bad.email, reason: bad.reasons.join('+') || 'invalid' });

  const counts: Record<string, number> = {};
  for (const d of dropped) counts[d.reason] = (counts[d.reason] ?? 0) + 1;
  return { kept, dropped, unique: byEmail.size, counts };
}

/** Addresses opted out in myna's contacts.json. A missing file is an empty set. */
export function mynaOptOuts(path: string): Set<string> {
  const out = new Set<string>();
  if (!path || !existsSync(path)) return out;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const contacts = data?.contacts ?? data;
  for (const c of Array.isArray(contacts) ? contacts : Object.values(contacts ?? {})) {
    const contact = c as { email?: string; optedOut?: unknown; optOut?: unknown };
    if ((contact.optedOut || contact.optOut) && contact.email) out.add(contact.email.trim().toLowerCase());
  }
  return out;
}

export const RESEND_DROP_EVENTS = ['bounced', 'suppressed', 'complained'] as const;

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Every address Resend bounced, suppressed or got a complaint about in the last
 * `days`, newest event per send. Resend's list is newest first and paged by id.
 */
export async function resendSuppressions(
  apiKey: string,
  { days = 31, fetchImpl = fetch as unknown as Fetch, now = Date.now(), pauseMs = 550 } = {},
): Promise<Map<string, string>> {
  const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const out = new Map<string, string>();
  let after = '';
  for (;;) {
    const url = `https://api.resend.com/emails?limit=100${after ? `&after=${after}` : ''}`;
    let res: Awaited<ReturnType<Fetch>> | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'cli-tools user-export' } });
      if (res.ok || (res.status !== 429 && res.status < 500)) break;
      await sleep(pauseMs * (attempt + 2));
    }
    if (!res?.ok) throw new Error(`Resend /emails answered ${res?.status}`);
    const body = (await res.json()) as { data?: { id: string; to?: string[]; created_at: string; last_event?: string }[]; has_more?: boolean };
    const page = body.data ?? [];
    for (const mail of page) {
      if (mail.created_at.slice(0, 10) < cutoff) continue;
      if (!RESEND_DROP_EVENTS.includes(mail.last_event as (typeof RESEND_DROP_EVENTS)[number])) continue;
      for (const to of mail.to ?? []) out.set(to.trim().toLowerCase(), mail.last_event!);
    }
    const last = page.at(-1);
    if (!last || !body.has_more || last.created_at.slice(0, 10) < cutoff) break;
    after = last.id;
    if (pauseMs) await sleep(pauseMs);
  }
  return out;
}

export function defaultMynaContacts(): string {
  return `${homedir()}/.config/myna/contacts.json`;
}

export function toCleanCsv(rows: readonly CleanedRow[], { full = false } = {}): string {
  const columns = full ? FULL_COLUMNS : (['email', 'first_name', 'last_name'] as const);
  return `${[columns.join(','), ...rows.map((r) => columns.map((c) => field(r[c] ?? '')).join(','))].join('\n')}\n`;
}

/**
 * Explee's campaign import (POST /public/api/v1/autogtm/campaigns/import)
 * silently skips any lead without all five of these; linkedin_url is optional.
 */
export const EXPLEE_REQUIRED = ['email', 'first_name', 'last_name', 'company_domain', 'job_title'] as const;

export interface MissingRow {
  email: string;
  /** The required columns this row has no value for, joined with '+'. */
  missing: string;
}

export interface ExpleeResult {
  kept: ContactRow[];
  missing: MissingRow[];
  /** column -> rows it was missing from. */
  counts: Record<string, number>;
}

/**
 * Only the rows Explee will import, and for the rest exactly which required
 * columns they lack. `defaultTitle` fills a blank job_title (Explee's writer
 * uses the title in its copy, so a generic one reads as generic).
 */
export function forExplee(rows: readonly CleanedRow[], { defaultTitle = '' } = {}): ExpleeResult {
  const result: ExpleeResult = { kept: [], missing: [], counts: {} };
  for (const row of rows) {
    const contact = Object.fromEntries(FULL_COLUMNS.map((c) => [c, (row[c] ?? '').trim()])) as ContactRow;
    if (!contact.job_title && defaultTitle) contact.job_title = defaultTitle;
    const gaps = EXPLEE_REQUIRED.filter((c) => !contact[c]);
    if (gaps.length === 0) {
      result.kept.push(contact);
    } else {
      result.missing.push({ email: contact.email, missing: gaps.join('+') });
      for (const g of gaps) result.counts[g] = (result.counts[g] ?? 0) + 1;
    }
  }
  return result;
}

export function toMissingCsv(rows: readonly MissingRow[]): string {
  return `${['email,missing', ...rows.map((r) => [r.email, r.missing].map(field).join(','))].join('\n')}\n`;
}

export function formatExpleeSummary(r: ExpleeResult): string {
  const lines = [`explee: ${r.kept.length} importable, ${r.missing.length} skipped for a missing required column`];
  for (const [column, n] of Object.entries(r.counts).sort((a, b) => b[1] - a[1])) lines.push(`  no ${column.padEnd(19)} ${n}`);
  return `${lines.join('\n')}\n`;
}

export function formatEnrichSummary(result: EnrichResult, total: number): string {
  const lines = [`enrich: ${result.matched} of ${total} contacts matched`];
  for (const [column, n] of Object.entries(result.filled)) lines.push(`  ${column.padEnd(22)} +${n}`);
  return `${lines.join('\n')}\n`;
}

export function toDroppedCsv(rows: readonly DroppedRow[]): string {
  return `${['email,reason', ...rows.map((r) => [r.email, r.reason].map(field).join(','))].join('\n')}\n`;
}

export function formatCleanSummary(result: CleanUsersResult): string {
  const lines = [`clean: ${result.unique} unique addresses, ${result.kept.length} kept, ${result.dropped.length} dropped`];
  for (const [reason, n] of Object.entries(result.counts).sort((a, b) => b[1] - a[1])) lines.push(`  ${reason.padEnd(22)} ${n}`);
  return `${lines.join('\n')}\n`;
}

function field(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
