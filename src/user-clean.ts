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
}

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

export async function cleanUsers(rows: readonly UserRow[], options: CleanUsersOptions = {}): Promise<CleanUsersResult> {
  const byEmail = new Map<string, UserRow[]>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email) continue;
    const list = byEmail.get(email);
    if (list) list.push(row);
    else byEmail.set(email, [row]);
  }

  const dropped: DroppedRow[] = [];
  const candidates: { email: string; name: string }[] = [];
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
    const name = group.map((r) => r.name.trim()).find((n) => n && !n.includes('@')) ?? '';
    candidates.push({ email, name });
  }

  const result = await cleanEmails(
    candidates.map((c) => ({ input: c.email, email: c.email })),
    { allowNoWebsite: true, ...options.cleaner },
  );
  const names = new Map(candidates.map((c) => [c.email, c.name]));
  const kept = result.valid.map((v) => ({ email: v.email, ...splitName(names.get(v.email.toLowerCase()) ?? '') }));
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

export function toCleanCsv(rows: readonly CleanedRow[]): string {
  return `${['email,first_name,last_name', ...rows.map((r) => [r.email, r.first_name, r.last_name].map(field).join(','))].join('\n')}\n`;
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
