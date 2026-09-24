import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Candidate } from '../src/jobs-discover.ts';
import {
  type HistoryEvent,
  appliedSet,
  filterHistory,
  jobKey,
  logHistory,
  makeKey,
  parseSince,
  queueAdd,
  readApplied,
  readHistory,
  recordApplied,
} from '../src/jobs-state.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-state-'));
  dirs.push(dir);
  return dir;
}

describe('jobKey', () => {
  it('gives every spelling of a Greenhouse job one key', () => {
    const keys = [
      'https://job-boards.greenhouse.io/acme/jobs/1234567001',
      'https://boards.greenhouse.io/acme/jobs/1234567001?gh_src=x',
      'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1234567001',
      'https://acme.dev/careers/?gh_jid=1234567001',
    ].map(jobKey);
    expect(new Set(keys)).toEqual(new Set(['greenhouse:1234567001']));
  });

  it('keys Ashby and Lever jobs by UUID, with or without the apply suffix', () => {
    const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(jobKey(`https://jobs.ashbyhq.com/acme/${uuid}`)).toBe(jobKey(`https://jobs.ashbyhq.com/acme/${uuid}/application`));
    expect(jobKey(`https://jobs.lever.co/acme/${uuid}/apply`)).toBe(`lever:${uuid}`);
  });

  it('falls back to the URL, minus fragment and trailing slash', () => {
    expect(jobKey('https://example.com/jobs/1/#apply')).toBe(jobKey('https://example.com/jobs/1'));
  });
});

describe('applied', () => {
  it('reads rows written before profiles existed, and survives a torn line', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'applied.jsonl'), [
      JSON.stringify({ url: 'https://job-boards.greenhouse.io/initech/jobs/1234567002', company: 'Initech', status: 'submitted', via: 'tron-mcp', at: 't' }),
      '{"url": "https://half',
      JSON.stringify({ url: 'https://jobs.ashbyhq.com/globex/11111111-2222-4333-8444-555555555555', status: 'skipped:onsite', at: 't' }),
      '',
    ].join('\n'));
    const rows = readApplied(dir);
    expect(rows).toHaveLength(2);
    const seen = appliedSet(rows);
    expect(seen('https://job-boards.greenhouse.io/embed/job_app?for=initech&token=1234567002')).toBe(true);
    expect(seen('https://jobs.ashbyhq.com/globex/11111111-2222-4333-8444-555555555555/application')).toBe(true);
    expect(seen('https://job-boards.greenhouse.io/initech/jobs/1')).toBe(false);
    expect(seen('')).toBe(false);
  });

  it('only ever appends', () => {
    const dir = tmp();
    recordApplied(dir, { url: 'a', status: 'submitted', at: '1' });
    recordApplied(dir, { url: 'b', status: 'skipped:x', profile: 'p', at: '2' });
    expect(readApplied(dir).map((row) => row.url)).toEqual(['a', 'b']);
  });
});

describe('queue', () => {
  const candidate = (n: number, company = 'Acme'): Candidate => ({
    company, title: `Engineer ${n}`, loc: 'Remote', ats: 'ashby', workplace: 'remote', score: 10, why: '', flags: [],
    url: `https://jobs.ashbyhq.com/acme/0000000${n}-0000-0000-0000-000000000000`, applyUrl: '', comp: '', payMin: null, payMax: null, payCurrency: null,
  });

  it('adds by index, once, and never what was already handled', () => {
    const shortlist = [candidate(1), candidate(2), candidate(3)];
    const seen = (url: string) => url === shortlist[2]!.url;
    const first = queueAdd([], shortlist, [0, 2, 9], 'agents', seen);
    expect(first.added.map((item) => item.title)).toEqual(['Engineer 1']);
    expect(first.added[0]!.focus).toBe('agents');
    expect(first.skipped).toHaveLength(2);
    const again = queueAdd(first.queue, shortlist, [0, 1], null, seen);
    expect(again.added.map((item) => item.title)).toEqual(['Engineer 2']);
    expect(again.skipped[0]).toMatch(/already queued/);
  });

  it('makes unique, file-safe keys', () => {
    const taken = new Set<string>();
    const a = makeKey('Anysphere / Cursor', 'Field Engineer, Life Sciences', taken);
    taken.add(a);
    expect(a).toBe('anysphere-cursor-field-engineer-life-sciences');
    expect(makeKey('Anysphere / Cursor', 'Field Engineer, Life Sciences', taken)).toBe(`${a}-2`);
  });
});

describe('history', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const events: HistoryEvent[] = [
    { at: '2026-09-10T00:00:00Z', type: 'profile-add', profile: 'a' },
    { at: '2026-09-23T00:00:00Z', type: 'run-start', profile: 'a', run: 'r1' },
    { at: '2026-09-23T00:01:00Z', type: 'job-outcome', profile: 'a', run: 'r1', status: 'submitted' },
    { at: '2026-09-24T11:00:00Z', type: 'run-finish', profile: 'b', run: 'r2' },
  ];

  it('parses relative windows and dates', () => {
    expect(parseSince('7d', now).toISOString()).toBe('2026-09-17T12:00:00.000Z');
    expect(parseSince('2h', now).toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(parseSince('2026-09-01', now).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(() => parseSince('soon', now)).toThrow(/--since/);
  });

  it('filters by profile, run, time and type (a trailing - is a prefix)', () => {
    expect(filterHistory(events, { profile: 'a' })).toHaveLength(3);
    expect(filterHistory(events, { run: 'r1' })).toHaveLength(2);
    expect(filterHistory(events, { since: parseSince('7d', now) })).toHaveLength(3);
    expect(filterHistory(events, { types: ['run-'] }).map((event) => event.type)).toEqual(['run-start', 'run-finish']);
    expect(filterHistory(events, { types: ['job-outcome'], profile: 'b' })).toHaveLength(0);
  });

  it('appends with a timestamp and reads back', () => {
    const dir = tmp();
    logHistory(dir, { type: 'skip', profile: 'a', url: 'u', status: 'skipped:x' });
    const [event] = readHistory(dir);
    expect(event).toMatchObject({ type: 'skip', profile: 'a', status: 'skipped:x' });
    expect(Number.isNaN(Date.parse(event!.at))).toBe(false);
  });
});
