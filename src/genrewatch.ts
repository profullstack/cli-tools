/**
 * genrewatch — reading the release catalogue from a terminal.
 *
 * Talks to the public API, which needs no key and no account, so this is a thin
 * client on purpose: no cached credentials, no local database, nothing to get out
 * of date. The one thing worth knowing lives in the shape of the data rather than
 * in the transport, and it is repeated everywhere below because getting it wrong
 * is the failure people notice.
 *
 * An event carries `time_known`. When it is false the DATE is real and the clock
 * time is not -- a film opens on a Friday and nobody publishes an hour -- so the
 * timestamp is anchored at noon UTC purely so it can be ordered. Printing that as
 * a time invents information, which is why nothing here formats an hour unless
 * the flag says it may.
 */

export const DEFAULT_BASE = 'https://genrewatch.com';

export interface SearchResult {
  slug: string;
  name: string;
  category: string;
  kind: string;
  image: string | null;
  released: string | null;
  upcoming: boolean;
  url: string;
}

export interface UpcomingEvent {
  id: string;
  name: string;
  category: string;
  kind: string;
  starts_at: string;
  time_known: boolean;
  precision: string;
  venue: string | null;
  venue_region: string | null;
  subject_name: string;
  subject_slug: string;
  url: string | null;
}

async function get<T>(base: string, path: string, timeoutMs: number): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'genrewatch-cli' },
  });
  if (!res.ok) throw new Error(`genrewatch: ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export async function search(
  term: string,
  { base = DEFAULT_BASE, category = '', limit = 20, timeoutMs = 20_000 } = {},
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: term, limit: String(limit) });
  if (category) params.set('category', category);
  const d = await get<{ results: SearchResult[] }>(base, `/api/v1/search?${params}`, timeoutMs);
  return d.results ?? [];
}

export async function upcoming({
  base = DEFAULT_BASE,
  category = '',
  genre = '',
  limit = 20,
  timeoutMs = 20_000,
} = {}): Promise<UpcomingEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (category) params.set('category', category);
  if (genre) params.set('genre', genre);
  const d = await get<{ events: UpcomingEvent[] }>(base, `/api/v1/events?${params}`, timeoutMs);
  return d.events ?? [];
}

export async function categories({ base = DEFAULT_BASE, timeoutMs = 20_000 } = {}) {
  const d = await get<{ categories: { category: string; genres: number; upcoming: number }[] }>(
    base,
    '/api/v1/categories',
    timeoutMs,
  );
  return d.categories ?? [];
}

/**
 * When something happens, said only as precisely as it is actually known.
 *
 * This is the whole reason the API carries `time_known`. Formatting a padded
 * noon-UTC anchor as "12:00" would state an hour nobody announced, and it is the
 * kind of wrong that gets copied into a calendar and believed.
 */
export function formatWhen(e: {
  starts_at: string;
  time_known?: boolean;
  precision?: string;
}): string {
  const d = new Date(e.starts_at);
  if (Number.isNaN(d.getTime())) return '?';

  if (e.precision === 'year') return String(d.getUTCFullYear());
  if (e.precision === 'month') {
    return d.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  }
  const day = d.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  if (e.time_known === false) return day;

  // A real clock time, shown in the reader's own zone rather than UTC: they are
  // deciding whether they will be awake for it.
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

/** Right-pad without cutting: a truncated title is worse than a ragged column. */
export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
