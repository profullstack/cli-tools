/**
 * Work through a list of programs you mean to sign up for, one at a time.
 *
 * The list is yours — any text file with links in it. Affiliate programs are
 * the case this was written for, but nothing here knows that: it is a cursor
 * over a list of URLs that remembers which ones you have dealt with and what
 * each one gave you back.
 *
 * What it deliberately does not do is fill the forms in. Every one of these
 * ends in accepting terms and entering payout identity as a named person, which
 * is the one step that has to be the person — and it is gated behind an email
 * verification loop anyway, so an automated filler would stop at the same wall
 * having added a second thing that can break. Opening the next one, having the
 * answers ready to paste, and keeping the resulting links in one place is the
 * part that was actually tedious.
 */

export type Status = 'pending' | 'opened' | 'joined' | 'skipped';

/**
 * Something wrong with what was typed, rather than with the machinery — a name
 * that matches nothing, an index past the end. Separated so the entry point can
 * exit 1 for "you typed it wrong" and keep 2 for "this broke", which is the
 * difference a script wrapping this needs.
 */
export class ListError extends Error {}

export interface Entry {
  name: string;
  url: string;
}

export interface Record_ {
  name: string;
  url: string;
  status: Status;
  /** The referral link the program issued, once there is one. */
  referral?: string;
  note?: string;
  updated?: string;
}

export type State = Record<string, Record_>;

export interface Row extends Record_ {
  /** 1-based, as printed. */
  index: number;
  key: string;
}

/**
 * Anything that looks like an http(s) URL, up to whitespace.
 *
 * A closing bracket is *not* a terminator, even though the common case — a
 * markdown link — ends in one. Excluding it truncates any URL with a bracket in
 * the path, and those exist (wiki articles especially). Taking too much and
 * balancing it back in {@link stripTrailingPunctuation} handles both.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

/**
 * Pull entries out of whatever the list happens to be.
 *
 * Lists like this arrive as a bare column of URLs, a markdown table, a
 * hand-written `- Name — https://…` bullet list, or a CSV someone exported. All
 * of them have the same two facts on a line, so rather than asking which format
 * it is, take the first URL on the line and treat whatever precedes it as the
 * name. A line with no URL is not an error; it is a heading or a blank.
 */
export function parseList(text: string): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(URL_PATTERN);
    if (!match) continue;

    const url = stripTrailingPunctuation(match[0]);
    const key = normalizeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({ name: nameFor(line, match.index ?? 0, url), url });
  }

  return entries;
}

/**
 * A URL at the end of a sentence collects the punctuation after it. Brackets
 * are balanced rather than stripped blindly, because a legitimate path can end
 * in one.
 */
function stripTrailingPunctuation(url: string): string {
  let out = url;
  while (out.length > 1 && /[.,;:!?]$/.test(out)) out = out.slice(0, -1);
  while (out.endsWith(')') && count(out, ')') > count(out, '(')) out = out.slice(0, -1);
  while (out.endsWith(']') && count(out, ']') > count(out, '[')) out = out.slice(0, -1);
  return out;
}

function count(text: string, character: string): number {
  let total = 0;
  for (const c of text) if (c === character) total += 1;
  return total;
}

/**
 * The name is the text before the URL, with list and table punctuation taken
 * off. When there is nothing usable there — a bare column of links — the host
 * is a better label than an empty string.
 */
function nameFor(line: string, at: number, url: string): string {
  let before = line.slice(0, at);

  // A markdown link puts the name in brackets immediately before the URL.
  const markdown = before.match(/\[([^\]]+)\]\($/);
  if (markdown) return markdown[1]!.trim();

  // In a table row the name is the first cell, not every cell up to the link:
  // taking the text before the URL would drag the commission column in with it.
  if (line.trimStart().startsWith('|')) {
    const cell = before
      .split('|')
      .map((part) => part.replace(/\*\*/g, '').trim())
      .find(Boolean);
    if (cell) return cell;
  }

  before = before
    .replace(/^[\s|>*_-]+/, '')
    .replace(/[\s|,;:—–-]+$/, '')
    .replace(/\*\*/g, '')
    .trim();

  return before || hostOf(url);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The identity of an entry, so the same program in two differently-written
 * lists is one row.
 *
 * Tracking parameters are dropped deliberately: the same signup page shared
 * from a newsletter and from a tweet differs only by `utm_*`, and treating
 * those as two programs would ask you to sign up twice.
 */
export function normalizeKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim().toLowerCase();
  }

  for (const name of [...parsed.searchParams.keys()]) {
    if (/^(utm_|_bhlid$|ref$|source$)/i.test(name)) parsed.searchParams.delete(name);
  }

  const host = parsed.host.replace(/^www\./, '').toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${host}${path}${parsed.search}`.toLowerCase();
}

/**
 * Lay the list over what is already known.
 *
 * The list is the order; the state file is the memory. A program that has been
 * dealt with but has since dropped off the list is still returned, at the end —
 * losing a referral link because someone tidied the source list would be the
 * worst failure this can have.
 */
export function merge(entries: readonly Entry[], state: State): Row[] {
  const rows: Row[] = [];
  const used = new Set<string>();

  for (const entry of entries) {
    const key = normalizeKey(entry.url);
    used.add(key);
    const known = state[key];
    rows.push({
      index: rows.length + 1,
      key,
      name: known?.name || entry.name,
      url: entry.url,
      status: known?.status ?? 'pending',
      ...(known?.referral ? { referral: known.referral } : {}),
      ...(known?.note ? { note: known.note } : {}),
      ...(known?.updated ? { updated: known.updated } : {}),
    });
  }

  for (const [key, known] of Object.entries(state)) {
    if (used.has(key)) continue;
    rows.push({ ...known, index: rows.length + 1, key });
  }

  return rows;
}

/** The next one to deal with: anything not yet joined or explicitly skipped. */
export function nextPending(rows: readonly Row[]): Row | null {
  return rows.find((row) => row.status === 'pending' || row.status === 'opened') ?? null;
}

/**
 * Find a row by printed index, host, or name.
 *
 * The index is what you just read off the screen, so it is accepted first; but
 * an index shifts when the list changes, and a command typed from scrollback
 * would then hit the wrong program. Hosts and names do not shift, so they are
 * accepted too and are the safer thing to use in a script.
 */
export function findRow(rows: readonly Row[], query: string): Row {
  const trimmed = query.trim();

  if (/^\d+$/.test(trimmed)) {
    const row = rows[Number(trimmed) - 1];
    if (!row) throw new ListError(`no entry at index ${trimmed} (there are ${rows.length})`);
    return row;
  }

  const folded = trimmed.toLowerCase();
  const matches = rows.filter(
    (row) =>
      hostOf(row.url).toLowerCase() === folded ||
      row.name.toLowerCase() === folded ||
      row.key === normalizeKey(trimmed),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new ListError(`"${trimmed}" matches ${matches.length} entries — use the index`);
  }

  const loose = rows.filter(
    (row) =>
      row.name.toLowerCase().startsWith(folded) || hostOf(row.url).toLowerCase().includes(folded),
  );
  if (loose.length === 1) return loose[0]!;
  if (loose.length > 1) {
    throw new ListError(`"${trimmed}" matches ${loose.length} entries — use the index`);
  }

  throw new ListError(`nothing matching "${trimmed}" in the list`);
}

export function applyStatus(
  state: State,
  row: Row,
  status: Status,
  extra: { referral?: string; note?: string } = {},
  now: string = new Date().toISOString(),
): State {
  const existing = state[row.key];
  return {
    ...state,
    [row.key]: {
      name: row.name,
      url: row.url,
      status,
      // A referral link already recorded survives a later status change; losing
      // it to `skip` typed at the wrong index would be unrecoverable from here.
      ...(extra.referral ?? existing?.referral
        ? { referral: extra.referral ?? existing!.referral! }
        : {}),
      ...(extra.note ?? existing?.note ? { note: extra.note ?? existing!.note! } : {}),
      updated: now,
    },
  };
}

const MARKS: Record<Status, string> = {
  pending: ' ',
  opened: '·',
  joined: '✓',
  skipped: '–',
};

export function formatRows(rows: readonly Row[]): string {
  if (rows.length === 0) return 'nothing in the list\n';

  const width = Math.max(...rows.map((row) => row.name.length));
  const lines = rows.map((row) => {
    const head = `${String(row.index).padStart(3)} ${MARKS[row.status]} ${row.name.padEnd(width)}`;
    return row.referral ? `${head}  ${row.referral}` : `${head}  ${row.url}`;
  });

  const counts = { pending: 0, opened: 0, joined: 0, skipped: 0 };
  for (const row of rows) counts[row.status] += 1;
  lines.push(
    '',
    `${counts.joined} joined · ${counts.opened} opened · ${counts.pending} pending · ${counts.skipped} skipped`,
  );

  return `${lines.join('\n')}\n`;
}

export type LinkFormat = 'text' | 'markdown' | 'json';

/** Emit the referral links that exist, for pasting into a page or a feed. */
export function formatLinks(rows: readonly Row[], format: LinkFormat = 'text'): string {
  const joined = rows.filter((row) => row.referral);
  if (joined.length === 0) return '';

  if (format === 'json') {
    return `${JSON.stringify(
      joined.map((row) => ({ name: row.name, url: row.url, referral: row.referral })),
      null,
      2,
    )}\n`;
  }
  if (format === 'markdown') {
    return `${joined.map((row) => `- [${row.name}](${row.referral})`).join('\n')}\n`;
  }
  return `${joined.map((row) => `${row.name}\t${row.referral}`).join('\n')}\n`;
}

export interface Profile {
  email: string | null;
  site: string | null;
  audience: string | null;
  promotion: string | null;
}

/** The first email address in a blob of text, or null. */
export function extractEmail(text: string): string | null {
  const match = text.match(/[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i);
  return match ? match[0] : null;
}

/**
 * Resolve the contact address.
 *
 * The moshcode account is the last resort rather than the first because it is
 * the one an operator cannot override in the moment: an explicit flag, then the
 * environment, then the profile file they wrote, and only then "whoever is
 * logged in". Signing up as the wrong identity is not something you can undo by
 * re-running the command.
 */
export function resolveEmail(
  sources: {
    flag?: string | undefined;
    env?: string | undefined;
    profile?: string | null | undefined;
    account?: string | null | undefined;
  } = {},
): string | null {
  return sources.flag || sources.env || sources.profile || sources.account || null;
}

/**
 * How to open a URL in the operator's actual browser.
 *
 * `$BROWSER` wins because it is the setting a person deliberately made; the
 * per-platform openers are the fallback. Nothing here shells through a string,
 * so a URL cannot become shell syntax.
 */
export function openCommand(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string[] {
  if (env.BROWSER) return [env.BROWSER, url];
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
  return ['xdg-open', url];
}

/**
 * The answers these forms ask for, ready to paste.
 *
 * Printed rather than submitted, and printed with the gaps visible: a form that
 * asks for audience size and receives a number nobody checked is the fastest
 * way to lose an account, so an unset field says so instead of guessing.
 */
export function renderAnswers(profile: Profile): string {
  const line = (label: string, value: string | null): string =>
    `${label}\n  ${value ?? '(not set — cli-tools affiliate profile --help)'}\n`;

  return [
    line('Contact email', profile.email),
    line('Website / where you will promote', profile.site),
    line('Audience', profile.audience),
    line('How will you promote us?', profile.promotion),
  ].join('\n');
}
