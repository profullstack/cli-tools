import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { JobsError } from './jobs-config.ts';
import type { Candidate } from './jobs-discover.ts';

/**
 * What has been sent, what is waiting, and what happened.
 *
 * Layout under the state directory:
 *
 *   applied.jsonl                 every posting ever handled, from any profile — the never-twice list
 *   history.jsonl                 an append-only audit log of every state-changing action
 *   runs/<id>.json                one apply run: its jobs and where each one got to
 *   profiles/<name>/shortlist.json   the last discovery
 *   profiles/<name>/queue.json       the postings approved for the next run
 *   profiles/<name>/results.jsonl    every outcome, one line each
 *   profiles/<name>/logs/<key>.log   the fill log of one job
 *   profiles/<name>/codes/<key>.txt  where a security code goes while a run waits
 *
 * applied.jsonl is shared with the scripts this was ported from, so rows are
 * only ever appended, never rewritten, and a row without the newer fields
 * (profile, run) is as good as one with them.
 */

export interface AppliedRow {
  url: string;
  company?: string;
  title?: string;
  /** submitted | unverified | skipped:<reason> | manual:<reason> */
  status: string;
  via?: string;
  profile?: string;
  run?: string;
  at: string;
}

export interface QueueItem {
  key: string;
  company: string;
  title: string;
  url: string;
  applyUrl: string;
  /** Finishes "{company}'s work on {focus}" in the why-us template. */
  focus: string | null;
}

export function readJsonl<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      // One torn line (a crash mid-append) must not hide every row after it.
      return [];
    }
  });
}

export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write through a temp file and rename, so a crash never leaves half a JSON document. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

// ---------------------------------------------------------------------------
// Never twice
// ---------------------------------------------------------------------------

/**
 * One identity for a posting, however it was linked.
 *
 * The same Greenhouse job is reachable as the board page, the embed form
 * (`?for=x&token=<id>`) and a company careers page (`?gh_jid=<id>`); an Ashby
 * or Lever job by its UUID with or without `/application` or `/apply`. The URL
 * alone would let the same application go out twice under two spellings.
 */
export function jobKey(url: string): string {
  const greenhouse =
    /greenhouse\.io\/(?:[^/]+\/)?jobs\/(\d+)/i.exec(url) ??
    /[?&](?:token|gh_jid)=(\d+)/i.exec(url);
  if (greenhouse) return `greenhouse:${greenhouse[1]}`;
  const uuid = /(?:ashbyhq\.com|lever\.co)\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url);
  if (uuid) return `${/ashby/i.test(url) ? 'ashby' : 'lever'}:${uuid[1]!.toLowerCase()}`;
  const workable = /workable\.com\/(?:[^/]+\/)?j\/([A-Z0-9]+)/i.exec(url);
  if (workable) return `workable:${workable[1]!.toUpperCase()}`;
  return url.trim().replace(/[#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

export function appliedPath(stateDir: string): string {
  return join(stateDir, 'applied.jsonl');
}

export function readApplied(stateDir: string): AppliedRow[] {
  return readJsonl<AppliedRow>(appliedPath(stateDir)).filter((row) => typeof row?.url === 'string');
}

/** A membership test over every posting already handled. */
export function appliedSet(rows: AppliedRow[]): (url: string) => boolean {
  const keys = new Set(rows.map((row) => jobKey(row.url)));
  return (url: string) => Boolean(url) && keys.has(jobKey(url));
}

export function recordApplied(stateDir: string, row: AppliedRow): void {
  appendJsonl(appliedPath(stateDir), row);
}

// ---------------------------------------------------------------------------
// Shortlist and queue
// ---------------------------------------------------------------------------

export const shortlistPath = (profileDir: string) => join(profileDir, 'shortlist.json');
export const queuePath = (profileDir: string) => join(profileDir, 'queue.json');
export const resultsPath = (profileDir: string) => join(profileDir, 'results.jsonl');
export const logPath = (profileDir: string, key: string) => join(profileDir, 'logs', `${key}.log`);
export const codePath = (profileDir: string, key: string) => join(profileDir, 'codes', `${key}.txt`);

export function readShortlist(profileDir: string): Candidate[] {
  return readJson<Candidate[]>(shortlistPath(profileDir), []);
}

export function readQueue(profileDir: string): QueueItem[] {
  return readJson<QueueItem[]>(queuePath(profileDir), []);
}

export function writeQueue(profileDir: string, queue: QueueItem[]): void {
  writeJsonAtomic(queuePath(profileDir), queue);
}

/** A short, file-safe, unique key: `acme-senior-software-engineer`. */
export function makeKey(company: string, title: string, taken: Set<string>): string {
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = `${slug(company).slice(0, 20)}-${slug(title).slice(0, 36)}`.replace(/-+$/, '') || 'job';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  return key;
}

/**
 * Add shortlist entries (by index) to the queue.
 *
 * An entry already queued, or already applied to, is reported rather than
 * added: the queue is what a run will send, and it should only hold what can
 * still be sent.
 */
export function queueAdd(
  queue: QueueItem[],
  shortlist: Candidate[],
  indexes: number[],
  focus: string | null,
  seen: (url: string) => boolean,
): { queue: QueueItem[]; added: QueueItem[]; skipped: string[] } {
  const next = [...queue];
  const added: QueueItem[] = [];
  const skipped: string[] = [];
  const taken = new Set(next.map((item) => item.key));
  const queued = new Set(next.map((item) => jobKey(item.url)));
  for (const index of indexes) {
    const pick = shortlist[index];
    if (!pick) {
      skipped.push(`#${index}: not in the shortlist (0–${shortlist.length - 1})`);
      continue;
    }
    if (queued.has(jobKey(pick.url))) {
      skipped.push(`#${index} ${pick.company}: already queued`);
      continue;
    }
    if (seen(pick.url) || seen(pick.applyUrl)) {
      skipped.push(`#${index} ${pick.company}: already applied or skipped`);
      continue;
    }
    const key = makeKey(pick.company, pick.title, taken);
    taken.add(key);
    queued.add(jobKey(pick.url));
    const item: QueueItem = { key, company: pick.company, title: pick.title, url: pick.url, applyUrl: pick.applyUrl, focus };
    next.push(item);
    added.push(item);
  }
  return { queue: next, added, skipped };
}

/** Find a queue item by key or by its position. */
export function findQueued(queue: QueueItem[], ref: string): QueueItem | undefined {
  return queue.find((item) => item.key === ref) ?? (/^\d+$/.test(ref) ? queue[Number(ref)] : undefined);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type HistoryType =
  | 'profile-add' | 'profile-set' | 'profile-rm' | 'profile-use' | 'profile-answer'
  | 'config-set' | 'config-unset'
  | 'discover'
  | 'queue-add' | 'queue-rm' | 'queue-clear' | 'queue-focus'
  | 'skip'
  | 'run-start' | 'run-stop' | 'run-restart' | 'run-resume' | 'run-finish' | 'run-crash'
  | 'job-start' | 'job-outcome' | 'job-abandoned' | 'awaiting-code' | 'code-provided';

export interface HistoryEvent {
  at: string;
  type: HistoryType;
  profile?: string;
  run?: string;
  key?: string;
  company?: string;
  url?: string;
  status?: string;
  reason?: string;
  /** Anything else worth keeping. Never a code, a password or a field's value. */
  detail?: Record<string, unknown>;
}

export const historyPath = (stateDir: string) => join(stateDir, 'history.jsonl');

export function logHistory(stateDir: string, event: Omit<HistoryEvent, 'at'> & { at?: string }): void {
  appendJsonl(historyPath(stateDir), { at: event.at ?? new Date().toISOString(), ...event });
}

/** `7d`, `12h`, `30m`, or a date — the start of a window ending now. */
export function parseSince(value: string, now: Date = new Date()): Date {
  const relative = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2]!.toLowerCase() as 'm' | 'h' | 'd' | 'w'];
    return new Date(now.getTime() - Number(relative[1]) * unit);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new JobsError(`--since takes 7d, 12h, 30m or a date, got "${value}"`);
  return date;
}

export interface HistoryFilter {
  profile?: string | undefined;
  run?: string | undefined;
  since?: Date | undefined;
  /** A type, or a prefix ending in `-` (`run-` is every run event). */
  types?: string[] | undefined;
}

export function filterHistory(events: HistoryEvent[], filter: HistoryFilter): HistoryEvent[] {
  return events.filter((event) => {
    if (filter.profile && event.profile !== filter.profile) return false;
    if (filter.run && event.run !== filter.run) return false;
    if (filter.since && new Date(event.at) < filter.since) return false;
    if (filter.types?.length && !filter.types.some((type) => (type.endsWith('-') ? event.type.startsWith(type) : event.type === type))) return false;
    return true;
  });
}

export function readHistory(stateDir: string): HistoryEvent[] {
  return readJsonl<HistoryEvent>(historyPath(stateDir));
}

export function formatHistory(events: HistoryEvent[]): string {
  return events
    .map((event) => {
      const who = [event.profile, event.run].filter(Boolean).join('/');
      const what = [event.company, event.key && !event.company ? event.key : '', event.status, event.reason]
        .filter(Boolean).join(' · ');
      const extra = event.detail ? ` ${JSON.stringify(event.detail)}` : '';
      return `${event.at.slice(0, 19).replace('T', ' ')}  ${event.type.padEnd(14)} ${who.padEnd(28)} ${what}${extra}`.trimEnd();
    })
    .join('\n');
}
