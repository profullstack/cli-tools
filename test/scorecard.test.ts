import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquired,
  channelOf,
  delta,
  formatReport,
  previousSnapshot,
  referrerHost,
  rollChannels,
  saveSnapshot,
  sendsOverDays,
  snapshotFrom,
  type Snapshot,
} from '../src/scorecard.ts';

const OURS = new Set(['genrewatch.com', 'p0dcasters.com', 'example.com']);

describe('classifying a source', () => {
  it('reads the channel off the label prefix', () => {
    expect(channelOf('Search · google', OURS)).toBe('search');
    expect(channelOf('AI · chatgpt', OURS)).toBe('ai');
    expect(channelOf('Social · reddit', OURS)).toBe('social');
    expect(channelOf('Ad · crawlproof-ad-318', OURS)).toBe('ads');
    expect(channelOf('Direct', OURS)).toBe('direct');
  });

  it('splits a referral by whether the host is ours', () => {
    expect(channelOf('Referral · genrewatch.com', OURS)).toBe('internal');
    expect(channelOf('Referral · news.ycombinator.com', OURS)).toBe('external');
  });

  it('counts a subdomain of ours as ours', () => {
    expect(channelOf('Referral · blog.example.com', OURS)).toBe('internal');
  });

  it('does not mistake a lookalike domain for ours', () => {
    // The tell of a naive endsWith: a domain that merely ends the same way.
    expect(channelOf('Referral · notexample.com', OURS)).toBe('external');
    expect(channelOf('Referral · example.com.evil.net', OURS)).toBe('external');
  });

  it('ignores www and case when matching', () => {
    expect(channelOf('Referral · WWW.Example.com', OURS)).toBe('internal');
  });

  it('files anything it does not recognise as other, not as a referral', () => {
    expect(channelOf('Something · else', OURS)).toBe('other');
  });

  it('reads the host out of a label', () => {
    expect(referrerHost('Referral · com.reddit.frontpage')).toBe('com.reddit.frontpage');
    expect(referrerHost('Direct')).toBe('');
  });
});

describe('rolling sources into channels', () => {
  const sources = [
    { label: 'Referral · genrewatch.com', value: 45492 },
    { label: 'Referral · news.ycombinator.com', value: 300 },
    { label: 'Search · google', value: 2284 },
    { label: 'AI · duckduckgo_ai', value: 2220 },
    { label: 'Social · reddit', value: 1980 },
    { label: 'Ad · crawlproof-ad-318', value: 3 },
  ];

  it('totals each channel', () => {
    const rolled = rollChannels(sources, OURS);
    expect(rolled.internal).toBe(45492);
    expect(rolled.external).toBe(300);
    expect(rolled.search).toBe(2284);
    expect(rolled.ai).toBe(2220);
    expect(rolled.social).toBe(1980);
    expect(rolled.ads).toBe(3);
  });

  it('leaves our own cross-links out of what was acquired', () => {
    const rolled = rollChannels(sources, OURS);
    // The whole point: 45,492 of our own referrals must not read as growth.
    expect(acquired(rolled)).toBe(300 + 2284 + 2220 + 1980 + 3);
  });

  it('treats an unknown host as external rather than dropping it', () => {
    const rolled = rollChannels([{ label: 'Referral · ', value: 5 }], OURS);
    expect(rolled.external).toBe(5);
  });

  it('survives a malformed source', () => {
    const rolled = rollChannels([{ label: '', value: Number.NaN }] as never, OURS);
    expect(rolled.other).toBe(0);
  });
});

describe('counting sends', () => {
  const perDay = [
    { day: '2026-09-15', sent: 9, failed: 1 },
    { day: '2026-09-16', sent: 4, failed: 0 },
    { day: '2026-09-17', sent: 7, failed: 2 },
  ];

  it('adds up the last N days', () => {
    expect(sendsOverDays(perDay, 2)).toEqual({ sent: 11, failed: 2 });
  });

  it('asking for more days than exist takes what there is', () => {
    expect(sendsOverDays(perDay, 30)).toEqual({ sent: 20, failed: 3 });
  });

  it('no series is zero, not a crash', () => {
    expect(sendsOverDays(undefined, 7)).toEqual({ sent: 0, failed: 0 });
  });
});

describe('building a snapshot', () => {
  const crawlproof = {
    sites: [
      { site: 'genrewatch.com', visitors: 4000 },
      { site: 'p0dcasters.com', visitors: 1418 },
    ],
    fleet: { sources: [{ label: 'Referral · genrewatch.com', value: 900 }, { label: 'Search · google', value: 100 }] },
    ads: { totals: { advImpressions: 50905, advClicks: 11013, spentCents: 1550, earnedCents: 530 } },
    roi: { attention: { visitors: 8859, pageviews: 15597, sites: 56, sitesReporting: 56 } },
  };
  const myna = { perDay: [{ day: '2026-09-23', sent: 5, failed: 0 }], queuedCount: 306, totals: { networks: 9 } };

  it('takes the headline numbers from the tools that own them', () => {
    const snapshot = snapshotFrom(crawlproof, myna, { rangeDays: 7, now: new Date('2026-09-24T00:00:00Z') });
    expect(snapshot.traffic.visitors).toBe(8859);
    expect(snapshot.ads.clicks).toBe(11013);
    expect(snapshot.ads.spentUsd).toBe(15.5);
    expect(snapshot.posts?.queued).toBe(306);
  });

  it('derives what we own from the account, needing no list', () => {
    const snapshot = snapshotFrom(crawlproof, myna, { now: new Date('2026-09-24T00:00:00Z') });
    expect(snapshot.channels.internal).toBe(900);
    expect(snapshot.channels.search).toBe(100);
  });

  it('a missing tool is a note, not a failure', () => {
    const snapshot = snapshotFrom(null, myna, { now: new Date('2026-09-24T00:00:00Z') });
    expect(snapshot.traffic.visitors).toBe(0);
    expect(snapshot.notes.join(' ')).toMatch(/crawlproof/);
    expect(snapshot.posts).not.toBeNull();
  });

  it('ranks the busiest properties', () => {
    const snapshot = snapshotFrom(crawlproof, myna, { now: new Date('2026-09-24T00:00:00Z') });
    expect(snapshot.topSites[0]?.site).toBe('genrewatch.com');
  });
});

describe('week over week', () => {
  it('reports a change against the previous week', () => {
    expect(delta(110, 100)).toBe(' (+10%)');
    expect(delta(90, 100)).toBe(' (-10%)');
    expect(delta(100, 100)).toBe(' (flat)');
  });

  it('says nothing when there is nothing to compare', () => {
    expect(delta(100, undefined)).toBe('');
    expect(delta(0, 0)).toBe('');
  });

  it('calls a number that grew from zero new rather than dividing by it', () => {
    expect(delta(5, 0)).toBe(' (new)');
  });
});

describe('the ledger', () => {
  const snapshot = (at: string, visitors: number): Snapshot => ({
    at,
    rangeDays: 7,
    traffic: { visitors, pageviews: 0, sites: 1, reporting: 1 },
    channels: { search: 0, ai: 0, social: 0, ads: 0, internal: 0, external: 0, direct: 0, other: 0 },
    topSites: [],
    ads: { impressions: 0, clicks: 0, spentUsd: 0, earnedUsd: 0 },
    posts: null,
    outreach: null,
    notes: [],
  });

  it('finds the most recent earlier snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
    saveSnapshot(snapshot('2026-09-10T00:00:00.000Z', 100), dir);
    saveSnapshot(snapshot('2026-09-17T00:00:00.000Z', 200), dir);
    expect(previousSnapshot('2026-09-24T00:00:00.000Z', dir)?.traffic.visitors).toBe(200);
  });

  it('never reads the current run as the previous one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
    const at = '2026-09-24T00:00:00.000Z';
    saveSnapshot(snapshot(at, 300), dir);
    expect(previousSnapshot(at, dir)).toBeNull();
  });

  it('the first ever run has no previous week', () => {
    expect(previousSnapshot('2026-09-24T00:00:00.000Z', mkdtempSync(join(tmpdir(), 'scorecard-')))).toBeNull();
  });

  it('a corrupt snapshot is skipped rather than crashing the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
    writeFileSync(join(dir, '2026-09-17.json'), '{ not json');
    expect(previousSnapshot('2026-09-24T00:00:00.000Z', dir)).toBeNull();
  });
});

describe('the report', () => {
  const built = snapshotFrom(
    {
      sites: [{ site: 'genrewatch.com', visitors: 4000 }],
      fleet: { sources: [{ label: 'Referral · genrewatch.com', value: 900 }, { label: 'Search · google', value: 100 }] },
      ads: { totals: { advImpressions: 10, advClicks: 2, spentCents: 100, earnedCents: 50 } },
      roi: { attention: { visitors: 1000, pageviews: 2000, sites: 1, sitesReporting: 1 } },
    },
    { perDay: [{ day: '2026-09-23', sent: 5, failed: 1 }], queuedCount: 306, totals: { networks: 9 } },
    { now: new Date('2026-09-24T00:00:00Z') },
  );

  it('names the acquired figure apart from our own cross-links', () => {
    const text = formatReport(built, null);
    expect(text).toMatch(/acquired\s+100/);
    expect(text).toMatch(/referral \(ours\)/);
  });

  it('says so on the first run instead of comparing against zero', () => {
    expect(formatReport(built, null)).toMatch(/First run/);
  });

  it('never lets the source column be read as visitors', () => {
    // Source labels are counted per event: on the real fleet they run about
    // twelve times the visitor count, so a report that puts them in one column
    // without saying so invites exactly the wrong conclusion.
    const text = formatReport(built, null);
    expect(text).toMatch(/source events/);
    expect(text).toMatch(/not with the visitor count above/);
  });

  it('carries the change once there is a previous week', () => {
    const before = { ...built, traffic: { ...built.traffic, visitors: 500 } };
    const text = formatReport(built, before);
    expect(text).toMatch(/\(\+100%\)/);
    expect(text).not.toMatch(/First run/);
  });
});
