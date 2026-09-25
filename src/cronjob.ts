/**
 * Idempotent CRUD over a user crontab.
 *
 * A crontab is an unordered list of lines with no identity: nothing in the file
 * says "this line is the nightly summary". So the naive way to add a job is to
 * append, and the naive way to run the installer twice is to get the job twice.
 * Every scheduled thing we own then fires N times, where N is how many times
 * somebody re-ran the deploy.
 *
 * The identity is a marker comment carrying an id. A managed job is exactly two
 * lines:
 *
 *     # cli-tools:cronjob nightly-summary
 *     0 9 * * * /usr/bin/whatever
 *
 * `upsert` replaces those two lines IN PLACE when the id is already there, so
 * running it a hundred times leaves a byte-identical file and a clean diff.
 * `remove` on an absent id changes nothing and is not an error. Everything
 * outside a marker block — hand-written entries, MAILTO, PATH, blank lines,
 * somebody's comments — is preserved exactly, because this is a shared file and
 * we are a guest in it.
 */

/** The marker that makes a line ours. Changing this orphans every job. */
export const MARKER = '# cli-tools:cronjob';

export interface CronJob {
  id: string;
  schedule: string;
  command: string;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

/**
 * Ids go in a comment and are matched literally, so they may not contain
 * whitespace (the id would silently truncate at the first space, and two jobs
 * could collapse onto one identity).
 */
export function validateId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new CronError(
      `invalid job id: ${JSON.stringify(id)} — use letters, digits, dot, dash, underscore`,
    );
  }
  return id;
}

/**
 * Five fields, or one of the @shorthands cron accepts.
 *
 * This is a shape check, not a semantic one: it rejects the mistake that
 * actually happens (a four-field schedule, because the command got glued onto
 * the end of it) rather than trying to out-parse cron.
 */
export function validateSchedule(schedule: string): string {
  const trimmed = schedule.trim();
  if (!trimmed) throw new CronError('schedule is empty');

  if (trimmed.startsWith('@')) {
    const allowed = ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'];
    if (!allowed.includes(trimmed)) {
      throw new CronError(`unknown schedule shorthand: ${trimmed}`);
    }
    return trimmed;
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `schedule needs 5 fields (min hour dom mon dow), got ${fields.length}: ${JSON.stringify(trimmed)}`,
    );
  }
  return fields.join(' ');
}

/**
 * `%` is not an ordinary character in a crontab command.
 *
 * cron reads the first unescaped `%` as "end of command"; the rest of the line
 * becomes the job's stdin, with further `%` as newlines. So a perfectly good
 * `date +%Y-%m-%d` runs as `date +` and the job quietly does the wrong thing
 * with no error anywhere. Escaping is not optional.
 */
export function escapeCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new CronError('command is empty');
  if (trimmed.includes('\n')) {
    throw new CronError('command must be a single line; a crontab entry cannot span lines');
  }
  // Escape only the ones not already escaped, so re-running over an
  // already-escaped command does not double up the backslashes.
  return trimmed.replace(/(^|[^\\])%/g, '$1\\%');
}

/** The two lines a managed job occupies. */
export function renderJob(job: CronJob): string[] {
  return [
    `${MARKER} ${validateId(job.id)}`,
    `${validateSchedule(job.schedule)} ${escapeCommand(job.command)}`,
  ];
}

/** Split a crontab into lines without inventing or losing a trailing newline. */
function toLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

/**
 * A crontab must end in a newline — some crons silently ignore a last line
 * without one, which is a job that looks installed and never runs.
 */
function fromLines(lines: string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

/** The id on a marker line, or null if this is not one of ours. */
function markerId(line: string): string | null {
  if (!line.startsWith(MARKER)) return null;
  const rest = line.slice(MARKER.length).trim();
  return rest === '' ? null : rest.split(/\s+/)[0]!;
}

interface Block {
  id: string;
  /** Index of the marker line. */
  start: number;
  /** Number of lines the block occupies (marker + entry, or just marker). */
  length: number;
  schedule: string;
  command: string;
}

/**
 * Find every managed block.
 *
 * A marker whose following line is missing or is itself a marker is a
 * half-written block — from an interrupted write, or a hand edit. It is
 * reported with an empty command so that `upsert` repairs it and `remove`
 * clears it, rather than leaving a dangling comment forever.
 */
export function findBlocks(text: string): Block[] {
  const lines = toLines(text);
  const blocks: Block[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const id = markerId(lines[index]!);
    if (id === null) continue;

    const next = lines[index + 1];
    const orphan = next === undefined || markerId(next) !== null;
    if (orphan) {
      blocks.push({ id, start: index, length: 1, schedule: '', command: '' });
      continue;
    }

    const entry = next.trim();
    const fields = entry.startsWith('@')
      ? [entry.split(/\s+/)[0]!, entry.split(/\s+/).slice(1).join(' ')]
      : [entry.split(/\s+/).slice(0, 5).join(' '), entry.split(/\s+/).slice(5).join(' ')];

    blocks.push({ id, start: index, length: 2, schedule: fields[0]!, command: fields[1] ?? '' });
    index += 1;
  }

  return blocks;
}

/** The managed jobs, in file order. Unmanaged entries are not reported. */
export function listJobs(text: string): CronJob[] {
  return findBlocks(text).map((b) => ({ id: b.id, schedule: b.schedule, command: b.command }));
}

export function getJob(text: string, id: string): CronJob | null {
  const block = findBlocks(text).find((b) => b.id === validateId(id));
  return block ? { id: block.id, schedule: block.schedule, command: block.command } : null;
}

/**
 * Add or replace a job, leaving everything else untouched.
 *
 * Replacement is IN PLACE so the result is stable: the first run and the
 * thousandth produce the same bytes in the same order. Appending instead would
 * still converge, but it would reorder the file on the first run of every
 * changed job and make the diff unreadable.
 *
 * Duplicate ids — which can only come from a hand edit or an older, dumber
 * installer — collapse onto the first, because leaving them would mean the job
 * still fires twice after a "fix".
 */
export function upsertJob(text: string, job: CronJob): string {
  const rendered = renderJob(job);
  const lines = toLines(text);
  const blocks = findBlocks(text).filter((b) => b.id === job.id);

  if (blocks.length === 0) {
    return fromLines([...lines, ...rendered]);
  }

  // Later blocks first, so earlier indexes stay valid while splicing.
  const [first, ...duplicates] = blocks;
  for (const block of [...duplicates].reverse()) {
    lines.splice(block.start, block.length);
  }
  lines.splice(first!.start, first!.length, ...rendered);

  return fromLines(lines);
}

/** Drop a job. Absent is success: the requested end state already holds. */
export function removeJob(text: string, id: string): string {
  validateId(id);
  const lines = toLines(text);
  const blocks = findBlocks(text).filter((b) => b.id === id);

  for (const block of [...blocks].reverse()) {
    lines.splice(block.start, block.length);
  }

  return fromLines(lines);
}

/** Whether applying this job would change anything. Drives --dry-run and quiet re-runs. */
export function wouldChange(text: string, job: CronJob): boolean {
  return upsertJob(text, job) !== text;
}
