/**
 * Subscribe one inbox to coupon and deal newsletters, a few sites at a time.
 *
 * c0upons.com reads its intake address (submit@c0upons.com) and posts the codes
 * those mails carry; this fills that inbox. Each catalog entry is a page with a
 * newsletter form. A run opens a few of them in TronBrowser, finds the email box,
 * types the address, presses the subscribe button, and records what the page
 * said. Double opt-in confirmations are not this tool's job: they arrive at the
 * intake, which follows the confirm link itself.
 *
 * Throttled from v1 (the standing rule for site automation): a ledger on disk
 * records every attempt; a site is tried at most MAX_ATTEMPTS times ever, never
 * twice within RETRY_AFTER_DAYS, never again once it subscribed or showed a
 * CAPTCHA; a run takes at most `max` sites and a day at most DAILY_CAP; one run
 * at a time (a lock file).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parseSnapshot } from './jobs-apply.ts';

export const MAX_ATTEMPTS = 2;
export const RETRY_AFTER_DAYS = 7;
export const DAILY_CAP = 8;

export interface Site {
  id: string;
  name: string;
  url: string;
  kind: 'deals' | 'coupons' | 'store';
}

export type Status = 'subscribed' | 'submitted' | 'captcha' | 'no-form' | 'error';

export interface Attempt {
  at: string;
  status: Status;
  note: string;
}

export interface SiteRecord {
  status: Status;
  attempts: Attempt[];
}

export interface Ledger {
  email: string | null;
  sites: Record<string, SiteRecord>;
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'cli-tools', 'dealsubs');
}

export function loadCatalog(path: string): Site[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { sites?: Site[] };
  const sites = raw.sites ?? [];
  const seen = new Set<string>();
  for (const s of sites) {
    if (!s.id || !s.url || seen.has(s.id)) throw new Error(`catalog: bad or duplicate entry ${JSON.stringify(s)}`);
    seen.add(s.id);
  }
  return sites;
}

export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return { email: null, sites: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as Ledger;
}

export function saveLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Attempts made since midnight UTC of `now`, across every site. */
export function attemptsToday(ledger: Ledger, now: Date): number {
  const day = now.toISOString().slice(0, 10);
  return Object.values(ledger.sites).reduce((n, s) => n + s.attempts.filter((a) => a.at.slice(0, 10) === day).length, 0);
}

/** Why a site is not due, or null when it is. */
export function notDue(record: SiteRecord | undefined, now: Date): string | null {
  if (!record) return null;
  if (record.status === 'subscribed') return 'already subscribed';
  if (record.status === 'captcha') return 'CAPTCHA: needs a person';
  if (record.attempts.length >= MAX_ATTEMPTS) return `gave up after ${record.attempts.length} attempts`;
  const last = record.attempts.at(-1);
  if (last && now.getTime() - Date.parse(last.at) < RETRY_AFTER_DAYS * 86_400_000) return 'tried in the last week';
  return null;
}

/** The sites this run should try, in catalog order, within the run and daily caps. */
export function planRun(catalog: Site[], ledger: Ledger, now: Date, max: number): Site[] {
  const room = Math.max(0, Math.min(max, DAILY_CAP - attemptsToday(ledger, now)));
  return catalog.filter((s) => notDue(ledger.sites[s.id], now) === null).slice(0, room);
}

export function record(ledger: Ledger, site: Site, status: Status, note: string, now: Date): void {
  const rec = (ledger.sites[site.id] ??= { status, attempts: [] });
  rec.status = status;
  rec.attempts.push({ at: now.toISOString(), status, note: note.slice(0, 300) });
}

/* ------------------------------ page reading ------------------------------ */

export interface Element {
  ref: string;
  role: string;
  name: string;
  required: boolean;
  value: string;
}

const NOT_NEWSLETTER = /search|password|zip|postal|phone|first name|last name|full name|coupon code|promo code|gift card|card number|message|comment/i;

/** The textbox to type the address into: one named like an email field. */
export function pickEmailField(elements: Element[]): Element | null {
  const boxes = elements.filter((e) => (e.role === 'textbox' || e.role === 'searchbox') && !e.value);
  const email = boxes.filter((e) => /e-?mail/i.test(e.name) && !NOT_NEWSLETTER.test(e.name));
  // A box that also says newsletter/subscribe/deals beats a login form's email box.
  return email.find((e) => /newsletter|subscribe|deal|offer|sign ?up|join|updates|inbox/i.test(e.name)) ?? email[0] ?? null;
}

const SUBMIT = /^(subscribe|sign ?up|sign me up|join|join now|get (deals|offers|my|the|it|access|\d+%|started)|submit|notify me|send|go|ok|unlock|claim|yes|count me in|keep me posted|→|›|>)/i;
const STRONG = /subscribe|sign ?up|join|notify|get (deals|offers)|keep me posted|count me in/i;
const NOT_SUBMIT = /log ?in|sign ?in|search|cart|account|apple|google|facebook|cancel|close|no thanks|unsubscribe/i;

/** The button that sends the form: the strongest subscribe-like name, never a login or social button. */
export function pickSubmitButton(elements: Element[], field: Element): Element | null {
  // A link counts only when its name is short: a deal tile that says "Join" is not a submit button.
  const buttons = elements.filter(
    (e) => (e.role === 'button' || (e.role === 'link' && e.name.length <= 30)) && e.name.length <= 60 && !NOT_SUBMIT.test(e.name),
  );
  const after = buttons.filter((b) => refNumber(b.ref) > refNumber(field.ref));
  const pool = after.length ? after : buttons;
  return pool.find((b) => STRONG.test(b.name)) ?? pool.find((b) => b.role === 'button' && SUBMIT.test(b.name.trim())) ?? null;
}

function refNumber(ref: string): number {
  return Number(ref.replace(/\D/g, '')) || 0;
}

/** Required checkboxes next to the form (consent, terms). Optional ones are left alone. */
export function requiredChecks(elements: Element[]): Element[] {
  return elements.filter((e) => e.role === 'checkbox' && e.required && !/true|checked/i.test(e.value));
}

export const SUCCESS =
  /thank(s| you)[^.]{0,40}(subscrib|sign|join)|you('|’)?re (in|on the list|subscribed|all set)|successfully subscribed|check your (inbox|e-?mail)|confirm(ation)? (e-?mail|link)|please confirm|welcome to (our|the)|subscription (confirmed|successful)|almost (done|there)|you have been subscribed|added to our (list|newsletter)/i;
export const CAPTCHA = /captcha|i('|’)?m not a robot|verify you are (a )?human|are you a robot|press (and|&) hold|turnstile|security check/i;
export const ALREADY = /already (subscribed|signed up|on (the|our) list|registered)/i;

export function classify(pageText: string): { status: Status; note: string } {
  if (ALREADY.test(pageText)) return { status: 'subscribed', note: 'site says already subscribed' };
  if (SUCCESS.test(pageText)) return { status: 'subscribed', note: (SUCCESS.exec(pageText)?.[0] ?? '').slice(0, 80) };
  if (CAPTCHA.test(pageText)) return { status: 'captcha', note: 'CAPTCHA or bot check on submit' };
  return { status: 'submitted', note: 'submitted; no thank-you text seen' };
}

/* ------------------------------- the browser ------------------------------- */

export interface Browser {
  call(name: string, args?: Record<string, unknown>): Promise<string>;
}

/** One site: open, find the box, type, press, read the verdict. Never throws. */
const INTERSTITIAL = /just a moment|performing security verification|checking your browser|attention required/i;

/**
 * A same-site link to the newsletter page, for a homepage that has no form of
 * its own ("Email Alerts", "Newsletter", "Sign up for deals"). Null when none.
 */
export function newsletterLink(snapshot: string, siteUrl: string): string | null {
  let host: string;
  try {
    host = new URL(siteUrl).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const links = [...snapshot.matchAll(/^@e\d+ (?:link|button) "((?:[^"\\]|\\.)*)" -> (\S+)/gm)].map((m) => ({ name: m[1]!, href: m[2]! }));
  const good = links.filter((l) => {
    try {
      const h = new URL(l.href).hostname.replace(/^www\./, '');
      if (h !== host && !h.endsWith(`.${host}`)) return false;
    } catch {
      return false;
    }
    if (/unsubscribe|youtube|rss|podcast|privacy|terms|gift card/i.test(`${l.name} ${l.href}`)) return false;
    return /newsletter|e-?mail (alerts?|sign ?up|list|deals|updates)|deal alerts|subscribe|sign up for (deals|emails|our)/i.test(l.name) ||
      /\/(newsletters?|email-?(alerts|signup|sign-up|preferences)|subscribe)(\/|$|\?|\.html)/i.test(new URL(l.href).pathname);
  });
  const rank = (l: { name: string; href: string }) =>
    /newsletter/i.test(l.name) ? 0 : /alerts?|subscribe/i.test(l.name) ? 1 : /\/features?\//i.test(l.href) ? 9 : 2;
  return good.filter((l) => rank(l) < 9).sort((a, b) => rank(a) - rank(b))[0]?.href ?? null;
}

async function settle(tron: Browser): Promise<string> {
  let text = JSON.stringify(await tron.call('browser_extract', { mode: 'text' }));
  if (INTERSTITIAL.test(text.slice(0, 400))) {
    // Cloudflare's interstitial usually hands off by itself after a few seconds.
    await tron.call('browser_wait', { ms: 9000 });
    text = JSON.stringify(await tron.call('browser_extract', { mode: 'text' }));
  }
  return text;
}

export async function subscribe(
  tron: Browser,
  site: Site,
  email: string,
  opts: { submit?: boolean } = {},
): Promise<{ status: Status; note: string }> {
  try {
    await tron.call('browser_open', { url: site.url });
    await tron.call('browser_wait', { ms: 3500 });
    let before = await settle(tron);
    if (INTERSTITIAL.test(before.slice(0, 400))) return { status: 'error', note: 'Cloudflare interstitial did not clear' };
    let snapshot = await tron.call('browser_snapshot');
    let elements = parseSnapshot(snapshot) as Element[];
    let field = pickEmailField(elements);
    let via = '';
    if (!field) {
      const link = newsletterLink(snapshot, site.url);
      if (link) {
        via = ` (via ${link})`;
        await tron.call('browser_open', { url: link });
        await tron.call('browser_wait', { ms: 3500 });
        before = await settle(tron);
      }
      // Footer forms often render only once scrolled into view.
      await tron.call('browser_scroll', { amount: 50_000 });
      await tron.call('browser_wait', { ms: 2500 });
      snapshot = await tron.call('browser_snapshot');
      elements = parseSnapshot(snapshot) as Element[];
      field = pickEmailField(elements);
      if (!field) {
        if (CAPTCHA.test(before)) return { status: 'captcha', note: `bot check on the page${via}` };
        return { status: 'no-form', note: `no email field on the page${via}` };
      }
    }
    const button = pickSubmitButton(elements, field);
    // No recognisable button: Enter in the box submits nearly every newsletter form.
    const how = button ? `clicked "${button.name}"` : 'pressed Enter';
    if (opts.submit === false) return { status: 'submitted', note: `probe: would fill "${field.name}" and ${how.replace('clicked', 'click').replace('pressed', 'press')}${via}` };
    for (const box of requiredChecks(elements)) await tron.call('browser_click', { ref: box.ref });
    await tron.call('browser_fill', { ref: field.ref, value: email });
    if (button) await tron.call('browser_click', { ref: button.ref });
    else await tron.call('browser_press', { key: 'Enter' });
    await tron.call('browser_wait', { ms: 4000 });
    const after = JSON.stringify(await tron.call('browser_extract', { mode: 'text' }));
    const verdict = classify(after);
    // Success text that was already on the page before we submitted proves nothing.
    if (verdict.status === 'subscribed' && SUCCESS.test(before) && !ALREADY.test(after)) {
      return { status: 'submitted', note: `${how}${via}; success wording was already on the page` };
    }
    return { ...verdict, note: `${how}${via}: ${verdict.note}` };
  } catch (err) {
    return { status: 'error', note: String((err as Error)?.message ?? err) };
  }
}

/* --------------------------------- locking --------------------------------- */

export function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* stale */
    }
    if (alive) throw new Error(`another dealsubs run is going (pid ${pid})`);
    writeFileSync(path, String(process.pid));
  }
  return fn().finally(() => rmSync(path, { force: true }));
}
