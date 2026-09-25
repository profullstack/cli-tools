import { describe, expect, it } from 'vitest';

import {
  CronError,
  MARKER,
  escapeCommand,
  getJob,
  listJobs,
  removeJob,
  upsertJob,
  validateSchedule,
  wouldChange,
} from '../src/cronjob.ts';

const JOB = { id: 'nightly-summary', schedule: '0 9 * * *', command: '/usr/bin/true' };

describe('upsertJob', () => {
  it('adds the job to an empty crontab', () => {
    expect(upsertJob('', JOB)).toBe(`${MARKER} nightly-summary\n0 9 * * * /usr/bin/true\n`);
  });

  it('is idempotent: the second run changes nothing', () => {
    const once = upsertJob('', JOB);
    const twice = upsertJob(once, JOB);
    expect(twice).toBe(once);
    expect(wouldChange(once, JOB)).toBe(false);
  });

  it('stays byte-identical over many runs', () => {
    let text = '';
    for (let i = 0; i < 25; i += 1) text = upsertJob(text, JOB);
    expect(listJobs(text)).toHaveLength(1);
    expect(text).toBe(upsertJob('', JOB));
  });

  it('replaces in place rather than appending, so order is stable', () => {
    const start = upsertJob(upsertJob('', { ...JOB, id: 'first' }), { ...JOB, id: 'second' });
    const changed = upsertJob(start, { id: 'first', schedule: '30 2 * * *', command: '/usr/bin/false' });

    expect(listJobs(changed).map((j) => j.id)).toEqual(['first', 'second']);
    expect(getJob(changed, 'first')).toEqual({
      id: 'first',
      schedule: '30 2 * * *',
      command: '/usr/bin/false',
    });
  });

  it('preserves unmanaged entries, env lines and comments exactly', () => {
    const existing = ['MAILTO=ops@example.com', '# hand written, do not touch', '*/5 * * * * /usr/bin/backup', ''].join(
      '\n',
    );
    const after = upsertJob(`${existing}\n`, JOB);

    expect(after).toContain('MAILTO=ops@example.com');
    expect(after).toContain('# hand written, do not touch');
    expect(after).toContain('*/5 * * * * /usr/bin/backup');
    expect(listJobs(after)).toHaveLength(1);
  });

  it('collapses duplicate ids left by a dumber installer', () => {
    const doubled = `${MARKER} nightly-summary\n0 9 * * * /usr/bin/true\n${MARKER} nightly-summary\n0 9 * * * /usr/bin/true\n`;
    const repaired = upsertJob(doubled, JOB);
    expect(listJobs(repaired)).toHaveLength(1);
    expect(repaired).toBe(upsertJob('', JOB));
  });

  it('always ends with a newline, so cron does not drop the last line', () => {
    expect(upsertJob('*/5 * * * * /usr/bin/backup', JOB).endsWith('\n')).toBe(true);
  });
});

describe('removeJob', () => {
  it('removes both lines of the block', () => {
    expect(removeJob(upsertJob('', JOB), 'nightly-summary')).toBe('');
  });

  it('is a no-op for a job that is not there', () => {
    const other = `*/5 * * * * /usr/bin/backup\n`;
    expect(removeJob(other, 'nightly-summary')).toBe(other);
  });

  it('is idempotent', () => {
    const once = removeJob(upsertJob('', JOB), 'nightly-summary');
    expect(removeJob(once, 'nightly-summary')).toBe(once);
  });

  it('leaves unmanaged entries behind', () => {
    const text = upsertJob('*/5 * * * * /usr/bin/backup\n', JOB);
    expect(removeJob(text, 'nightly-summary')).toBe('*/5 * * * * /usr/bin/backup\n');
  });

  it('clears an orphaned marker left by an interrupted write', () => {
    expect(removeJob(`${MARKER} nightly-summary\n`, 'nightly-summary')).toBe('');
  });
});

describe('escapeCommand', () => {
  it('escapes %, which cron otherwise reads as end-of-command', () => {
    expect(escapeCommand('date +%Y-%m-%d')).toBe('date +\\%Y-\\%m-\\%d');
  });

  it('does not double-escape an already-escaped %', () => {
    expect(escapeCommand('date +\\%Y')).toBe('date +\\%Y');
  });

  it('survives a round trip through upsert unchanged', () => {
    const job = { id: 'stamp', schedule: '@daily', command: 'echo %H' };
    const once = upsertJob('', job);
    expect(upsertJob(once, job)).toBe(once);
  });

  it('refuses a multi-line command', () => {
    expect(() => escapeCommand('a\nb')).toThrow(CronError);
  });
});

describe('validateSchedule', () => {
  it('accepts five fields and @shorthands', () => {
    expect(validateSchedule(' 0  9 * * * ')).toBe('0 9 * * *');
    expect(validateSchedule('@daily')).toBe('@daily');
  });

  it('rejects four fields, which is the command getting glued on', () => {
    expect(() => validateSchedule('0 9 * *')).toThrow(CronError);
  });

  it('rejects an unknown shorthand', () => {
    expect(() => validateSchedule('@fortnightly')).toThrow(CronError);
  });
});

describe('listJobs', () => {
  it('reports only managed jobs', () => {
    const text = upsertJob('*/5 * * * * /usr/bin/backup\n', JOB);
    expect(listJobs(text).map((j) => j.id)).toEqual(['nightly-summary']);
  });

  it('parses an @shorthand entry back out', () => {
    const text = upsertJob('', { id: 'x', schedule: '@daily', command: 'run me' });
    expect(getJob(text, 'x')).toEqual({ id: 'x', schedule: '@daily', command: 'run me' });
  });
});
