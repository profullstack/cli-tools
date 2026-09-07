/**
 * ArgonTV lines, from the shell.
 *
 * Two different APIs sit behind this, and keeping them apart is most of the
 * design:
 *
 *   The PANEL (`player_api.php` on the line's own server) answers about a line
 *   that already exists -- is it active, how many of its connections are in use
 *   right now, when does it expire, what is in its catalogue. It authenticates
 *   with the line's own username and password, which is the credential a buyer
 *   would hold.
 *
 *   The RESELLER API (distributors.argontv.nl) is how a line is created and
 *   extended. It authenticates with an account-wide key, and that key can do
 *   things that cost money.
 *
 * Everything that reads is on the panel. Everything that spends is on the
 * reseller API, is marked as such, and refuses to run without an explicit key.
 * A tool that could quietly provision a line because a variable happened to be
 * set is a tool that bills you for a typo.
 */

import { loadStored } from './credentials.ts';

export const PANEL_TIMEOUT_MS = 60_000;

/** The reseller host. `api.argontv.nl` has no DNS record; this one answers. */
export const RESELLER_BASE = 'https://distributors.argontv.nl';

export interface LineCreds {
  server: string;
  username: string;
  password: string;
}

export interface LineStatus {
  status: string;
  maxConnections: number | null;
  activeConnections: number | null;
  expiresAt: Date | null;
  createdAt: Date | null;
  isTrial: boolean;
  formats: string[];
}

/**
 * The line to ask about.
 *
 * Environment first, then the stored credentials, matching every other command
 * here. Returns null rather than throwing so a caller can print usage instead of
 * a stack trace, which is what somebody running this for the first time needs.
 */
export function lineFromEnv(env: NodeJS.ProcessEnv = process.env): LineCreds | null {
  const stored = loadStored(env);
  const pick = (variable: string) => env[variable] ?? stored[variable] ?? '';
  const server = pick('ARGONTV_LINE_SERVER');
  const username = pick('ARGONTV_LINE_USERNAME');
  const password = pick('ARGONTV_LINE_PASSWORD');
  if (!server || !username || !password) return null;
  return { server: server.replace(/\/$/, ''), username, password };
}

const panelUrl = (line: LineCreds, action?: string): string => {
  const q = new URLSearchParams({ username: line.username, password: line.password });
  if (action) q.set('action', action);
  return `${line.server}/player_api.php?${q}`;
};

async function panel(line: LineCreds, action?: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(panelUrl(line, action), {
    // Panels routinely refuse a generic client. This is what a set-top box sends.
    headers: { 'user-agent': 'VLC/3.0.20 LibVLC/3.0.20' },
    signal: AbortSignal.timeout(PANEL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`panel answered ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`panel did not answer JSON (${text.slice(0, 60)})`);
  }
}

/** Seconds-since-epoch as a string, which is how a panel spells every date. */
const epoch = (v: unknown): Date | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
};

const int = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function lineStatus(
  line: LineCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<LineStatus> {
  const data = await panel(line, undefined, fetchImpl);
  const info = data?.user_info ?? {};
  if (info.auth !== 1 && info.auth !== '1') {
    throw new Error('the panel rejected that username and password');
  }
  return {
    status: String(info.status ?? 'unknown'),
    maxConnections: int(info.max_connections),
    activeConnections: int(info.active_cons),
    expiresAt: epoch(info.exp_date),
    createdAt: epoch(info.created_at),
    isTrial: String(info.is_trial ?? '0') === '1',
    formats: Array.isArray(info.allowed_output_formats) ? info.allowed_output_formats : [],
  };
}

export interface Catalogue {
  live: number;
  movies: number;
  series: number;
}

/**
 * How big the catalogue is, per kind.
 *
 * Asked of the panel rather than by counting an M3U, and the difference is not
 * cosmetic: the full playlist for this line is 583MB and 1.4 million entries,
 * because it expands every episode of every series. The panel answers the same
 * question in three small requests.
 *
 * Note that `series` here counts SHOWS. The M3U counts episodes, and there are
 * about twenty-six of those per show -- which is why the two numbers look like
 * they disagree and do not.
 */
export async function catalogue(
  line: LineCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<Catalogue> {
  const [live, movies, series] = await Promise.all([
    panel(line, 'get_live_streams', fetchImpl),
    panel(line, 'get_vod_streams', fetchImpl),
    panel(line, 'get_series', fetchImpl),
  ]);
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return { live: n(live), movies: n(movies), series: n(series) };
}

/**
 * Room on the line, and room to sell -- which are two different numbers.
 *
 * `capacity` is what the panel permits and `free` is what is unused this second.
 * Neither is how many passes should exist, and conflating them is the mistake
 * this separation exists to prevent: sell to the full capacity and the first
 * person to open a stream for testing, or to check a complaint, takes the slot a
 * paying customer was about to use.
 *
 * `sellable` is therefore capacity less a reserved slot, and it is the number
 * that should bound active passes. One in reserve is not caution for its own
 * sake -- it is the difference between diagnosing a stream problem and having to
 * choose between diagnosing it and a customer watching.
 *
 * ARGONTV_MAX_PASSES overrides it outright for a line whose reserve should be
 * larger, or none at all.
 */
export function slots(
  status: LineStatus,
  env: NodeJS.ProcessEnv = process.env,
): { capacity: number | null; free: number | null; sellable: number | null; reserved: number } {
  const capacity = status.maxConnections;
  const used = status.activeConnections ?? 0;
  const free = capacity === null ? null : Math.max(0, capacity - used);

  const override = Number(env.ARGONTV_MAX_PASSES);
  const sellable =
    Number.isFinite(override) && override > 0
      ? Math.floor(override)
      : capacity === null
        ? null
        : Math.max(1, capacity - 1);

  return {
    capacity,
    free,
    sellable,
    reserved: capacity === null || sellable === null ? 0 : Math.max(0, capacity - sellable),
  };
}

export const daysLeft = (at: Date | null, now: Date = new Date()): number | null =>
  at ? Math.floor((at.getTime() - now.getTime()) / 86_400_000) : null;

/* ------------------------------------------------------------- reseller --- */

/**
 * The account-wide key, and nothing that guesses at one.
 *
 * Read only when a command that spends money asks for it, so that a plain
 * `argontv status` never touches it. Absent is a refusal with an explanation
 * rather than a stack trace: the key comes from the reseller panel and cannot be
 * generated locally, which is the one thing somebody hitting this needs told.
 */
export function resellerKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.IPTV_ARGON_API_KEY ?? loadStored(env).IPTV_ARGON_API_KEY ?? null;
}

export async function reseller(
  path: string,
  { method = 'GET', body, key, fetchImpl = fetch }: {
    method?: string;
    body?: unknown;
    key: string;
    fetchImpl?: typeof fetch;
  },
) {
  const res = await fetchImpl(`${RESELLER_BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error(
      'the reseller key was rejected (401). It comes from distributors.argontv.nl and cannot be generated here.',
    );
  }
  if (!res.ok) throw new Error(`reseller answered ${res.status}`);
  if ((data as { error?: boolean }).error === true) {
    throw new Error(`reseller refused: ${(data as { err?: string }).err ?? 'no reason given'}`);
  }
  return data;
}
