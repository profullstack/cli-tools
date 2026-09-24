import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { JobsError } from './jobs-config.ts';
import {
  type QueueItem,
  appendJsonl,
  logHistory,
  readApplied,
  appliedSet,
  readJson,
  recordApplied,
  resultsPath,
  writeJsonAtomic,
} from './jobs-state.ts';

/**
 * An apply run: a snapshot of the queue, and where each job in it got to.
 *
 * Everything a resume needs is in the record on disk, written after every
 * change, so a run survives a reboot or a crash with no in-memory state at
 * all. The per-job states are chosen so that "where did it get to" always has
 * an answer that says what to do next:
 *
 *   pending        not started, or abandoned — do it (again)
 *   running        filling the form — the form is gone after a crash: redo it
 *   awaiting-code  submitted once, waiting for a Greenhouse security code; the
 *                  application does not exist without the code, so: redo it
 *   submitting     the final submit was clicked — it may have gone through, so
 *                  after a crash it becomes `unverified` and is never resent
 *   prepared       dry run: filled, not submitted
 *   submitted / unverified / needs-human-review / failed / skipped:<why> — done
 */

export type JobState =
  | 'pending' | 'running' | 'awaiting-code' | 'submitting'
  | 'prepared' | 'submitted' | 'unverified' | 'needs-human-review' | 'failed'
  | `skipped:${string}`;

export interface RunJob extends QueueItem {
  state: JobState;
  reason?: string;
  unknown?: string[];
  attempts: number;
  at?: string;
}

export type RunStatus = 'running' | 'stopping' | 'stopped' | 'finished' | 'crashed';

export interface RunRecord {
  id: string;
  profile: string;
  dryRun: boolean;
  status: RunStatus;
  pid: number | null;
  stopRequested: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** Where a detached run writes its output. */
  log: string | null;
  /** The process group of the browser a job has open, so a crash can still close it. */
  browserGroup?: number | null;
  jobs: RunJob[];
}

export type OutcomeStatus = 'prepared' | 'submitted' | 'unverified' | 'needs-human-review' | 'failed' | 'abandoned';

export interface Outcome {
  status: OutcomeStatus;
  reason?: string;
  unknown?: string[];
}

export interface ApplyHooks {
  signal: AbortSignal;
  /** Report progress: `awaiting-code` (with the code file), `submitting` (with the code's source, when there was one). */
  onState(state: 'awaiting-code' | 'submitting', detail?: { codeFile?: string; codeSource?: 'mail' | 'file' }): void;
  /** The browser's process group while a job has one open, null once it is closed. */
  onBrowser?(group: number | null): void;
}

export type ApplyJob = (job: RunJob, hooks: ApplyHooks) => Promise<Outcome>;

export interface RunContext {
  stateDir: string;
  profileDir: string;
  /** One JSON line per event worth showing whoever is watching the run. */
  emit?: (line: Record<string, unknown>) => void;
  now?: () => Date;
}

const DONE_STATES = new Set(['prepared', 'submitted', 'unverified', 'needs-human-review', 'failed']);
export const isDone = (state: JobState) => DONE_STATES.has(state) || state.startsWith('skipped:');

export const runsDir = (stateDir: string) => join(stateDir, 'runs');
export const runPath = (stateDir: string, id: string) => join(runsDir(stateDir), `${id}.json`);
export const runLogPath = (stateDir: string, id: string) => join(runsDir(stateDir), `${id}.log`);

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function loadRun(stateDir: string, id: string): RunRecord {
  const record = readJson<RunRecord | null>(runPath(stateDir, id), null);
  if (!record) throw new JobsError(`no run "${id}" — \`jobhunt run list\` shows them`);
  return record;
}

export function saveRun(stateDir: string, record: RunRecord, now: Date = new Date()): void {
  record.updatedAt = now.toISOString();
  writeJsonAtomic(runPath(stateDir, record.id), record);
}

export function listRuns(stateDir: string): RunRecord[] {
  let names: string[];
  try {
    names = readdirSync(runsDir(stateDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((name) => readJson<RunRecord | null>(join(runsDir(stateDir), name), null))
    .filter((record): record is RunRecord => record !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The run a bare `run stop|resume|show` means: the newest for this profile. */
export function latestRun(stateDir: string, profile: string): RunRecord | null {
  return listRuns(stateDir).find((record) => record.profile === profile) ?? null;
}

/** Is that process still there? EPERM means it is, just not ours to signal. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Snapshot the queue into a new run. Anything already applied to is marked skipped, not dropped, so the run says why. */
export function createRun(
  context: RunContext,
  profile: string,
  queue: QueueItem[],
  { dryRun, only }: { dryRun: boolean; only?: string | undefined },
): RunRecord {
  const now = (context.now ?? (() => new Date()))();
  const seen = appliedSet(readApplied(context.stateDir));
  const picked = only ? queue.filter((item) => item.key === only) : queue;
  if (only && picked.length === 0) throw new JobsError(`no queued job "${only}" — \`jobhunt queue\` lists them`);
  const record: RunRecord = {
    id: newRunId(now),
    profile,
    dryRun,
    status: 'running',
    pid: null,
    stopRequested: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    endedAt: null,
    log: null,
    jobs: picked.map((item) => ({
      ...item,
      state: seen(item.url) || seen(item.applyUrl) ? 'skipped:already-applied' : 'pending',
      attempts: 0,
    })),
  };
  saveRun(context.stateDir, record, now);
  logHistory(context.stateDir, {
    type: 'run-start',
    profile,
    run: record.id,
    detail: { dryRun, jobs: record.jobs.length, pending: record.jobs.filter((job) => job.state === 'pending').length },
  });
  return record;
}

/**
 * Settle a run whose process is gone.
 *
 * A record that says "running" with no live process behind it crashed (or the
 * box rebooted). The job it was on is resolved by where it got to: a job past
 * its final submit becomes `unverified` and goes on the never-twice list —
 * sending it again is the one outcome that cannot be taken back — while one
 * still filling or waiting for a code is left to be redone on resume.
 */
export function reconcile(
  context: RunContext,
  record: RunRecord,
  alive: (pid: number) => boolean = pidAlive,
  killGroup: (group: number) => void = (group) => {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // Already gone.
    }
  },
): RunRecord {
  if (record.status !== 'running' && record.status !== 'stopping') return record;
  if (record.pid !== null && alive(record.pid)) return record;
  const now = (context.now ?? (() => new Date()))();
  // The worker died with a browser open; nothing else will ever close it.
  if (record.browserGroup) killGroup(record.browserGroup);
  record.browserGroup = null;
  const inFlight = record.jobs.filter((job) => ['running', 'awaiting-code', 'submitting'].includes(job.state));
  // Where each job stood when the process died, before settling changes it.
  const stood = inFlight.map((job) => `${job.key}:${job.state}`);
  for (const job of inFlight) {
    if (job.state === 'submitting') settle(context, record, job, { status: 'unverified', reason: 'run ended after the submit click' }, now);
  }
  record.status = 'crashed';
  record.pid = null;
  record.endedAt = now.toISOString();
  saveRun(context.stateDir, record, now);
  logHistory(context.stateDir, {
    type: 'run-crash',
    profile: record.profile,
    run: record.id,
    detail: { inFlight: stood },
  });
  return record;
}

export interface ResumePlan {
  /** Done in this run already; left alone. */
  done: string[];
  /** Stopped mid-form or awaiting a code; started again from scratch. */
  redo: string[];
  /** Never started. */
  pending: string[];
  /** Applied to elsewhere since the run began. */
  skipped: string[];
}

/** Put a stopped or crashed run back into a runnable state, and say what carries over. */
export function prepareResume(context: RunContext, record: RunRecord, kind: 'resume' | 'restart'): ResumePlan {
  if (record.status === 'running' || record.status === 'stopping') {
    throw new JobsError(`run ${record.id} is still ${record.status} (pid ${record.pid}) — \`jobhunt run stop ${record.id}\` first`);
  }
  const seen = appliedSet(readApplied(context.stateDir));
  const plan: ResumePlan = { done: [], redo: [], pending: [], skipped: [] };
  for (const job of record.jobs) {
    if (isDone(job.state)) plan.done.push(job.key);
    else if (seen(job.url) || seen(job.applyUrl)) {
      job.state = 'skipped:already-applied';
      plan.skipped.push(job.key);
    } else if (job.state === 'pending' && job.attempts === 0) plan.pending.push(job.key);
    else {
      // Mid-form, abandoned, or waiting for a code: the browser session and
      // the code are gone, and without the code nothing was submitted.
      job.state = 'pending';
      plan.redo.push(job.key);
    }
  }
  record.status = 'stopped';
  record.stopRequested = false;
  record.endedAt = null;
  saveRun(context.stateDir, record);
  logHistory(context.stateDir, {
    type: kind === 'restart' ? 'run-restart' : 'run-resume',
    profile: record.profile,
    run: record.id,
    detail: { ...plan },
  });
  return plan;
}

function settle(context: RunContext, record: RunRecord, job: RunJob, outcome: Outcome, now: Date): void {
  job.state = outcome.status as JobState;
  job.at = now.toISOString();
  if (outcome.reason) job.reason = outcome.reason;
  if (outcome.unknown?.length) job.unknown = outcome.unknown;
  const row = {
    key: job.key, company: job.company, title: job.title, url: job.url,
    status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.unknown?.length ? { unknown: outcome.unknown } : {}),
    run: record.id, dryRun: record.dryRun, at: job.at,
  };
  appendJsonl(resultsPath(context.profileDir), row);
  if (!record.dryRun && (outcome.status === 'submitted' || outcome.status === 'unverified')) {
    // unverified = submit clicked and no error seen; it counts, so it is never sent twice.
    recordApplied(context.stateDir, {
      url: job.url, company: job.company, title: job.title, status: outcome.status,
      via: 'jobhunt', profile: record.profile, run: record.id, at: job.at,
    });
  }
  logHistory(context.stateDir, {
    type: 'job-outcome', profile: record.profile, run: record.id, key: job.key, company: job.company, url: job.url,
    status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.unknown?.length ? { detail: { unknown: outcome.unknown } } : {}),
  });
  context.emit?.(row);
}

/**
 * Work through a run's pending jobs, one at a time, in this process.
 *
 * Stopping is cooperative: `signal` (a SIGTERM or Ctrl-C in the bin) or the
 * record's stopRequested ends the run between jobs, and `applyJob` sees the
 * same signal so it can abandon a half-filled form rather than submit it.
 */
export async function runWorker(
  context: RunContext,
  id: string,
  applyJob: ApplyJob,
  signal: AbortSignal,
): Promise<RunRecord> {
  const now = () => (context.now ?? (() => new Date()))();
  const record = loadRun(context.stateDir, id);
  if (record.status === 'running' && record.pid !== null && record.pid !== process.pid && pidAlive(record.pid)) {
    throw new JobsError(`run ${id} is already running as pid ${record.pid}`);
  }
  record.status = 'running';
  record.pid = process.pid;
  record.endedAt = null;
  saveRun(context.stateDir, record, now());

  // Merge a stop written by another process before each write of ours.
  const save = () => {
    const disk = readJson<RunRecord | null>(runPath(context.stateDir, id), null);
    if (disk?.stopRequested) record.stopRequested = true;
    saveRun(context.stateDir, record, now());
  };
  const stopping = () => {
    save();
    return signal.aborted || record.stopRequested;
  };

  for (const job of record.jobs) {
    if (job.state !== 'pending') continue;
    if (stopping()) break;
    const seen = appliedSet(readApplied(context.stateDir));
    if (seen(job.url) || seen(job.applyUrl)) {
      job.state = 'skipped:already-applied';
      save();
      continue;
    }

    job.state = 'running';
    job.attempts += 1;
    save();
    logHistory(context.stateDir, { type: 'job-start', profile: record.profile, run: id, key: job.key, company: job.company, url: job.url });
    context.emit?.({ key: job.key, company: job.company, status: 'running' });

    let outcome: Outcome;
    try {
      outcome = await applyJob(job, {
        signal,
        onBrowser(group) {
          record.browserGroup = group;
          save();
        },
        onState(state, detail) {
          job.state = state;
          save();
          if (state === 'awaiting-code') {
            logHistory(context.stateDir, { type: 'awaiting-code', profile: record.profile, run: id, key: job.key, company: job.company, ...(detail?.codeFile ? { detail: { codeFile: detail.codeFile } } : {}) });
            context.emit?.({ key: job.key, company: job.company, status: 'awaiting-code', ...(detail?.codeFile ? { codeFile: detail.codeFile } : {}) });
          }
          if (detail?.codeSource) {
            logHistory(context.stateDir, { type: 'code-provided', profile: record.profile, run: id, key: job.key, company: job.company, detail: { source: detail.codeSource } });
          }
        },
      });
    } catch (error) {
      outcome = { status: 'failed', reason: (error as Error).message.slice(0, 300) };
    }

    if (outcome.status === 'abandoned') {
      job.state = 'pending';
      save();
      logHistory(context.stateDir, { type: 'job-abandoned', profile: record.profile, run: id, key: job.key, company: job.company, ...(outcome.reason ? { reason: outcome.reason } : {}) });
      context.emit?.({ key: job.key, company: job.company, status: 'abandoned', reason: outcome.reason ?? 'stopped' });
      break;
    }
    settle(context, record, job, outcome, now());
    save();
  }

  const stopped = signal.aborted || record.stopRequested;
  const left = record.jobs.filter((job) => !isDone(job.state)).length;
  record.status = stopped && left > 0 ? 'stopped' : 'finished';
  record.pid = null;
  record.stopRequested = false;
  record.endedAt = now().toISOString();
  saveRun(context.stateDir, record, now());
  const counts: Record<string, number> = {};
  for (const job of record.jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
  logHistory(context.stateDir, {
    type: record.status === 'stopped' ? 'run-stop' : 'run-finish',
    profile: record.profile,
    run: id,
    detail: { ...counts, ...(record.status === 'stopped' ? { stopped: 'between jobs' } : {}) },
  });
  context.emit?.({ run: id, status: record.status === 'stopped' ? 'run-stopped' : 'queue-finished', ...counts });
  return record;
}

/**
 * Ask a running run to stop, from any process.
 *
 * The stop is written to the record and the worker is sent SIGTERM; the
 * worker finishes the job it is on only if that job is past its final submit,
 * otherwise it abandons the form unsubmitted. A worker that does not answer
 * within `graceMs` is killed, and reconcile settles what it left behind.
 */
export async function stopRun(
  context: RunContext,
  id: string,
  {
    graceMs = 90_000,
    alive = pidAlive,
    kill = (pid, sig) => {
      process.kill(pid, sig);
    },
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    graceMs?: number;
    alive?: (pid: number) => boolean;
    kill?: (pid: number, sig: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<RunRecord> {
  let record = reconcile(context, loadRun(context.stateDir, id), alive);
  if (record.status !== 'running' && record.status !== 'stopping') return record;
  record.stopRequested = true;
  record.status = 'stopping';
  saveRun(context.stateDir, record);
  logHistory(context.stateDir, { type: 'run-stop', profile: record.profile, run: id, detail: { requested: true, pid: record.pid } });
  const pid = record.pid!;
  try {
    kill(pid, 'SIGTERM');
  } catch {
    // Already gone; reconcile below says so.
  }
  for (let waited = 0; waited < graceMs; waited += 500) {
    record = loadRun(context.stateDir, id);
    if (record.status !== 'running' && record.status !== 'stopping') return record;
    if (!alive(pid)) break;
    await sleep(500);
  }
  if (alive(pid)) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      // Raced its own exit.
    }
    await sleep(300);
  }
  return reconcile(context, loadRun(context.stateDir, id), () => false);
}

export function formatRun(record: RunRecord): string {
  const counts: Record<string, number> = {};
  for (const job of record.jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
  const head = [
    `run ${record.id}  ${record.status}${record.pid ? ` (pid ${record.pid})` : ''}${record.dryRun ? '  dry run' : ''}`,
    `profile ${record.profile}  started ${record.createdAt.slice(0, 19).replace('T', ' ')}` +
      (record.endedAt ? `  ended ${record.endedAt.slice(0, 19).replace('T', ' ')}` : ''),
    Object.entries(counts).map(([state, count]) => `${state} ${count}`).join(' · '),
    '',
  ];
  const rows = record.jobs.map((job) =>
    `${job.state.padEnd(20)} ${job.key.padEnd(40)} ${job.company} — ${job.title}` +
      (job.reason ? `\n${' '.repeat(21)}${job.reason}` : '') +
      (job.unknown?.length ? `\n${' '.repeat(21)}unanswered: ${job.unknown.join('; ')}` : ''),
  );
  return [...head, ...rows].join('\n');
}

export function formatRunLine(record: RunRecord): string {
  const done = record.jobs.filter((job) => isDone(job.state)).length;
  return `${record.id}  ${record.status.padEnd(9)} ${record.profile.padEnd(16)} ${done}/${record.jobs.length} done${record.dryRun ? '  dry run' : ''}`;
}
