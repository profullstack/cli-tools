/**
 * gh-pulse — what moved on GitHub since yesterday, ranked, with traffic.
 *
 * Every repo the `gh` token can see (yours plus every org you belong to,
 * forks excluded) is checked for movement since the previous run: stars,
 * forks, commits, pull requests, issues, releases, and the traffic GitHub
 * shows at /graphs/traffic (views, unique visitors, clones, referrers,
 * popular content). Movers are ranked by a weighted score and emailed with
 * their traffic; the top ones get a 14-day chart.
 *
 * WHY THE WINDOW IS A SNAPSHOT, NOT A CLOCK. GitHub publishes traffic in
 * UTC-day buckets one to two days late: at 03:00 UTC the newest bucket with
 * anything in it is usually the day before yesterday, and some repos carry
 * empty buckets padded up to today. "The last 24 hours" read off the clock is
 * therefore zero for almost everything. What can be measured exactly is the
 * growth of each bucket since the previous run, so that is the window: it is
 * "since the last email", and a skipped day widens it instead of losing data.
 * Follower changes work the same way from a stored list of logins, which is
 * also what lets new and lost followers be named.
 *
 * WHY THE SNAPSHOTS MATTER. GitHub keeps traffic for 14 days and nothing
 * else. Every run writes the raw per-repo counts and buckets, gzipped and
 * dated, under the data dir. Those files are the only long-run record, and
 * they are what `gh-pulse show` and any downstream dataset read.
 *
 * Pure functions (scoring, windows, rendering) are exported for tests; the
 * network and the filesystem enter only through `run()` and its `deps`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

// ---------------------------------------------------------------- types

export interface Bucket {
  timestamp: string;
  count: number;
  uniques: number;
}

export interface Day {
  day: string;
  count: number;
  uniques: number;
}

export interface Ref {
  n: number;
  t: string;
  u: string;
  url: string;
}

export interface Movement {
  stars: number;
  forks: number;
  commits: number;
  authors: string[];
  prOpened: number;
  prMerged: number;
  prClosed: number;
  issuesOpened: number;
  issuesClosed: number;
  releases: number;
  views: number;
  uniques: number;
  clones: number;
  cloners: number;
  newStargazers: string[];
  newForks: string[];
  mergedPrs: Ref[];
  openedPrs: Ref[];
  openedIssues: Ref[];
  releaseList: { tag: string; url: string }[];
  score: number;
  mover: boolean;
}

export interface Referrer {
  referrer: string;
  count: number;
  uniques: number;
}

export interface PopularPath {
  path: string;
  title?: string;
  count: number;
  uniques: number;
}

/** What GitHub says about a repo in the listing; the fields this tool reads. */
export interface RepoInfo {
  id: number;
  full_name: string;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
  updated_at: string;
}

/** One repo's row in a snapshot file. */
export interface RepoSnapshot {
  id: number;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string;
  private: boolean;
  archived: boolean;
  views: Bucket[] | null;
  clones: Bucket[] | null;
  referrers?: Referrer[];
  paths?: PopularPath[];
  movement?: Movement;
}

export interface Snapshot {
  at: string;
  user: string;
  followersCount: number;
  followers: string[];
  repos: Record<string, RepoSnapshot>;
}

export interface RepoState {
  repo: RepoInfo;
  views: Bucket[] | null;
  clones: Bucket[] | null;
  trafficOk: boolean;
  m: Movement;
  referrers?: Referrer[];
  paths?: PopularPath[];
  img?: string;
}

export interface Portfolio {
  views: number;
  uniques: number;
  clones: number;
  cloners: number;
  viewsByDay: Map<string, number>;
  clonesByDay: Map<string, number>;
}

export interface ReportContext {
  login: string;
  now: Date;
  cutoff: Date;
  useBaseline: boolean;
  newestDay: string;
  trafficLabel: string;
  repoCount: number;
  movers: RepoState[];
  detailed: RepoState[];
  followers: string[];
  followerMoves: { gained: string[]; lost: string[] };
  totalStars: number;
  prevTotalStars: number | null;
  port: Portfolio;
  trafficBlind: number;
  portfolioImg: string;
  /** Set by a range scan; the daily run leaves it out. */
  range?: RangeInfo;
  /** The per-repo day series a range scan charts; the daily run uses fourteenDays. */
  series?: (x: RepoState, kind: 'views' | 'clones') => Day[];
}

export interface RangeInfo {
  key: RangeKey | 'custom';
  label: string;
  since: string;
  fromDay: string;
  toDay: string;
  coverage: string;
  partialRepos: number;
  days: number;
}

export interface Image {
  id: string;
  buf: Buffer;
}

export interface RunOptions {
  dryRun: boolean;
  to: string;
  top: number;
  repos: string[];
  hours: number;
  dataDir: string;
  from: string;
}

export interface RunDeps {
  fetch: typeof fetch;
  now: () => Date;
  token: () => string;
  log: (line: string) => void;
  resendKey: () => string | undefined;
  render: (svg: string) => Buffer;
}

export interface RunResult {
  subject: string;
  movers: number;
  repos: number;
  sent: boolean;
  snapshot: string | null;
  html: string;
  calls: number;
}

// ---------------------------------------------------------------- paths

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['GH_PULSE_DATA'] ?? join(homedir(), '.local', 'share', 'gh-pulse');
}

export const DEFAULT_FROM = 'GitHub Pulse <pulse@profullstack.com>';

/**
 * cron gets no environment; the house vault export is the fallback. Only
 * variables that are not already set are taken, so a shell wins over the file.
 */
export function loadShellEnv(env: NodeJS.ProcessEnv = process.env, file = join(homedir(), '.config', 'logicsrc', 'shell.env')): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m || env[m[1]!] !== undefined) continue;
    env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

export function ghToken(): string {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('gh is not logged in (gh auth token failed)');
  }
}

export function gitEmail(): string {
  try {
    return execFileSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- scoring

export const WEIGHTS = {
  star: 5,
  fork: 4,
  unique: 1,
  view: 0.2,
  clone: 0.5,
  cloner: 1,
  commit: 1,
  prOpened: 2,
  prMerged: 3,
  prClosed: 0.5,
  issueOpened: 2,
  issueClosed: 1,
  release: 5,
} as const;

export const COMMIT_CAP = 25;

export function emptyMovement(): Movement {
  return {
    stars: 0, forks: 0, commits: 0, authors: [], prOpened: 0, prMerged: 0, prClosed: 0,
    issuesOpened: 0, issuesClosed: 0, releases: 0, views: 0, uniques: 0, clones: 0, cloners: 0,
    newStargazers: [], newForks: [], mergedPrs: [], openedPrs: [], openedIssues: [], releaseList: [],
    score: 0, mover: false,
  };
}

export function score(m: Movement): number {
  const W = WEIGHTS;
  return Math.max(0, m.stars) * W.star + Math.max(0, m.forks) * W.fork + m.uniques * W.unique + m.views * W.view +
    m.clones * W.clone + m.cloners * W.cloner + Math.min(m.commits, COMMIT_CAP) * W.commit +
    m.prOpened * W.prOpened + m.prMerged * W.prMerged + m.prClosed * W.prClosed +
    m.issuesOpened * W.issueOpened + m.issuesClosed * W.issueClosed + m.releases * W.release;
}

/**
 * Movement worth a line. One clone a day is background noise across a long
 * tail of repos (mirrors, CI), so traffic-only movement needs two unique
 * visitors or two unique cloners; any event at all counts.
 */
export function isMover(m: Movement): boolean {
  return m.stars !== 0 || m.forks !== 0 || m.commits > 0 || m.prOpened > 0 || m.prMerged > 0 || m.prClosed > 0 ||
    m.issuesOpened > 0 || m.issuesClosed > 0 || m.releases > 0 || m.uniques >= 2 || m.cloners >= 2;
}

// ---------------------------------------------------------------- windows

/**
 * Growth of the 14-day traffic buckets since the previous snapshot. A bucket
 * present in both counts only what it gained; a bucket new since last time
 * counts in full; a bucket that rolled off is gone and irrelevant. Without a
 * baseline, every bucket on or after `firstRunSince` counts.
 */
export function trafficDelta(cur: Bucket[] | null, prev: Bucket[] | null | undefined, firstRunSince: string): { count: number; uniques: number } {
  if (!cur) return { count: 0, uniques: 0 };
  const pm = new Map((prev ?? []).map((b) => [b.timestamp, b]));
  let count = 0;
  let uniques = 0;
  for (const b of cur) {
    if (prev) {
      const p = pm.get(b.timestamp);
      count += Math.max(0, b.count - (p ? p.count : 0));
      uniques += Math.max(0, b.uniques - (p ? p.uniques : 0));
    } else if (b.timestamp.slice(0, 10) >= firstRunSince) {
      count += b.count;
      uniques += b.uniques;
    }
  }
  return { count, uniques };
}

/** The newest UTC day on which any bucket recorded something, else `fallback`. */
export function newestDay(all: Iterable<Bucket[] | null>, fallback: string): string {
  let best = '';
  for (const buckets of all) {
    for (const b of buckets ?? []) {
      const day = b.timestamp.slice(0, 10);
      if (b.count > 0 && day > best) best = day;
    }
  }
  return best || fallback;
}

/** Fourteen days ending on `endDay`, zero-filled, oldest first. */
export function fourteenDays(buckets: Bucket[] | null, endDay: string): Day[] {
  const m = new Map((buckets ?? []).map((b) => [b.timestamp.slice(0, 10), b]));
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const out: Day[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = new Date(end - i * 86400000).toISOString().slice(0, 10);
    const b = m.get(day);
    out.push({ day, count: b ? b.count : 0, uniques: b ? b.uniques : 0 });
  }
  return out;
}

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The previous snapshot is the baseline when it is plausibly "yesterday's":
 * older than six hours (a re-run minutes later would report nothing) and
 * younger than four days (after that the clock window is the honest one).
 */
export function baselineFor(prev: Snapshot | null, now: Date): Snapshot | null {
  if (!prev) return null;
  const ageH = (now.getTime() - Date.parse(prev.at)) / 3600000;
  return ageH >= 6 && ageH <= 96 ? prev : null;
}

// ---------------------------------------------------------------- ranges

export const RANGE_KEYS = ['hour', 'day', 'week', 'month', 'quarter', 'year', 'all'] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

const DAY_MS = 86400000;
export const RANGE_MS: Record<RangeKey, number> = {
  hour: 3600000, day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, quarter: 91 * DAY_MS, year: 365 * DAY_MS, all: Number.POSITIVE_INFINITY,
};
export const RANGE_LABEL: Record<RangeKey, string> = {
  hour: 'last hour', day: 'last 24 hours', week: 'last 7 days', month: 'last 30 days', quarter: 'last 90 days', year: 'last 365 days', all: 'all time',
};
const RANGE_ALIASES: Record<string, RangeKey> = {
  h: 'hour', '1h': 'hour', hour: 'hour', lasthour: 'hour',
  d: 'day', '1d': 'day', '24h': 'day', day: 'day', today: 'day', yesterday: 'day', lastday: 'day',
  w: 'week', '7d': 'week', '1w': 'week', week: 'week', lastweek: 'week',
  m: 'month', '30d': 'month', '1m': 'month', month: 'month', lastmonth: 'month',
  q: 'quarter', '90d': 'quarter', '3m': 'quarter', quarter: 'quarter', lastquarter: 'quarter',
  y: 'year', '365d': 'year', '1y': 'year', '12m': 'year', year: 'year', lastyear: 'year',
  a: 'all', all: 'all', alltime: 'all', 'all-time': 'all', ever: 'all', forever: 'all',
};

/** What one report covers: a named range, or a custom start date. */
export interface RangeSpec {
  key: RangeKey | 'custom';
  since: Date;
  label: string;
  /** File-safe name for out/range/<slug>.* */
  slug: string;
}

export function parseRangeKey(text: string): RangeKey | null {
  return RANGE_ALIASES[text.trim().toLowerCase().replace(/[\s_]+/g, '')] ?? null;
}

export function rangeSpec(key: RangeKey, now: Date): RangeSpec {
  const since = key === 'all' ? new Date(0) : new Date(now.getTime() - RANGE_MS[key]);
  return { key, since, label: RANGE_LABEL[key], slug: key };
}

/** The cache name: a `--repo` subset gets its own file so the TUI never shows three repos as the whole portfolio. */
export const rangeSlug = (spec: RangeSpec, repos: readonly string[]): string => (repos.length ? `${spec.slug}-subset` : spec.slug);

export function customRange(sinceText: string, now: Date): RangeSpec {
  const t = Date.parse(sinceText.length === 10 ? `${sinceText}T00:00:00Z` : sinceText);
  if (!Number.isFinite(t) || t > now.getTime()) throw new Error(`--since wants a past date like 2026-09-01, not ${sinceText}`);
  const since = new Date(t);
  return { key: 'custom', since, label: `since ${since.toISOString().slice(0, 10)}`, slug: `since-${since.toISOString().slice(0, 10)}` };
}

export const rangeDays = (spec: RangeSpec, now: Date): number =>
  spec.key === 'all' ? Number.POSITIVE_INFINITY : Math.max(1, Math.ceil((now.getTime() - spec.since.getTime()) / DAY_MS));

/** Commits are capped per day so one busy afternoon cannot outrank a star; longer ranges get a proportionally larger cap. */
export const commitCapFor = (days: number): number => (Number.isFinite(days) ? COMMIT_CAP * Math.max(1, days) : Number.POSITIVE_INFINITY);

/** How many pages each endpoint may be walked for a range. Longer ranges pay more; `all` pays what it takes, within reason. */
export interface PageBudget { commits: number; pulls: number; issues: number; releases: number; stars: number; forks: number }
export function pageBudget(key: RangeKey | 'custom' | 'daily', days = 1): PageBudget {
  const k = key === 'custom' ? (days <= 1 ? 'day' : days <= 7 ? 'week' : days <= 31 ? 'month' : days <= 92 ? 'quarter' : days <= 366 ? 'year' : 'all') : key;
  switch (k) {
    case 'daily': case 'hour': case 'day': return { commits: 3, pulls: 1, issues: 2, releases: 1, stars: 2, forks: 1 };
    case 'week': return { commits: 5, pulls: 3, issues: 3, releases: 1, stars: 3, forks: 1 };
    case 'month': return { commits: 15, pulls: 10, issues: 8, releases: 2, stars: 5, forks: 2 };
    case 'quarter': return { commits: 30, pulls: 20, issues: 15, releases: 3, stars: 10, forks: 3 };
    case 'year': return { commits: 60, pulls: 40, issues: 30, releases: 5, stars: 20, forks: 5 };
    default: return { commits: 100, pulls: 100, issues: 100, releases: 10, stars: 60, forks: 10 };
  }
}

// ---------------------------------------------------------------- ledger
//
// GitHub keeps traffic for fourteen days. Every daily snapshot stores that
// window, so laying the snapshots end to end gives a per-repo, per-day series
// that only grows. The newest snapshot that mentions a day wins, because
// GitHub revises a day's numbers for a while after first publishing them.

export interface Ledger {
  views: Map<string, Map<string, Bucket>>;
  clones: Map<string, Map<string, Bucket>>;
  /** One point per snapshot, oldest first. */
  points: { at: string; stars: number; followers: string[]; starsByRepo: Map<string, number>; forksByRepo: Map<string, number> }[];
  firstDay: string | null;
}

export function buildLedger(snapshots: Snapshot[]): Ledger {
  const ledger: Ledger = { views: new Map(), clones: new Map(), points: [], firstDay: null };
  for (const s of [...snapshots].sort((a, b) => a.at.localeCompare(b.at))) {
    const starsByRepo = new Map<string, number>();
    const forksByRepo = new Map<string, number>();
    let stars = 0;
    for (const [name, r] of Object.entries(s.repos)) {
      starsByRepo.set(name, r.stars);
      forksByRepo.set(name, r.forks);
      stars += r.stars;
      mergeBuckets(ledger, name, r.views, r.clones);
    }
    ledger.points.push({ at: s.at, stars, followers: s.followers, starsByRepo, forksByRepo });
  }
  return ledger;
}

export function mergeBuckets(ledger: Ledger, name: string, views: Bucket[] | null, clones: Bucket[] | null): void {
  for (const [kind, buckets] of [['views', views], ['clones', clones]] as const) {
    if (!buckets) continue;
    let m = ledger[kind].get(name);
    if (!m) { m = new Map(); ledger[kind].set(name, m); }
    for (const b of buckets) {
      const day = b.timestamp.slice(0, 10);
      m.set(day, { timestamp: `${day}T00:00:00Z`, count: b.count, uniques: b.uniques });
      if (ledger.firstDay === null || day < ledger.firstDay) ledger.firstDay = day;
    }
  }
}

/** Views or clones for one repo between two days inclusive. */
export function ledgerSum(series: Map<string, Bucket> | undefined, fromDay: string, toDay: string): { count: number; uniques: number } {
  let count = 0;
  let uniques = 0;
  for (const [day, b] of series ?? []) {
    if (day >= fromDay && day <= toDay) { count += b.count; uniques += b.uniques; }
  }
  return { count, uniques };
}

/** A zero-filled day series between two days inclusive, oldest first. */
export function ledgerDays(series: Map<string, Bucket> | undefined, fromDay: string, toDay: string): Day[] {
  const out: Day[] = [];
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for (let t = start; t <= end; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const b = series?.get(day);
    out.push({ day, count: b ? b.count : 0, uniques: b ? b.uniques : 0 });
  }
  return out;
}

/** Fold a long day series into at most `maxBars` bars so a year still reads as a chart. Each bar is labelled by its first day. */
export function foldDays(days: Day[], maxBars: number): Day[] {
  if (days.length <= maxBars) return days;
  const size = Math.ceil(days.length / maxBars);
  const out: Day[] = [];
  for (let i = 0; i < days.length; i += size) {
    const chunk = days.slice(i, i + size);
    out.push({ day: chunk[0]!.day, count: chunk.reduce((t, d) => t + d.count, 0), uniques: chunk.reduce((t, d) => t + d.uniques, 0) });
  }
  return out;
}

/**
 * The newest snapshot taken at or before `since`, else null. A snapshot from
 * inside the range is not a baseline: measured against it, a week's stars
 * would shrink to whatever arrived since this morning.
 */
export function pointAt(ledger: Ledger, since: Date): Ledger['points'][number] | null {
  const sinceIso = since.toISOString();
  let before: Ledger['points'][number] | null = null;
  for (const p of ledger.points) {
    if (p.at <= sinceIso) before = p;
    else break;
  }
  return before;
}

// ---------------------------------------------------------------- snapshots

export function snapshotsDir(dir: string): string {
  return join(dir, 'snapshots');
}

export function readSnapshot(file: string): Snapshot {
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Snapshot;
}

export function listSnapshots(dir: string): string[] {
  const d = snapshotsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json.gz')).sort().map((f) => join(d, f));
}

export function latestSnapshot(dir: string, log: (s: string) => void = () => {}): Snapshot | null {
  const files = listSnapshots(dir);
  const file = files[files.length - 1];
  if (!file) return null;
  try {
    return readSnapshot(file);
  } catch (error) {
    log(`unreadable snapshot ${file}: ${(error as Error).message}`);
    return null;
  }
}

export function writeSnapshot(dir: string, snap: Snapshot): string {
  const d = snapshotsDir(dir);
  mkdirSync(d, { recursive: true });
  const file = join(d, `${snap.at.slice(0, 13)}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify(snap)));
  return file;
}

// ---------------------------------------------------------------- github

export class GitHub {
  readonly calls = { made: 0, retries: 0 };
  remaining: number | null = null;
  private readonly queue: (() => void)[] = [];
  private active = 0;
  // Explicit fields rather than constructor parameter properties: Node's type
  // stripping accepts only syntax it can erase, and this is the one construct
  // in the repo it refuses (see gh.ts).
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly concurrency: number;

  constructor(token: string, fetchImpl: typeof fetch, concurrency = 6) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.concurrency = concurrency;
  }

  /** Run `fn` when a slot is free; six at a time keeps clear of the abuse limits. */
  limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        fn().then(resolve, reject).finally(() => {
          this.active -= 1;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.concurrency) start();
      else this.queue.push(start);
    });
  }

  async get<T>(pathOrUrl: string, options: { accept?: string; allow?: number[] } = {}): Promise<{ data: T | null; link: string; status: number }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
    for (let attempt = 0; ; attempt += 1) {
      this.calls.made += 1;
      const r = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: options.accept ?? 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'gh-pulse (cli-tools)',
        },
      });
      const rem = r.headers.get('x-ratelimit-remaining');
      if (rem !== null) this.remaining = Number(rem);
      if (r.ok) return { data: (await r.json()) as T, link: r.headers.get('link') ?? '', status: r.status };
      if (options.allow?.includes(r.status)) return { data: null, link: '', status: r.status };
      const retryable = r.status === 429 || r.status === 502 || r.status === 503 ||
        (r.status === 403 && (r.headers.get('retry-after') !== null || rem === '0'));
      if (retryable && attempt < 4) {
        this.calls.retries += 1;
        let wait = Number(r.headers.get('retry-after') ?? 0) * 1000;
        if (!wait && rem === '0') wait = Math.max(0, Number(r.headers.get('x-ratelimit-reset')) * 1000 - Date.now()) + 1000;
        if (!wait) wait = 2000 * (attempt + 1);
        await new Promise((s) => setTimeout(s, Math.min(wait, 120000)));
        continue;
      }
      const body = await r.text().catch(() => '');
      throw new Error(`GitHub ${r.status} for ${url}: ${body.slice(0, 200)}`);
    }
  }

  async all<T>(path: string, options: { accept?: string; allow?: number[]; max?: number } = {}): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = path;
    for (let i = 0; url && i < (options.max ?? 20); i += 1) {
      const { data, link } = await this.get<T[]>(url, options);
      if (!Array.isArray(data)) break;
      out.push(...data);
      url = nextLink(link);
    }
    return out;
  }
}

export const nextLink = (link: string): string | undefined => /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
export const lastPage = (link: string): number => Number(/[?&]page=(\d+)>;\s*rel="last"/.exec(link)?.[1] ?? 1);

// ---------------------------------------------------------------- charts

/**
 * Two single-hue bar charts side by side in one SVG: thin marks with rounded
 * tops, a recessive grid, direct labels only on the peak and the latest day.
 * Text is the chart's own; the email around it carries everything else.
 */
export function chartPair(a: ChartSeries, b: ChartSeries, W = 640, H = 150): string {
  const half = W / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Liberation Sans, sans-serif">` +
    `<rect width="${W}" height="${H}" fill="#fcfcfb"/>${bars(a, 0, 0, half - 12, H)}${bars(b, half + 12, 0, half - 12, H)}</svg>`;
}

export interface ChartSeries {
  title: string;
  color: string;
  days: { day: string; count: number }[];
}

function bars({ title, color, days }: ChartSeries, x0: number, y0: number, w: number, h: number): string {
  const padT = 38;
  const padB = 20;
  const padL = 8;
  const padR = 8;
  const max = Math.max(1, ...days.map((d) => d.count));
  const n = Math.max(1, days.length);
  const gap = 2;
  const bw = (w - padL - padR - gap * (n - 1)) / n;
  const ph = h - padT - padB;
  const baseY = y0 + padT + ph;
  const total = days.reduce((t, d) => t + d.count, 0);
  let s = `<text x="${x0 + padL}" y="${y0 + 14}" font-size="12" fill="#52514e">${esc(title)}</text>`;
  s += `<text x="${x0 + w - padR}" y="${y0 + 14}" font-size="12" fill="#0b0b0b" text-anchor="end">${total} in 14d</text>`;
  for (const f of [0.5, 1]) {
    const gy = (baseY - ph * f).toFixed(1);
    s += `<line x1="${x0 + padL}" x2="${x0 + w - padR}" y1="${gy}" y2="${gy}" stroke="#e6e5e1" stroke-width="1"/>`;
  }
  s += `<line x1="${x0 + padL}" x2="${x0 + w - padR}" y1="${baseY}" y2="${baseY}" stroke="#c9c8c2" stroke-width="1"/>`;
  let peak = 0;
  days.forEach((d, i) => { if (d.count > (days[peak]?.count ?? 0)) peak = i; });
  days.forEach((d, i) => {
    const bx = x0 + padL + i * (bw + gap);
    const bh = d.count ? Math.max(2, (d.count / max) * ph) : 0;
    if (bh) s += `<path d="${roundTop(bx, baseY - bh, bw, bh, Math.min(4, bw / 2))}" fill="${color}"/>`;
    if (d.count && (i === peak || i === n - 1)) {
      s += `<text x="${(bx + bw / 2).toFixed(1)}" y="${(baseY - bh - 4).toFixed(1)}" font-size="10" fill="#0b0b0b" text-anchor="middle">${d.count}</text>`;
    }
    if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
      s += `<text x="${(bx + bw / 2).toFixed(1)}" y="${baseY + 13}" font-size="9" fill="#52514e" text-anchor="middle">${d.day.slice(5)}</text>`;
    }
  });
  return s;
}

function roundTop(x: number, y: number, w: number, h: number, r0: number): string {
  const r = Math.min(r0, h);
  return `M${x} ${y + h} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h} Z`;
}

// ---------------------------------------------------------------- text bits

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);
export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

export function movementBits(m: Movement): string[] {
  const b: string[] = [];
  if (m.stars) b.push(`${signed(m.stars)} star${Math.abs(m.stars) === 1 ? '' : 's'}`);
  if (m.forks) b.push(`${signed(m.forks)} fork${Math.abs(m.forks) === 1 ? '' : 's'}`);
  if (m.commits) b.push(plural(m.commits, 'commit'));
  if (m.prMerged) b.push(`${plural(m.prMerged, 'PR')} merged`);
  if (m.prOpened) b.push(`${plural(m.prOpened, 'PR')} opened`);
  if (m.prClosed) b.push(`${plural(m.prClosed, 'PR')} closed`);
  if (m.issuesOpened) b.push(`${plural(m.issuesOpened, 'issue')} opened`);
  if (m.issuesClosed) b.push(`${plural(m.issuesClosed, 'issue')} closed`);
  if (m.releases) b.push(plural(m.releases, 'release'));
  return b;
}

export function trafficBits(m: Movement): string[] {
  const b: string[] = [];
  if (m.views) b.push(`${m.views} view${m.views === 1 ? '' : 's'} / ${m.uniques} unique`);
  if (m.clones) b.push(`${m.clones} clone${m.clones === 1 ? '' : 's'} / ${m.cloners} unique`);
  return b;
}

export function subjectLine(now: Date, movers: number, starsDelta: number | null, views: number, clones: number): string {
  return `GitHub pulse ${isoDay(now)}: ${movers} repos moved` +
    (starsDelta ? `, ${signed(starsDelta)} stars` : '') +
    `, ${views} views, ${clones} clones`;
}

const fmtWhen = (d: Date): string => d.toUTCString().replace(/:\d\d GMT$/, ' UTC');

// ---------------------------------------------------------------- html

export function renderHtml(c: ReportContext): string {
  const { movers, detailed } = c;
  const maxScore = Math.max(1, ...movers.map((x) => x.m.score));
  const windowH = Math.round((c.now.getTime() - c.cutoff.getTime()) / 3600000);
  const link = (x: RepoState): string =>
    `<a href="${esc(x.repo.html_url)}" style="color:#0b0b0b;text-decoration:none;font-weight:600">${esc(x.repo.full_name)}</a>` +
    (x.repo.private ? ' <span style="font-size:11px;color:#52514e;border:1px solid #d9d8d2;border-radius:8px;padding:0 5px">private</span>' : '');
  const tile = (label: string, value: string | number, sub: string): string =>
    `<td style="padding:10px 12px;border:1px solid #e6e5e1;border-radius:8px;vertical-align:top;width:25%">` +
    `<div style="font-size:11px;color:#52514e;text-transform:uppercase;letter-spacing:.04em">${label}</div>` +
    `<div style="font-size:24px;font-weight:600;color:#0b0b0b;line-height:1.2">${value}</div>` +
    (sub ? `<div style="font-size:12px;color:#52514e">${sub}</div>` : '') + '</td>';
  const n = (v: number): string => v.toLocaleString('en-US');
  const inWindow = c.range ? c.range.label : 'in window';
  const starDelta = c.prevTotalStars === null ? 'all repos' : c.range?.key === 'all' ? 'all repos' : `${signed(c.totalStars - c.prevTotalStars)} ${inWindow}`;
  const followerDelta = c.useBaseline
    ? `${signed(c.followerMoves.gained.length - c.followerMoves.lost.length)} (${c.followerMoves.gained.length} new, ${c.followerMoves.lost.length} lost)${c.range ? ` ${c.range.label}` : ''}`
    : c.range ? `no snapshot yet from the start of the range` : 'baseline captured';
  const userLink = (l: string): string => `<a href="https://github.com/${esc(l)}" style="color:#2a78d6">${esc(l)}</a>`;
  const refLink = (p: Ref): string => `<a href="${esc(p.url)}" style="color:#2a78d6">#${p.n}</a> ${esc(p.t)}`;

  let h = `<div style="background:#f4f4f2;padding:16px 8px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0b0b0b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#fcfcfb;border-radius:10px"><tr><td style="padding:20px 22px">
<div style="font-size:20px;font-weight:700">GitHub pulse${c.range ? ` · ${esc(c.range.label)}` : ''}</div>
<div style="font-size:13px;color:#52514e;margin-top:2px">${esc(c.login)} · ${fmtWhen(c.now)} · ${c.range ? esc(c.range.coverage) : `window ${windowH}h since ${fmtWhen(c.cutoff)}${c.useBaseline ? '' : ' (no previous snapshot; clock window)'}`}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:14px -6px 0;border-collapse:separate"><tr>
${tile('Repos moved', movers.length, `of ${c.repoCount} scanned`)}
${tile('Stars', n(c.totalStars), starDelta)}
${tile('Views', n(c.port.views), `${n(c.port.uniques)} unique visitors · ${esc(c.trafficLabel)}`)}
${tile('Clones', n(c.port.clones), `${n(c.port.cloners)} unique cloners · ${esc(c.trafficLabel)}`)}
</tr></table>
<div style="font-size:13px;color:#52514e;margin-top:8px">Followers: ${n(c.followers.length)} · ${followerDelta}${c.trafficBlind ? ` · traffic unavailable for ${c.trafficBlind} repos (no push access)` : ''}${c.range?.partialRepos ? ` · counts for ${c.range.partialRepos} repos are lower bounds (page budget reached)` : ''}</div>
<img src="${c.portfolioImg}" width="640" alt="${c.range ? esc(c.range.label) : '14-day'} views and clones across all repos" style="display:block;width:100%;max-width:640px;height:auto;margin:14px 0 6px;border:1px solid #e6e5e1;border-radius:8px">
`;

  h += `<div style="font-size:15px;font-weight:700;margin:18px 0 6px">Ranked by movement${c.range ? `, ${esc(c.range.label)}` : ''}</div>`;
  if (movers.length === 0) h += '<div style="font-size:13px;color:#52514e">Nothing moved in the window.</div>';
  h += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">';
  movers.slice(0, 40).forEach((x, i) => {
    const pct = Math.max(2, Math.round((x.m.score / maxScore) * 100));
    const bits = [...movementBits(x.m), ...trafficBits(x.m)].join(' · ');
    h += `<tr><td style="padding:6px 6px 6px 0;color:#52514e;width:22px;vertical-align:top">${i + 1}</td>` +
      `<td style="padding:6px 0;vertical-align:top">${link(x)}<div style="color:#52514e;font-size:12px;margin-top:1px">${esc(bits)}</div>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:4px;width:100%"><tr><td style="width:${pct}%;background:#2a78d6;height:6px;border-radius:3px;font-size:0;line-height:0">&nbsp;</td><td style="font-size:11px;color:#52514e;padding-left:6px;white-space:nowrap">${x.m.score.toFixed(0)} pts</td><td></td></tr></table></td></tr>`;
  });
  h += '</table>';
  if (movers.length > 40) h += `<div style="font-size:12px;color:#52514e;margin-top:4px">and ${movers.length - 40} more with smaller movement</div>`;

  if (detailed.length) h += `<div style="font-size:15px;font-weight:700;margin:22px 0 4px">Traffic for the top ${detailed.length}</div>`;
  for (const x of detailed) {
    const m = x.m;
    const r = x.repo;
    const v14 = fourteenDays(x.views, c.newestDay).reduce((t, d) => t + d.count, 0);
    const c14 = fourteenDays(x.clones, c.newestDay).reduce((t, d) => t + d.count, 0);
    h += `<div style="border-top:1px solid #e6e5e1;padding-top:12px;margin-top:12px">
<div style="font-size:15px">${link(x)} <span style="font-size:12px;color:#52514e">★ ${r.stargazers_count} · ⑂ ${r.forks_count} · ${m.score.toFixed(0)} pts</span></div>
<div style="font-size:12px;color:#52514e;margin:2px 0 6px">${esc(movementBits(m).join(' · ') || 'traffic only')}</div>`;
    if (x.trafficOk) {
      h += `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse;margin-bottom:6px">
<tr style="color:#52514e"><td style="padding:2px 14px 2px 0"></td><td style="padding:2px 14px 2px 0;text-align:right">${esc(c.range ? c.range.label : c.trafficLabel)}</td><td style="padding:2px 0;text-align:right">14 days to ${esc(c.newestDay)}</td></tr>
<tr><td style="padding:2px 14px 2px 0">Views / unique visitors</td><td style="padding:2px 14px 2px 0;text-align:right;font-weight:600">${m.views} / ${m.uniques}</td><td style="padding:2px 0;text-align:right">${v14}</td></tr>
<tr><td style="padding:2px 14px 2px 0">Clones / unique cloners</td><td style="padding:2px 14px 2px 0;text-align:right;font-weight:600">${m.clones} / ${m.cloners}</td><td style="padding:2px 0;text-align:right">${c14}</td></tr>
</table>`;
      if (x.img) h += `<img src="${x.img}" width="640" alt="14-day views and clones for ${esc(r.full_name)}" style="display:block;width:100%;max-width:640px;height:auto;border:1px solid #e6e5e1;border-radius:8px">`;
      const cols: string[] = [];
      if (x.referrers?.length) {
        cols.push('<div style="font-weight:600;margin-bottom:2px">Referrers (14d)</div>' +
          x.referrers.slice(0, 5).map((q) => `<div>${esc(q.referrer)} <span style="color:#52514e">${q.count} views · ${q.uniques} unique</span></div>`).join(''));
      }
      if (x.paths?.length) {
        cols.push('<div style="font-weight:600;margin-bottom:2px">Popular content (14d)</div>' +
          x.paths.slice(0, 5).map((q) => `<div>${esc(q.path.replace(`/${r.full_name}`, '') || '/')} <span style="color:#52514e">${q.count} views · ${q.uniques} unique</span></div>`).join(''));
      }
      if (cols.length) h += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;margin-top:6px"><tr>${cols.map((col) => `<td style="vertical-align:top;width:50%;padding-right:10px">${col}</td>`).join('')}</tr></table>`;
    } else {
      h += '<div style="font-size:12px;color:#52514e">Traffic not available (needs push access).</div>';
    }
    const extras: string[] = [];
    if (m.newStargazers.length) extras.push(`Starred by ${m.newStargazers.slice(0, 12).map(userLink).join(', ')}${m.newStargazers.length > 12 ? ` and ${m.newStargazers.length - 12} more` : ''}`);
    if (m.newForks.length) extras.push(`Forked by ${m.newForks.slice(0, 8).map((f) => esc(f.split('/')[0])).join(', ')}`);
    if (m.authors.length) extras.push(`Commits by ${m.authors.slice(0, 6).map(esc).join(', ')}`);
    if (m.mergedPrs.length) extras.push(`Merged: ${m.mergedPrs.slice(0, 5).map(refLink).join('; ')}`);
    if (m.openedPrs.length) extras.push(`Opened PRs: ${m.openedPrs.slice(0, 5).map((p) => `${refLink(p)} (${esc(p.u)})`).join('; ')}`);
    if (m.openedIssues.length) extras.push(`Opened issues: ${m.openedIssues.slice(0, 5).map((p) => `${refLink(p)} (${esc(p.u)})`).join('; ')}`);
    if (m.releaseList.length) extras.push(`Released ${m.releaseList.map((p) => `<a href="${esc(p.url)}" style="color:#2a78d6">${esc(p.tag)}</a>`).join(', ')}`);
    if (extras.length) h += `<div style="font-size:12px;margin-top:6px">${extras.map((e) => `<div style="margin-top:2px">${e}</div>`).join('')}</div>`;
    h += `<div style="font-size:11px;margin-top:6px"><a href="${esc(r.html_url)}/graphs/traffic" style="color:#52514e">traffic graph on GitHub</a></div></div>`;
  }

  if (c.followerMoves.gained.length || c.followerMoves.lost.length) {
    h += '<div style="font-size:15px;font-weight:700;margin:22px 0 4px">Followers</div><div style="font-size:12px">';
    if (c.followerMoves.gained.length) h += `<div>New: ${c.followerMoves.gained.slice(0, 30).map(userLink).join(', ')}</div>`;
    if (c.followerMoves.lost.length) h += `<div style="margin-top:2px">Unfollowed: ${c.followerMoves.lost.slice(0, 30).map(esc).join(', ')}</div>`;
    h += '</div>';
  }

  h += `<div style="font-size:11px;color:#52514e;margin-top:22px;border-top:1px solid #e6e5e1;padding-top:8px">Scoring: star 5 · fork 4 · release 5 · PR merged 3 · PR/issue opened 2 · commit 1 (capped ${COMMIT_CAP}) · unique visitor 1 · unique cloner 1 · clone 0.5 · view 0.2. Traffic is GitHub's own /graphs/traffic data, which GitHub publishes one to two days late; it is counted as growth of the 14-day buckets since the previous run, so nothing is missed or double counted. Generated by gh-pulse on ${esc(hostname())}.</div>
</td></tr></table></div>`;
  return h;
}

export function renderText(c: ReportContext): string {
  const out: string[] = [];
  out.push(`GITHUB PULSE ${isoDay(c.now)} (${c.login})${c.range ? ` · ${c.range.label}` : ''}`);
  out.push(c.range ? c.range.coverage : `window since ${c.cutoff.toISOString()} · traffic: ${c.trafficLabel}, newest GitHub day ${c.newestDay}`);
  out.push('');
  out.push(`${c.movers.length} of ${c.repoCount} repos moved · stars ${c.totalStars}${c.prevTotalStars === null ? '' : ` (${signed(c.totalStars - c.prevTotalStars)})`} · views ${c.port.views}/${c.port.uniques} unique · clones ${c.port.clones}/${c.port.cloners} unique · followers ${c.followers.length} (${signed(c.followerMoves.gained.length - c.followerMoves.lost.length)})`);
  out.push('');
  c.movers.forEach((x, i) => {
    out.push(`${String(i + 1).padStart(2)}. ${x.repo.full_name}  ${x.m.score.toFixed(0)} pts`);
    out.push(`    ${[...movementBits(x.m), ...trafficBits(x.m)].join(' · ')}`);
  });
  return `${out.join('\n')}\n`;
}

/** The report as data: what `gh-pulse show` and any downstream dataset read. */
export interface ReportJson {
  at: string;
  since: string;
  newestTrafficDay: string;
  trafficLabel: string;
  user: string;
  followers: number;
  followersGained: string[];
  followersLost: string[];
  totals: { repos: number; stars: number; starsDelta: number | null; views: number; uniques: number; clones: number; cloners: number };
  movers: ReportMover[];
  /** Present on range reports. */
  range?: RangeInfo;
}

export interface ReportMover {
  repo: string;
  private: boolean;
  url: string;
  stars: number;
  forks: number;
  score: number;
  movement: Movement;
  views14d: Day[];
  clones14d: Day[];
  referrers: Referrer[];
  paths: PopularPath[];
}

export function reportJson(c: ReportContext): ReportJson {
  return {
    at: c.now.toISOString(),
    since: c.cutoff.toISOString(),
    newestTrafficDay: c.newestDay,
    trafficLabel: c.trafficLabel,
    ...(c.range ? { range: c.range } : {}),
    user: c.login,
    followers: c.followers.length,
    followersGained: c.followerMoves.gained,
    followersLost: c.followerMoves.lost,
    totals: {
      repos: c.repoCount, stars: c.totalStars, starsDelta: c.prevTotalStars === null ? null : c.totalStars - c.prevTotalStars,
      views: c.port.views, uniques: c.port.uniques, clones: c.port.clones, cloners: c.port.cloners,
    },
    movers: c.movers.map((x) => ({
      repo: x.repo.full_name, private: x.repo.private, url: x.repo.html_url, stars: x.repo.stargazers_count, forks: x.repo.forks_count,
      score: Number(x.m.score.toFixed(2)), movement: x.m,
      views14d: c.series ? c.series(x, 'views') : fourteenDays(x.views, c.newestDay),
      clones14d: c.series ? c.series(x, 'clones') : fourteenDays(x.clones, c.newestDay),
      referrers: x.referrers ?? [], paths: x.paths ?? [],
    })),
  };
}

// ---------------------------------------------------------------- mail

export interface Mail {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  images: Image[];
}

/** The Resend request body. Inline images ride as attachments with a content_id, referenced as cid: in the HTML. */
export function resendBody(mail: Mail): Record<string, unknown> {
  return {
    from: mail.from,
    to: mail.to.split(',').map((s) => s.trim()).filter(Boolean),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: mail.images.map((i) => ({ filename: `${i.id}.png`, content: i.buf.toString('base64'), content_type: 'image/png', content_id: i.id })),
  };
}

export async function sendResend(mail: Mail, key: string, fetchImpl: typeof fetch): Promise<string> {
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(resendBody(mail)),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string };
  if (!r.ok || !j.id) throw new Error(`Resend ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.id;
}

/** A crash has to reach a human too, or the first anyone knows is that the reports quietly stopped. */
export async function sendFailure(error: unknown, to: string, from: string, key: string | undefined, fetchImpl: typeof fetch): Promise<void> {
  if (!key) return;
  try {
    await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to: [to], subject: 'GitHub pulse FAILED',
        text: `The daily GitHub pulse could not be produced on ${hostname()}.\n\n${(error as Error).stack ?? String(error)}\n`,
      }),
    });
  } catch {
    // Nothing further to do: the failure is already on stderr.
  }
}

// ---------------------------------------------------------------- the run

interface StarEntry { starred_at: string; user: { login: string } }
interface ForkEntry { full_name: string; created_at: string }
interface CommitEntry { author?: { login?: string } | null; commit?: { author?: { name?: string } } }
interface PullEntry { number: number; title: string; created_at: string; updated_at: string; merged_at: string | null; closed_at: string | null; user?: { login?: string }; html_url: string }
interface IssueEntry { number: number; title: string; created_at: string; closed_at: string | null; user?: { login?: string }; html_url: string; pull_request?: unknown }
interface ReleaseEntry { tag_name: string; published_at: string | null; created_at: string; html_url: string }

/** Walk pages newest-first until `stop` says the rest is older than we need, or the budget is spent. Returns whether the walk was cut short. */
async function walk<T>(gh: GitHub, path: string, max: number, stop: (item: T) => boolean, options: { accept?: string; allow?: number[] } = {}): Promise<{ items: T[]; partial: boolean }> {
  const items: T[] = [];
  let url: string | undefined = path;
  for (let i = 0; url; i += 1) {
    if (i >= max) return { items, partial: true };
    const { data, link } = await gh.get<T[]>(url, options);
    if (!Array.isArray(data)) break;
    items.push(...data);
    const last = data[data.length - 1];
    if (last !== undefined && stop(last)) break;
    url = nextLink(link);
  }
  return { items, partial: false };
}

/** Commits, PRs, issues and releases since `cutoffMs`, written into `m`. */
export async function collectEvents(gh: GitHub, name: string, cutoffMs: number, budget: PageBudget, m: Movement): Promise<boolean> {
  const cutoffIso = new Date(cutoffMs).toISOString();
  const older = (iso: string | null | undefined): boolean => !!iso && Date.parse(iso) < cutoffMs;
  const [commits, pulls, issues, releases] = await Promise.all([
    walk<CommitEntry>(gh, `/repos/${name}/commits?since=${cutoffIso}&per_page=100`, budget.commits, () => false, { allow: [409, 404] }),
    walk<PullEntry>(gh, `/repos/${name}/pulls?state=all&sort=updated&direction=desc&per_page=100`, budget.pulls, (p) => older(p.updated_at), { allow: [404] }),
    walk<IssueEntry>(gh, `/repos/${name}/issues?state=all&since=${cutoffIso}&sort=updated&per_page=100`, budget.issues, () => false, { allow: [404] }),
    walk<ReleaseEntry>(gh, `/repos/${name}/releases?per_page=100`, budget.releases, (r) => older(r.published_at ?? r.created_at), { allow: [404] }),
  ]);
  m.commits = commits.items.length;
  m.authors = [...new Set(commits.items.map((c) => c.author?.login ?? c.commit?.author?.name).filter((a): a is string => !!a))];
  for (const pr of pulls.items) {
    const ref: Ref = { n: pr.number, t: pr.title, u: pr.user?.login ?? '', url: pr.html_url };
    if (Date.parse(pr.created_at) >= cutoffMs) { m.prOpened += 1; m.openedPrs.push(ref); }
    if (pr.merged_at && Date.parse(pr.merged_at) >= cutoffMs) { m.prMerged += 1; m.mergedPrs.push(ref); }
    else if (pr.closed_at && Date.parse(pr.closed_at) >= cutoffMs) m.prClosed += 1;
  }
  for (const is of issues.items) {
    if (is.pull_request) continue;
    if (Date.parse(is.created_at) >= cutoffMs) { m.issuesOpened += 1; m.openedIssues.push({ n: is.number, t: is.title, u: is.user?.login ?? '', url: is.html_url }); }
    if (is.closed_at && Date.parse(is.closed_at) >= cutoffMs) m.issuesClosed += 1;
  }
  for (const rel of releases.items) {
    if (rel.published_at && Date.parse(rel.published_at) >= cutoffMs) { m.releases += 1; m.releaseList.push({ tag: rel.tag_name, url: rel.html_url }); }
  }
  return commits.partial || pulls.partial || issues.partial || releases.partial;
}

/** Stargazers since `cutoffMs`, newest first. GitHub lists stars oldest first, so the walk starts at the LAST page and moves back. */
export async function collectStars(gh: GitHub, name: string, cutoffMs: number, maxPages: number): Promise<{ logins: string[]; partial: boolean }> {
  const accept = 'application/vnd.github.star+json';
  const first = await gh.get<StarEntry[]>(`/repos/${name}/stargazers?per_page=100`, { accept, allow: [404] });
  if (!first.data) return { logins: [], partial: false };
  const last = lastPage(first.link);
  const logins: string[] = [];
  let partial = false;
  for (let page = last, walked = 0; page >= 1; page -= 1, walked += 1) {
    if (walked >= maxPages) { partial = true; break; }
    const data = page === 1 ? first.data : (await gh.get<StarEntry[]>(`/repos/${name}/stargazers?per_page=100&page=${page}`, { accept })).data ?? [];
    const recent = data.filter((s) => Date.parse(s.starred_at) >= cutoffMs);
    logins.push(...recent.map((s) => s.user.login).reverse());
    if (recent.length < data.length) break; // the rest of this page, and every earlier page, is older
  }
  return { logins, partial };
}

export async function collectForks(gh: GitHub, name: string, cutoffMs: number, maxPages: number): Promise<{ names: string[]; partial: boolean }> {
  const r = await walk<ForkEntry>(gh, `/repos/${name}/forks?sort=newest&per_page=100`, maxPages, (f) => Date.parse(f.created_at) < cutoffMs, { allow: [404] });
  return { names: r.items.filter((f) => Date.parse(f.created_at) >= cutoffMs).map((f) => f.full_name), partial: r.partial };
}

export const defaultDeps = (): RunDeps => ({
  fetch: globalThis.fetch,
  now: () => new Date(),
  token: ghToken,
  log: (line) => process.stderr.write(`gh-pulse: ${line}\n`),
  resendKey: () => process.env['RESEND_API_KEY'],
  render: svgToPng,
});

/**
 * Rasterise with @resvg/resvg-js at 2x for retina mail clients. The native
 * module is CommonJS and loaded through createRequire on first use, so the TUI
 * and the tests never pay for it.
 */
export function svgToPng(svg: string): Buffer {
  const { Resvg } = createRequire(import.meta.url)('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
}

export async function run(opt: RunOptions, deps: RunDeps = defaultDeps()): Promise<RunResult> {
  const gh = new GitHub(deps.token(), deps.fetch);
  const now = deps.now();
  const prev = latestSnapshot(opt.dataDir, deps.log);
  const base = baselineFor(prev, now);
  const cutoff = base ? new Date(base.at) : new Date(now.getTime() - opt.hours * 3600000);
  const cutoffMs = cutoff.getTime();
  const cutoffIso = cutoff.toISOString();
  const prevRepos = new Map(Object.entries(base?.repos ?? {}));

  const me = (await gh.get<{ login: string; followers: number }>('/user')).data!;
  deps.log(`${me.login}, window since ${cutoffIso}${base ? ' (previous snapshot)' : ' (clock)'}`);

  // 1. every repo the token can see, minus forks
  let repos = await gh.all<RepoInfo>('/user/repos?affiliation=owner,organization_member&per_page=100&sort=pushed', { max: 30 });
  repos = repos.filter((r) => !r.fork);
  if (opt.repos.length) repos = repos.filter((r) => opt.repos.includes(r.full_name));
  deps.log(`${repos.length} repos`);

  // 2. traffic for all of them: the bulk of the calls
  const R = new Map<string, RepoState>();
  await Promise.all(repos.map((r) => gh.limit(async () => {
    const [v, c] = await Promise.all([
      gh.get<{ views: Bucket[] }>(`/repos/${r.full_name}/traffic/views`, { allow: [403, 404] }),
      gh.get<{ clones: Bucket[] }>(`/repos/${r.full_name}/traffic/clones`, { allow: [403, 404] }),
    ]);
    R.set(r.full_name, { repo: r, views: v.data?.views ?? null, clones: c.data?.clones ?? null, trafficOk: !!(v.data && c.data), m: emptyMovement() });
  })));

  // 3. movement per repo
  const newest = newestDay([...R.values()].flatMap((x) => [x.views, x.clones]), isoDay(now));
  const firstRunSince = isoDay(new Date(now.getTime() - 2 * 86400000));
  const needStars = new Set<string>();
  const needForks = new Set<string>();
  const needEvents = new Set<string>();
  for (const [name, x] of R) {
    const r = x.repo;
    const p = prevRepos.get(name);
    const m = x.m;
    m.stars = p ? r.stargazers_count - p.stars : 0;
    m.forks = p ? r.forks_count - p.forks : 0;
    const dv = trafficDelta(x.views, p ? p.views : null, firstRunSince);
    const dc = trafficDelta(x.clones, p ? p.clones : null, firstRunSince);
    m.views = dv.count; m.uniques = dv.uniques; m.clones = dc.count; m.cloners = dc.uniques;
    if (Date.parse(r.pushed_at) >= cutoffMs || Date.parse(r.updated_at) >= cutoffMs || (p && r.open_issues_count !== p.openIssues)) needEvents.add(name);
    if (p ? m.stars > 0 : r.stargazers_count > 0) needStars.add(name);
    if (p ? m.forks > 0 : r.forks_count > 0) needForks.add(name);
  }

  // 4. detail for candidates
  const budget = pageBudget('daily');
  await Promise.all([...R.values()].map((x) => gh.limit(async () => {
    const n = x.repo.full_name;
    const m = x.m;
    const hasBaseline = prevRepos.has(n);
    if (needStars.has(n)) {
      const { logins } = await collectStars(gh, n, cutoffMs, budget.stars);
      m.newStargazers = logins;
      if (!hasBaseline) m.stars = logins.length;
    }
    if (needForks.has(n)) {
      const { names } = await collectForks(gh, n, cutoffMs, budget.forks);
      m.newForks = names;
      if (!hasBaseline) m.forks = names.length;
    }
    if (needEvents.has(n)) await collectEvents(gh, n, cutoffMs, budget, m);
    m.score = score(m);
    m.mover = isMover(m);
  })));

  // 5. referrers + popular paths, only where something moved
  const movers = [...R.values()].filter((x) => x.m.mover).sort((a, b) => b.m.score - a.m.score);
  await Promise.all(movers.map((x) => gh.limit(async () => {
    if (!x.trafficOk) return;
    const n = x.repo.full_name;
    const [ref, paths] = await Promise.all([
      gh.get<Referrer[]>(`/repos/${n}/traffic/popular/referrers`, { allow: [403, 404] }),
      gh.get<PopularPath[]>(`/repos/${n}/traffic/popular/paths`, { allow: [403, 404] }),
    ]);
    x.referrers = ref.data ?? [];
    x.paths = paths.data ?? [];
  })));

  // 6. followers, by name
  const followers = (await gh.all<{ login: string }>('/user/followers?per_page=100', { max: 60 })).map((u) => u.login).sort();
  const prevFollowers = new Set(base?.followers ?? []);
  const followerMoves = base
    ? { gained: followers.filter((l) => !prevFollowers.has(l)), lost: [...prevFollowers].filter((l) => !followers.includes(l)) }
    : { gained: [], lost: [] };

  // 7. portfolio totals
  const totalStars = repos.reduce((s, r) => s + r.stargazers_count, 0);
  const prevTotalStars = base ? Object.values(base.repos).reduce((s, r) => s + r.stars, 0) : null;
  const port: Portfolio = { views: 0, uniques: 0, clones: 0, cloners: 0, viewsByDay: new Map(), clonesByDay: new Map() };
  for (const x of R.values()) {
    port.views += x.m.views; port.uniques += x.m.uniques; port.clones += x.m.clones; port.cloners += x.m.cloners;
    for (const b of fourteenDays(x.views, newest)) port.viewsByDay.set(b.day, (port.viewsByDay.get(b.day) ?? 0) + b.count);
    for (const b of fourteenDays(x.clones, newest)) port.clonesByDay.set(b.day, (port.clonesByDay.get(b.day) ?? 0) + b.count);
  }
  const trafficBlind = [...R.values()].filter((x) => !x.trafficOk).length;

  // 8. charts
  const images: Image[] = [];
  const addImage = (id: string, svg: string): string => { images.push({ id, buf: deps.render(svg) }); return `cid:${id}`; };
  const portDays = [...port.viewsByDay.keys()].sort();
  const portfolioImg = addImage('portfolio', chartPair(
    { title: 'Views per day, all repos', color: '#2a78d6', days: portDays.map((d) => ({ day: d, count: port.viewsByDay.get(d) ?? 0 })) },
    { title: 'Clones per day, all repos', color: '#eb6834', days: portDays.map((d) => ({ day: d, count: port.clonesByDay.get(d) ?? 0 })) },
    640, 170));
  const detailed = movers.slice(0, opt.top);
  for (const x of detailed) {
    if (!x.trafficOk) continue;
    x.img = addImage(`r${x.repo.id}`, chartPair(
      { title: 'Views', color: '#2a78d6', days: fourteenDays(x.views, newest) },
      { title: 'Clones', color: '#eb6834', days: fourteenDays(x.clones, newest) }, 640, 120));
  }

  // 9. render
  const ctx: ReportContext = {
    login: me.login, now, cutoff, useBaseline: !!base, newestDay: newest,
    trafficLabel: base ? 'new since last run' : `GitHub days from ${firstRunSince}`,
    repoCount: repos.length, movers, detailed, followers, followerMoves, totalStars, prevTotalStars, port, trafficBlind, portfolioImg,
  };
  const html = renderHtml(ctx);
  const text = renderText(ctx);
  const out = join(opt.dataDir, 'out');
  mkdirSync(join(out, 'charts'), { recursive: true });
  writeFileSync(join(out, 'latest.html'), html.replace(/cid:([\w-]+)/g, (_, id: string) => `data:image/png;base64,${images.find((i) => i.id === id)?.buf.toString('base64') ?? ''}`));
  writeFileSync(join(out, 'latest.txt'), text);
  writeFileSync(join(out, 'latest.json'), `${JSON.stringify(reportJson(ctx), null, 2)}\n`);
  for (const i of images) writeFileSync(join(out, 'charts', `${i.id}.png`), i.buf);

  const subject = subjectLine(now, movers.length, prevTotalStars === null ? null : totalStars - prevTotalStars, port.views, port.clones);

  // 10. send
  let sent = false;
  if (opt.dryRun) {
    deps.log(`dry run, wrote ${join(out, 'latest.html')} (subject: ${subject})`);
  } else {
    const key = deps.resendKey();
    if (!key) throw new Error('RESEND_API_KEY is not set (and not in ~/.config/logicsrc/shell.env)');
    await sendResend({ to: opt.to, from: opt.from, subject, html, text, images }, key, deps.fetch);
    sent = true;
    deps.log(`sent to ${opt.to}: ${subject}`);
  }

  // 11. snapshot: the history. A dry run or a partial scan must not move the baseline.
  let snapshotFile: string | null = null;
  if (!opt.dryRun && opt.repos.length === 0) {
    const snap: Snapshot = { at: now.toISOString(), user: me.login, followersCount: me.followers, followers, repos: {} };
    for (const [n, x] of R) {
      const r = x.repo;
      const row: RepoSnapshot = {
        id: r.id, stars: r.stargazers_count, forks: r.forks_count, openIssues: r.open_issues_count, pushedAt: r.pushed_at,
        private: r.private, archived: r.archived, views: x.views, clones: x.clones,
      };
      if (x.referrers) row.referrers = x.referrers;
      if (x.paths) row.paths = x.paths;
      if (x.m.mover) row.movement = x.m;
      snap.repos[n] = row;
    }
    snapshotFile = writeSnapshot(opt.dataDir, snap);
    deps.log(`snapshot ${snapshotFile}`);
  }
  deps.log(`${gh.calls.made} API calls (${gh.calls.retries} retries), ${gh.remaining} remaining this hour`);
  return { subject, movers: movers.length, repos: repos.length, sent, snapshot: snapshotFile, html, calls: gh.calls.made };
}

// ---------------------------------------------------------------- range scans
//
// A range scan answers "what moved in the last week / month / quarter / year /
// ever" on demand. Events come live from GitHub for the whole range; traffic
// comes from the ledger, because GitHub only serves fourteen days of it and the
// ledger is where every earlier day survives. It never moves the daily
// baseline and never writes a snapshot.

export interface RangeOptions {
  spec: RangeSpec;
  top: number;
  repos: string[];
  dataDir: string;
  send: boolean;
  to: string;
  from: string;
  /** Skip the live GitHub calls for events; traffic and star totals still come from the ledger and the listing. */
  progress?: (line: string) => void;
}

export async function rangeScan(opt: RangeOptions, deps: RunDeps = defaultDeps()): Promise<{ report: ReportJson; html: string; subject: string; sent: boolean; calls: number }> {
  const gh = new GitHub(deps.token(), deps.fetch);
  const now = deps.now();
  const { spec } = opt;
  const cutoffMs = spec.since.getTime();
  const days = rangeDays(spec, now);
  const budget = pageBudget(spec.key, days);
  const say = opt.progress ?? deps.log;

  const me = (await gh.get<{ login: string; followers: number }>('/user')).data!;
  say(`${me.login}, ${spec.label}${spec.key === 'all' ? '' : ` (since ${spec.since.toISOString()})`}`);

  let repos = await gh.all<RepoInfo>('/user/repos?affiliation=owner,organization_member&per_page=100&sort=pushed', { max: 30 });
  repos = repos.filter((r) => !r.fork);
  if (opt.repos.length) repos = repos.filter((r) => opt.repos.includes(r.full_name));

  // The ledger: every snapshot, plus today's live fourteen days on top.
  const ledger = buildLedger(listSnapshots(opt.dataDir).flatMap((f) => { try { return [readSnapshot(f)]; } catch { return []; } }));
  const R = new Map<string, RepoState>();
  await Promise.all(repos.map((r) => gh.limit(async () => {
    const [v, c] = await Promise.all([
      gh.get<{ views: Bucket[] }>(`/repos/${r.full_name}/traffic/views`, { allow: [403, 404] }),
      gh.get<{ clones: Bucket[] }>(`/repos/${r.full_name}/traffic/clones`, { allow: [403, 404] }),
    ]);
    const views = v.data?.views ?? null;
    const clones = c.data?.clones ?? null;
    mergeBuckets(ledger, r.full_name, views, clones);
    R.set(r.full_name, { repo: r, views, clones, trafficOk: !!(v.data && c.data), m: emptyMovement() });
  })));
  say(`${repos.length} repos, traffic merged into the ledger`);

  const newest = newestDay([...R.values()].flatMap((x) => [x.views, x.clones]), isoDay(now));
  // Traffic is daily, so an hour is the newest day GitHub has; anything longer is the range clipped to what the ledger has.
  const fromDay = spec.key === 'hour' ? newest : spec.key === 'all' ? (ledger.firstDay ?? newest) : isoDay(spec.since) > (ledger.firstDay ?? '0') ? isoDay(spec.since) : (ledger.firstDay ?? isoDay(spec.since));
  const toDay = newest;
  const coverage = spec.key === 'hour'
    ? `traffic is daily; showing GitHub's newest day, ${newest}`
    : `traffic covers ${fromDay} to ${toDay}${ledger.firstDay && isoDay(spec.since) < ledger.firstDay && spec.key !== 'all' ? ' (the ledger starts there; GitHub keeps 14 days and the daily snapshots keep the rest)' : ''}`;

  // Baseline point for followers and net stars: a snapshot from before the range started, if there is one.
  const start = spec.key === 'all' ? null : pointAt(ledger, spec.since);

  const cap = commitCapFor(days);
  let partialRepos = 0;
  await Promise.all([...R.values()].map((x) => gh.limit(async () => {
    const r = x.repo;
    const n = r.full_name;
    const m = x.m;
    const dv = ledgerSum(ledger.views.get(n), fromDay, toDay);
    const dc = ledgerSum(ledger.clones.get(n), fromDay, toDay);
    m.views = dv.count; m.uniques = dv.uniques; m.clones = dc.count; m.cloners = dc.uniques;
    let partial = false;
    if (spec.key === 'all') {
      m.stars = r.stargazers_count;
      m.forks = r.forks_count;
      if (r.stargazers_count > 0) { const s = await collectStars(gh, n, 0, budget.stars); m.newStargazers = s.logins; partial ||= s.partial; }
      if (r.forks_count > 0) { const f = await collectForks(gh, n, 0, budget.forks); m.newForks = f.names; partial ||= f.partial; }
    } else {
      if (r.stargazers_count > 0) { const s = await collectStars(gh, n, cutoffMs, budget.stars); m.newStargazers = s.logins; m.stars = s.logins.length; partial ||= s.partial; }
      if (r.forks_count > 0) { const f = await collectForks(gh, n, cutoffMs, budget.forks); m.newForks = f.names; m.forks = f.names.length; partial ||= f.partial; }
      // Net movement can be negative; the snapshot at the start of the range knows.
      const then = start?.starsByRepo.get(n);
      if (then !== undefined && r.stargazers_count - then < m.stars) m.stars = r.stargazers_count - then;
    }
    const touched = spec.key === 'all' || Date.parse(r.pushed_at) >= cutoffMs || Date.parse(r.updated_at) >= cutoffMs;
    if (touched) partial = (await collectEvents(gh, n, cutoffMs, budget, m)) || partial;
    if (partial) partialRepos += 1;
    const W = WEIGHTS;
    m.score = Math.max(0, m.stars) * W.star + Math.max(0, m.forks) * W.fork + m.uniques * W.unique + m.views * W.view +
      m.clones * W.clone + m.cloners * W.cloner + Math.min(m.commits, cap) * W.commit +
      m.prOpened * W.prOpened + m.prMerged * W.prMerged + m.prClosed * W.prClosed +
      m.issuesOpened * W.issueOpened + m.issuesClosed * W.issueClosed + m.releases * W.release;
    m.mover = isMover(m);
  })));
  say(`events collected (${gh.calls.made} calls so far)`);

  const movers = [...R.values()].filter((x) => x.m.mover).sort((a, b) => b.m.score - a.m.score);
  await Promise.all(movers.map((x) => gh.limit(async () => {
    if (!x.trafficOk) return;
    const n = x.repo.full_name;
    const [ref, paths] = await Promise.all([
      gh.get<Referrer[]>(`/repos/${n}/traffic/popular/referrers`, { allow: [403, 404] }),
      gh.get<PopularPath[]>(`/repos/${n}/traffic/popular/paths`, { allow: [403, 404] }),
    ]);
    x.referrers = ref.data ?? [];
    x.paths = paths.data ?? [];
  })));

  const followers = (await gh.all<{ login: string }>('/user/followers?per_page=100', { max: 60 })).map((u) => u.login).sort();
  const startFollowers = new Set(start?.followers ?? []);
  const followerMoves = start
    ? { gained: followers.filter((l) => !startFollowers.has(l)), lost: [...startFollowers].filter((l) => !followers.includes(l)) }
    : { gained: [], lost: [] };

  const totalStars = repos.reduce((s, r) => s + r.stargazers_count, 0);
  // Only the scanned repos count, so a --repo run does not compare three repos against the whole portfolio.
  const prevTotalStars = spec.key === 'all' ? 0 : start
    ? repos.reduce((s, r) => s + (start.starsByRepo.get(r.full_name) ?? r.stargazers_count), 0)
    : totalStars - [...R.values()].reduce((s, x) => s + Math.max(0, x.m.stars), 0);
  const port: Portfolio = { views: 0, uniques: 0, clones: 0, cloners: 0, viewsByDay: new Map(), clonesByDay: new Map() };
  for (const x of R.values()) {
    port.views += x.m.views; port.uniques += x.m.uniques; port.clones += x.m.clones; port.cloners += x.m.cloners;
    for (const b of ledgerDays(ledger.views.get(x.repo.full_name), fromDay, toDay)) port.viewsByDay.set(b.day, (port.viewsByDay.get(b.day) ?? 0) + b.count);
    for (const b of ledgerDays(ledger.clones.get(x.repo.full_name), fromDay, toDay)) port.clonesByDay.set(b.day, (port.clonesByDay.get(b.day) ?? 0) + b.count);
  }
  const trafficBlind = [...R.values()].filter((x) => !x.trafficOk).length;

  const images: Image[] = [];
  const addImage = (id: string, svg: string): string => { images.push({ id, buf: deps.render(svg) }); return `cid:${id}`; };
  const portDays = [...port.viewsByDay.keys()].sort();
  const fold = (d: Day[]): Day[] => foldDays(d, 60);
  const portfolioImg = addImage('portfolio', chartPair(
    { title: `Views per ${portDays.length > 60 ? 'period' : 'day'}, all repos`, color: '#2a78d6', days: fold(portDays.map((d) => ({ day: d, count: port.viewsByDay.get(d) ?? 0, uniques: 0 }))) },
    { title: `Clones per ${portDays.length > 60 ? 'period' : 'day'}, all repos`, color: '#eb6834', days: fold(portDays.map((d) => ({ day: d, count: port.clonesByDay.get(d) ?? 0, uniques: 0 }))) },
    640, 170));
  const detailed = movers.slice(0, opt.top);
  const seriesFor = (x: RepoState, kind: 'views' | 'clones'): Day[] => fold(ledgerDays(ledger[kind].get(x.repo.full_name), fromDay, toDay));
  for (const x of detailed) {
    if (!x.trafficOk) continue;
    x.img = addImage(`r${x.repo.id}`, chartPair(
      { title: 'Views', color: '#2a78d6', days: seriesFor(x, 'views') },
      { title: 'Clones', color: '#eb6834', days: seriesFor(x, 'clones') }, 640, 120));
  }

  const ctx: ReportContext = {
    login: me.login, now, cutoff: spec.key === 'all' ? new Date(`${fromDay}T00:00:00Z`) : spec.since, useBaseline: !!start, newestDay: newest,
    trafficLabel: spec.label, repoCount: repos.length, movers, detailed, followers, followerMoves, totalStars, prevTotalStars, port, trafficBlind, portfolioImg,
    range: { key: spec.key, label: spec.label, since: spec.since.toISOString(), fromDay, toDay, coverage, partialRepos, days },
    series: seriesFor,
  };
  const html = renderHtml(ctx);
  const text = renderText(ctx);
  const report = reportJson(ctx);
  const out = join(opt.dataDir, 'out', 'range');
  const slug = rangeSlug(spec, opt.repos);
  mkdirSync(join(out, 'charts'), { recursive: true });
  writeFileSync(join(out, `${slug}.html`), html.replace(/cid:([\w-]+)/g, (_, id: string) => `data:image/png;base64,${images.find((i) => i.id === id)?.buf.toString('base64') ?? ''}`));
  writeFileSync(join(out, `${slug}.txt`), text);
  writeFileSync(join(out, `${slug}.json`), `${JSON.stringify(report, null, 2)}\n`);
  for (const i of images) writeFileSync(join(out, 'charts', `${slug}-${i.id}.png`), i.buf);

  const subject = `GitHub pulse, ${spec.label}: ${movers.length} repos moved, ${signed(totalStars - prevTotalStars)} stars, ${port.views} views, ${port.clones} clones`;
  let sent = false;
  if (opt.send) {
    const key = deps.resendKey();
    if (!key) throw new Error('RESEND_API_KEY is not set (and not in ~/.config/logicsrc/shell.env)');
    await sendResend({ to: opt.to, from: opt.from, subject, html, text, images }, key, deps.fetch);
    sent = true;
    say(`sent to ${opt.to}: ${subject}`);
  }
  say(`${gh.calls.made} API calls (${gh.calls.retries} retries), ${gh.remaining} remaining this hour`);
  return { report, html, subject, sent, calls: gh.calls.made };
}

/** The cached range report, if one exists and is younger than `maxAgeMs`. */
export function readRangeReport(dir: string, slug: string, maxAgeMs = 3600000): ReportJson | null {
  const p = join(dir, 'out', 'range', `${slug}.json`);
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, 'utf8')) as ReportJson;
    if (Date.now() - Date.parse(r.at) > maxAgeMs) return null;
    return r;
  } catch {
    return null;
  }
}

export function rangeOutputPaths(dir: string, slug: string): { html: string; text: string; json: string } {
  const out = join(dir, 'out', 'range');
  return { html: join(out, `${slug}.html`), text: join(out, `${slug}.txt`), json: join(out, `${slug}.json`) };
}

/** Where the last report's files are, for `show`, `open` and `--json`. */
export function outputPaths(dir: string): { html: string; text: string; json: string } {
  const out = join(dir, 'out');
  return { html: join(out, 'latest.html'), text: join(out, 'latest.txt'), json: join(out, 'latest.json') };
}

export function readReport(dir: string): ReportJson | null {
  const p = outputPaths(dir).json;
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as ReportJson;
}

/** Open the last HTML report in the desktop browser, whichever opener this box has. */
export function openInBrowser(file: string): boolean {
  for (const opener of ['xdg-open', 'open', 'wslview']) {
    const r = spawnSync(opener, [file], { stdio: 'ignore' });
    if (r.status === 0) return true;
  }
  return false;
}
