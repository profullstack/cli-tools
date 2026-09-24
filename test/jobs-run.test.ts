import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type ApplyJob,
  type RunContext,
  createRun,
  loadRun,
  prepareResume,
  reconcile,
  runWorker,
  saveRun,
  stopRun,
} from '../src/jobs-run.ts';
import { type QueueItem, readApplied, readHistory, recordApplied } from '../src/jobs-state.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function context(): RunContext {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-run-'));
  dirs.push(dir);
  return { stateDir: dir, profileDir: join(dir, 'profiles', 'p') };
}
const item = (n: number): QueueItem => ({
  key: `job-${n}`, company: `Co${n}`, title: 'Engineer', focus: null,
  url: `https://jobs.ashbyhq.com/co${n}/0000000${n}-0000-0000-0000-000000000000`,
  applyUrl: `https://jobs.ashbyhq.com/co${n}/0000000${n}-0000-0000-0000-000000000000/application`,
});
const queue = [item(1), item(2), item(3)];
const types = (ctx: RunContext) => readHistory(ctx.stateDir).map((event) => event.type);
const never = () => false;
const noKill = () => {};

describe('a run', () => {
  it('snapshots the queue, marking what was already applied to', () => {
    const ctx = context();
    recordApplied(ctx.stateDir, { url: item(2).url, status: 'submitted', at: 't' });
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    expect(record.jobs.map((job) => job.state)).toEqual(['pending', 'skipped:already-applied', 'pending']);
    expect(types(ctx)).toEqual(['run-start']);
  });

  it('can be limited to one queued job, and refuses one that is not queued', () => {
    const ctx = context();
    expect(createRun(ctx, 'p', queue, { dryRun: true, only: 'job-3' }).jobs.map((job) => job.key)).toEqual(['job-3']);
    expect(() => createRun(ctx, 'p', queue, { dryRun: true, only: 'nope' })).toThrow(/no queued job/);
  });

  it('records submitted and unverified as applied, with profile and run, and nothing on a dry run', async () => {
    const ctx = context();
    const outcomes = ['submitted', 'unverified', 'needs-human-review'] as const;
    let n = 0;
    const apply: ApplyJob = async () => ({ status: outcomes[n++]!, ...(n === 3 ? { unknown: ['Salary expectation'] } : {}) });
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    const done = await runWorker(ctx, record.id, apply, new AbortController().signal);
    expect(done.status).toBe('finished');
    expect(done.jobs.map((job) => job.state)).toEqual(['submitted', 'unverified', 'needs-human-review']);
    expect(done.jobs[2]!.unknown).toEqual(['Salary expectation']);
    const applied = readApplied(ctx.stateDir);
    expect(applied.map((row) => [row.status, row.profile, row.run])).toEqual([
      ['submitted', 'p', record.id],
      ['unverified', 'p', record.id],
    ]);

    const dry = context();
    const dryRecord = createRun(dry, 'p', queue, { dryRun: true });
    await runWorker(dry, dryRecord.id, async () => ({ status: 'prepared' }), new AbortController().signal);
    expect(readApplied(dry.stateDir)).toEqual([]);
  });

  it('turns a thrown error into a failed job and carries on', async () => {
    const ctx = context();
    let n = 0;
    const record = createRun(ctx, 'p', queue, { dryRun: true });
    const done = await runWorker(ctx, record.id, async () => {
      n += 1;
      if (n === 1) throw new Error('browser_open: boom');
      return { status: 'prepared' };
    }, new AbortController().signal);
    expect(done.jobs.map((job) => job.state)).toEqual(['failed', 'prepared', 'prepared']);
    expect(done.jobs[0]!.reason).toMatch(/boom/);
  });
});

describe('stop and resume', () => {
  it('stops mid-form without submitting, then resumes with only what is left', async () => {
    const ctx = context();
    const controller = new AbortController();
    const calls: string[] = [];
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    const first = await runWorker(ctx, record.id, async (job, hooks) => {
      calls.push(job.key);
      if (job.key === 'job-1') return { status: 'submitted' };
      controller.abort(); // SIGTERM arrives while job-2's form is half filled
      return hooks.signal.aborted ? { status: 'abandoned', reason: 'stopped before submitting' } : { status: 'submitted' };
    }, controller.signal);
    expect(first.status).toBe('stopped');
    expect(first.jobs.map((job) => job.state)).toEqual(['submitted', 'pending', 'pending']);
    expect(readApplied(ctx.stateDir).map((row) => row.url)).toEqual([item(1).url]);
    expect(types(ctx)).toContain('job-abandoned');

    const plan = prepareResume(ctx, loadRun(ctx.stateDir, record.id), 'resume');
    expect(plan).toEqual({ done: ['job-1'], redo: ['job-2'], pending: ['job-3'], skipped: [] });
    const resumed = await runWorker(ctx, record.id, async (job) => {
      calls.push(job.key);
      return { status: 'submitted' };
    }, new AbortController().signal);
    expect(calls).toEqual(['job-1', 'job-2', 'job-2', 'job-3']);
    expect(resumed.status).toBe('finished');
    expect(resumed.jobs.every((job) => job.state === 'submitted')).toBe(true);
    const resume = readHistory(ctx.stateDir).find((event) => event.type === 'run-resume');
    expect(resume?.detail).toMatchObject({ redo: ['job-2'], pending: ['job-3'], done: ['job-1'] });
  });

  it('honours a stop written to the record by another process', async () => {
    const ctx = context();
    const record = createRun(ctx, 'p', queue, { dryRun: true });
    const done = await runWorker(ctx, record.id, async (job) => {
      if (job.key === 'job-1') {
        const disk = loadRun(ctx.stateDir, record.id);
        disk.stopRequested = true;
        saveRun(ctx.stateDir, disk);
      }
      return { status: 'prepared' };
    }, new AbortController().signal);
    expect(done.status).toBe('stopped');
    expect(done.jobs.map((job) => job.state)).toEqual(['prepared', 'pending', 'pending']);
  });

  it('skips on resume what was applied to elsewhere in the meantime', () => {
    const ctx = context();
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    record.status = 'stopped';
    saveRun(ctx.stateDir, record);
    recordApplied(ctx.stateDir, { url: item(3).url, status: 'submitted', profile: 'other', at: 't' });
    const plan = prepareResume(ctx, loadRun(ctx.stateDir, record.id), 'resume');
    expect(plan.skipped).toEqual(['job-3']);
    expect(loadRun(ctx.stateDir, record.id).jobs[2]!.state).toBe('skipped:already-applied');
  });

  it('refuses to resume a run that is still going', () => {
    const ctx = context();
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    expect(() => prepareResume(ctx, record, 'resume')).toThrow(/still running/);
  });

  it('stops a live worker through the record and SIGTERM', async () => {
    const ctx = context();
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    record.pid = 4242;
    saveRun(ctx.stateDir, record);
    const signals: string[] = [];
    let alive = true;
    const stopped = await stopRun(ctx, record.id, {
      alive: () => alive,
      kill: (_pid, signal) => {
        signals.push(signal);
        // The worker notices, finishes between jobs, and writes its own ending.
        const disk = loadRun(ctx.stateDir, record.id);
        disk.status = 'stopped';
        disk.pid = null;
        saveRun(ctx.stateDir, disk);
        alive = false;
      },
      sleep: async () => {},
    });
    expect(signals).toEqual(['SIGTERM']);
    expect(stopped.status).toBe('stopped');
  });
});

describe('after a crash or a reboot', () => {
  it('marks a run with a dead pid crashed, from the record on disk alone', () => {
    const ctx = context();
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    record.pid = 999_999;
    record.jobs[0]!.state = 'unverified';
    record.jobs[1]!.state = 'awaiting-code';
    record.jobs[2]!.state = 'submitting';
    record.browserGroup = 777;
    saveRun(ctx.stateDir, record);

    const killed: number[] = [];
    const settled = reconcile(ctx, loadRun(ctx.stateDir, record.id), never, (group) => killed.push(group));
    expect(settled.status).toBe('crashed');
    expect(killed).toEqual([777]);
    // Past the final submit: it may have gone through, so it is never sent again.
    expect(settled.jobs[2]!.state).toBe('unverified');
    expect(readApplied(ctx.stateDir).map((row) => row.url)).toEqual([item(3).url]);
    // Waiting for a code: nothing was submitted, so it is left to redo.
    expect(settled.jobs[1]!.state).toBe('awaiting-code');
    const crash = readHistory(ctx.stateDir).find((event) => event.type === 'run-crash');
    expect(crash?.detail).toEqual({ inFlight: ['job-2:awaiting-code', 'job-3:submitting'] });
  });

  it('leaves a live run alone, and settles a crashed one only once', () => {
    const ctx = context();
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    record.pid = 1;
    saveRun(ctx.stateDir, record);
    expect(reconcile(ctx, loadRun(ctx.stateDir, record.id), () => true, noKill).status).toBe('running');
    reconcile(ctx, loadRun(ctx.stateDir, record.id), never, noKill);
    reconcile(ctx, loadRun(ctx.stateDir, record.id), never, noKill);
    expect(types(ctx).filter((type) => type === 'run-crash')).toHaveLength(1);
  });

  it('resumes by redoing the job that was waiting for a code, and never an unverified one', async () => {
    const ctx = context();
    const record = createRun(ctx, 'p', queue, { dryRun: false });
    record.pid = 999_999;
    record.jobs[0]!.state = 'unverified';
    record.jobs[0]!.attempts = 1;
    record.jobs[1]!.state = 'awaiting-code';
    record.jobs[1]!.attempts = 1;
    saveRun(ctx.stateDir, record);
    reconcile(ctx, loadRun(ctx.stateDir, record.id), never, noKill);

    const plan = prepareResume(ctx, loadRun(ctx.stateDir, record.id), 'resume');
    expect(plan).toEqual({ done: ['job-1'], redo: ['job-2'], pending: ['job-3'], skipped: [] });
    const calls: string[] = [];
    const done = await runWorker(ctx, record.id, async (job, hooks) => {
      calls.push(job.key);
      hooks.onState('awaiting-code', { codeFile: '/tmp/code.txt' });
      hooks.onState('submitting', { codeSource: 'mail' });
      return { status: 'submitted' };
    }, new AbortController().signal);
    expect(calls).toEqual(['job-2', 'job-3']);
    expect(done.jobs.map((job) => job.state)).toEqual(['unverified', 'submitted', 'submitted']);
    const history = readHistory(ctx.stateDir);
    expect(history.filter((event) => event.type === 'code-provided').map((event) => event.detail)).toEqual([{ source: 'mail' }, { source: 'mail' }]);
    // The code itself is never written anywhere in the history.
    expect(JSON.stringify(history)).not.toMatch(/"code"\s*:/);
  });
});
