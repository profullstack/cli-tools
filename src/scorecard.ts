/**
 * One weekly number for the whole fleet, from the tools that already know it.
 *
 * crawlproof knows the traffic and the ads, myna knows what went out. Both
 * print JSON, so this reads them rather than reimplementing either, and adds
 * the one thing neither can do alone: a read across all of it, week over week.
 *
 * The distinction that makes the number honest is internal traffic. Eight of
 * the ten biggest referrers on this fleet are our own properties sending
 * people to each other, which is real engagement and is not acquisition. A
 * scorecard that adds those into one "referral" line reports a fleet growing
 * on its own exhaust, so they are split out and named.
 *
 * Everything that decides anything here is a pure function over a snapshot, so
 * the report can be tested without a network, a token or a clock.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

/* ---------------------------------------------------------------- channels */

/**
 * Where a visit came from, as a weekly report cares about it.
 *
 * `internal` and `external` are both referrals; keeping them apart is the
 * whole point. `direct` covers a visit with nothing to attribute it to, which
 * after this week's myna change should slowly shrink as posted links start
 * carrying their own campaign tags.
 */
export type Channel = 'search' | 'ai' | 'social' | 'ads' | 'internal' | 'external' | 'direct' | 'other';

export const CHANNELS: Channel[] = ['search', 'ai', 'social', 'ads', 'external', 'internal', 'direct', 'other'];

/** How each channel is labelled in the report, in the order it is printed. */
const CHANNEL_LABEL: Record<Channel, string> = {
  search: 'search',
  ai: 'AI',
  social: 'social',
  ads: 'ads',
  external: 'referral (external)',
  internal: 'referral (ours)',
  direct: 'direct',
  other: 'other',
};

export interface Source {
  label: string;
  value: number;
}

/** The host part of a "Referral · example.com" label, lower-case, or "". */
export function referrerHost(label: string): string {
  const [, rest] = label.split('·');
  if (!rest) return '';
  return rest.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * Which channel a crawlproof source label belongs to.
 *
 * A referral from a host we own is `internal`. Subdomains count as ours: a
 * visit from blog.example.com to example.com is still us talking to ourselves.
 */
export function channelOf(label: string, ourHosts: ReadonlySet<string> = new Set()): Channel {
  const prefix = (label.split('·')[0] ?? '').trim().toLowerCase();
  if (prefix.startsWith('search')) return 'search';
  if (prefix === 'ai') return 'ai';
  if (prefix.startsWith('social')) return 'social';
  if (prefix.startsWith('ad')) return 'ads';
  if (prefix.startsWith('direct') || label.trim().toLowerCase() === 'direct') return 'direct';
  if (prefix.startsWith('referral')) {
    const host = referrerHost(label);
    if (!host) return 'external';
    for (const ours of ourHosts) {
      if (host === ours || host.endsWith(`.${ours}`)) return 'internal';
    }
    return 'external';
  }
  return 'other';
}

/** Total every source into its channel. */
export function rollChannels(sources: readonly Source[], ourHosts: ReadonlySet<string> = new Set()): Record<Channel, number> {
  const totals = Object.fromEntries(CHANNELS.map((channel) => [channel, 0])) as Record<Channel, number>;
  for (const source of sources) {
    const value = Number(source.value) || 0;
    totals[channelOf(String(source.label ?? ''), ourHosts)] += value;
  }
  return totals;
}

/** Visits we did not send ourselves: everything but our own cross-links. */
export function acquired(channels: Record<Channel, number>): number {
  return CHANNELS.filter((channel) => channel !== 'internal').reduce((sum, channel) => sum + channels[channel], 0);
}

/* --------------------------------------------------------------- snapshots */

export interface Snapshot {
  at: string;
  rangeDays: number;
  traffic: { visitors: number; pageviews: number; sites: number; reporting: number };
  channels: Record<Channel, number>;
  topSites: Array<{ site: string; visitors: number }>;
  ads: { impressions: number; clicks: number; spentUsd: number; earnedUsd: number };
  posts: { sent: number; failed: number; queued: number; networks: number } | null;
  outreach: { campaigns: number; sent: number; replies: number } | null;
  notes: string[];
}

interface CrawlproofJson {
  sites?: Array<{ site?: string; visitors?: number }>;
  fleet?: { sources?: Source[] };
  ads?: { totals?: Record<string, number> };
  roi?: { attention?: { visitors?: number; pageviews?: number; sites?: number; sitesReporting?: number } };
}

interface MynaJson {
  perDay?: Array<{ day?: string; sent?: number; failed?: number }>;
  queuedCount?: number;
  totals?: { networks?: number };
}

/** Sends and failures over the last `days` buckets of myna's daily series. */
export function sendsOverDays(perDay: MynaJson['perDay'], days: number): { sent: number; failed: number } {
  const recent = (perDay ?? []).slice(-days);
  return {
    sent: recent.reduce((sum, day) => sum + (Number(day.sent) || 0), 0),
    failed: recent.reduce((sum, day) => sum + (Number(day.failed) || 0), 0),
  };
}

/** Build a snapshot from what the two tools printed. Neither is required. */
export function snapshotFrom(
  crawlproof: CrawlproofJson | null,
  myna: MynaJson | null,
  { rangeDays = 7, now = new Date() }: { rangeDays?: number; now?: Date } = {},
): Snapshot {
  const notes: string[] = [];
  const sites = crawlproof?.sites ?? [];
  // Every property in the account is a host we own, so the internal split
  // needs no list to be kept up to date by hand.
  const ourHosts = new Set(sites.map((site) => String(site.site ?? '').toLowerCase()).filter(Boolean));
  const attention = crawlproof?.roi?.attention ?? {};
  const adTotals = crawlproof?.ads?.totals ?? {};

  if (!crawlproof) notes.push('crawlproof returned nothing, so traffic and ads are missing from this report.');
  if (!myna) notes.push('myna returned nothing, so posting is missing from this report.');

  return {
    at: now.toISOString(),
    rangeDays,
    traffic: {
      visitors: Number(attention.visitors) || 0,
      pageviews: Number(attention.pageviews) || 0,
      sites: Number(attention.sites) || sites.length,
      reporting: Number(attention.sitesReporting) || 0,
    },
    channels: rollChannels(crawlproof?.fleet?.sources ?? [], ourHosts),
    topSites: [...sites]
      .map((site) => ({ site: String(site.site ?? ''), visitors: Number(site.visitors) || 0 }))
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 8),
    ads: {
      impressions: Number(adTotals.advImpressions) || 0,
      clicks: Number(adTotals.advClicks) || 0,
      spentUsd: (Number(adTotals.spentCents) || 0) / 100,
      earnedUsd: (Number(adTotals.earnedCents) || 0) / 100,
    },
    posts: myna
      ? {
          ...sendsOverDays(myna.perDay, rangeDays),
          queued: Number(myna.queuedCount) || 0,
          networks: Number(myna.totals?.networks) || 0,
        }
      : null,
    outreach: null,
    notes,
  };
}

/* ----------------------------------------------------------------- ledger */

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['SCORECARD_DATA'] ?? join(homedir(), '.local', 'share', 'scorecard');
}

/** Write this week's snapshot and return where it went. */
export function saveSnapshot(snapshot: Snapshot, dir = dataDir()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${snapshot.at.slice(0, 10)}.json`);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

/**
 * The most recent snapshot before `at`, or null on the first ever run.
 *
 * Read by filename rather than by a "latest" pointer, so a run that crashed
 * halfway through leaves nothing to mistake for the previous week.
 */
export function previousSnapshot(at: string, dir = dataDir()): Snapshot | null {
  if (!existsSync(dir)) return null;
  const earlier = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .filter((name) => name.slice(0, 10) < at.slice(0, 10))
    .sort();
  const last = earlier.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(readFileSync(join(dir, last), 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- report */

const number = (value: number): string => value.toLocaleString('en-US');
const usd = (value: number): string => `$${value.toFixed(2)}`;

/** " (+12%)" against the previous week, or "" when there is nothing to compare. */
export function delta(current: number, previous: number | undefined): string {
  if (previous === undefined || previous === null) return '';
  if (previous === 0) return current === 0 ? '' : ' (new)';
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return ' (flat)';
  return ` (${change > 0 ? '+' : ''}${change}%)`;
}

/** The weekly report, as plain text. */
export function formatReport(snapshot: Snapshot, previous: Snapshot | null = null): string {
  const lines: string[] = [];
  const since = `${snapshot.rangeDays} days to ${snapshot.at.slice(0, 10)}`;
  lines.push(`Fleet scorecard, ${since}`);
  lines.push('');

  const acquiredNow = acquired(snapshot.channels);
  const acquiredBefore = previous ? acquired(previous.channels) : undefined;
  lines.push(
    `  visitors      ${number(snapshot.traffic.visitors)}${delta(snapshot.traffic.visitors, previous?.traffic.visitors)}` +
      `   across ${snapshot.traffic.reporting || snapshot.traffic.sites} sites`,
  );
  lines.push(`  pageviews     ${number(snapshot.traffic.pageviews)}${delta(snapshot.traffic.pageviews, previous?.traffic.pageviews)}`);
  if (snapshot.posts) {
    lines.push(
      `  posts         ${number(snapshot.posts.sent)} sent${snapshot.posts.failed ? `, ${snapshot.posts.failed} failed` : ''}` +
        `${delta(snapshot.posts.sent, previous?.posts?.sent)}   ${number(snapshot.posts.queued)} queued`,
    );
  }
  lines.push(`  ads           ${number(snapshot.ads.clicks)} clicks of ${number(snapshot.ads.impressions)}   ${usd(snapshot.ads.earnedUsd)} earned, ${usd(snapshot.ads.spentUsd)} spent`);
  if (snapshot.outreach) {
    lines.push(`  outreach      ${number(snapshot.outreach.sent)} sent, ${number(snapshot.outreach.replies)} replies across ${snapshot.outreach.campaigns} campaigns`);
  }

  lines.push('');
  lines.push('Where the traffic came from');
  // The tracker counts a source per event, not per visitor: this column runs
  // an order of magnitude above the visitor count above it and is not the same
  // unit. Saying so is the difference between a share that means something and
  // a number somebody will one day read as visitors.
  const attributed = acquiredNow + snapshot.channels.internal;
  lines.push(`  shares of ${number(attributed)} attributed source events, which the tracker counts per`);
  lines.push('  event rather than per visitor: comparable with each other and week to week,');
  lines.push('  not with the visitor count above.');
  lines.push('');
  const widest = Math.max(...CHANNELS.map((channel) => CHANNEL_LABEL[channel].length), 'acquired'.length);
  const share = (value: number): string => `${String(Math.round((value / Math.max(1, attributed)) * 100)).padStart(3)}%`;
  for (const channel of [...CHANNELS].sort((a, b) => snapshot.channels[b] - snapshot.channels[a])) {
    const value = snapshot.channels[channel];
    if (!value) continue;
    lines.push(
      `  ${CHANNEL_LABEL[channel].padEnd(widest)}  ${number(value).padStart(9)}  ${share(value)}` +
        `${delta(value, previous?.channels?.[channel])}`,
    );
  }
  lines.push(
    `  ${'acquired'.padEnd(widest)}  ${number(acquiredNow).padStart(9)}  ${share(acquiredNow)}` +
      `${delta(acquiredNow, acquiredBefore)}   everything but our own cross-links`,
  );

  lines.push('');
  lines.push('Busiest properties');
  for (const site of snapshot.topSites) {
    if (!site.visitors) continue;
    lines.push(`  ${site.site.padEnd(28)} ${number(site.visitors).padStart(8)}`);
  }

  if (snapshot.notes.length) {
    lines.push('');
    lines.push('Notes');
    for (const note of snapshot.notes) lines.push(`  ${note}`);
  }

  if (!previous) {
    lines.push('');
    lines.push('  First run: nothing to compare against yet. Next week carries the change.');
  }

  return `${lines.join('\n')}\n`;
}

/** The same report as HTML, for the email. */
export function formatHtml(snapshot: Snapshot, previous: Snapshot | null = null): string {
  const escaped = formatReport(snapshot, previous)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre style="font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.5">${escaped}</pre>`;
}
