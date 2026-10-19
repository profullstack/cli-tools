#!/usr/bin/env node
/**
 * cronjob — install, list and remove scheduled jobs without ever installing one twice.
 *
 *   cronjob list --host dev2
 *   cronjob get nightly-summary --host dev2
 *   cronjob set nightly-summary --schedule '0 9 * * *' --command 'foo' --host dev2
 *   cronjob remove nightly-summary --host dev2
 *
 * Every mutation is idempotent: `set` run twice leaves a byte-identical
 * crontab, and `remove` on a job that is not there succeeds quietly. That is
 * the whole point — a deploy step that appends to a crontab gives you the job
 * once per deploy, and nothing in the file afterwards tells you which copy was
 * meant to be there.
 *
 * Only lines inside our marker blocks are ever touched. Hand-written entries,
 * MAILTO, PATH and comments survive untouched, because this is a shared file.
 */

import { execFileSync } from 'node:child_process';

import { UsageError, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { CronError, getJob, listJobs, removeJob, upsertJob } from '../src/cronjob.ts';

const USAGE = `Usage:
  cronjob list                   [--host HOST] [--user USER]
  cronjob get <id>               [--host HOST] [--user USER]
  cronjob set <id> --schedule S --command C [--host HOST] [--user USER] [-n]
  cronjob remove <id>            [--host HOST] [--user USER] [-n]

Manages the jobs it owns inside a user crontab, identified by a marker comment
so that re-running an install replaces a job instead of adding a second copy.

Options:
      --host HOST      run against this ssh host (default: this machine)
      --user USER      crontab of this user (needs root for anyone but you)
      --schedule S     five cron fields, or an @shorthand
      --command C      the command line to run
  -n, --dry-run        print the resulting crontab, write nothing
  -h, --help           show this help

Exit status is 0 when the requested state holds, whether or not this run had to
change anything, so it is safe in a deploy that reruns.
`;

/** Read a crontab. "no crontab for x" is an empty crontab, not a failure. */
function readCrontab(host: string | undefined, user: string | undefined): string {
  const cronCmd = ['crontab', ...(user ? ['-u', user] : []), '-l'];
  try {
    return run(host, cronCmd);
  } catch (error) {
    const message = (error as { stderr?: Buffer; message?: string }).stderr?.toString() ?? '';
    if (/no crontab for/i.test(message)) return '';
    throw error;
  }
}

/**
 * Write a crontab back, serialised by flock.
 *
 * `crontab -` replaces the whole file, so this is a read-modify-write over
 * shared state. Two deploys landing together would otherwise let the later
 * read win and silently drop the earlier job. The lock is per user and lives
 * in /tmp, which is fine: it only has to outlive the write.
 */
function writeCrontab(host: string | undefined, user: string | undefined, text: string): void {
  const asUser = user ? `-u ${shellQuote(user)} ` : '';
  const script = [
    'set -e',
    'tmp="$(mktemp)"',
    'trap \'rm -f "$tmp"\' EXIT',
    'exec 9>"/tmp/.cronjob-$(id -u).lock"',
    'flock 9',
    'cat > "$tmp"',
    `crontab ${asUser}"$tmp"`,
  ].join('; ');

  const argv = host ? ['ssh', '-o', 'BatchMode=yes', host, script] : ['sh', '-c', script];
  execFileSync(argv[0]!, argv.slice(1), { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function run(host: string | undefined, argv: readonly string[]): string {
  if (host) {
    const remote = argv.map(shellQuote).join(' ');
    return execFileSync('ssh', ['-o', 'BatchMode=yes', host, remote], { encoding: 'utf8' });
  }
  return execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
}

function main(argv: string[]): number {
  const { flags, values, positional } = parseArgs(argv, {
    boolean: ['-h', '--help', '-n', '--dry-run'],
    string: ['--host', '--user', '--schedule', '--command'],
  });

  if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
    process.stdout.write(USAGE);
    return positional.length === 0 && !flags.has('-h') && !flags.has('--help') ? 2 : 0;
  }

  const [action, id] = positional;
  const host = values.get('--host');
  const user = values.get('--user');
  const dryRun = flags.has('-n') || flags.has('--dry-run');

  const before = readCrontab(host, user);

  if (action === 'list') {
    const jobs = listJobs(before);
    if (jobs.length === 0) {
      process.stdout.write('no managed jobs\n');
      return 0;
    }
    for (const job of jobs) process.stdout.write(`${job.id}\t${job.schedule}\t${job.command}\n`);
    return 0;
  }

  if (!id) throw new UsageError(`${action} needs a job id`);

  if (action === 'get') {
    const job = getJob(before, id);
    if (!job) {
      process.stderr.write(`no such job: ${id}\n`);
      return 1;
    }
    process.stdout.write(`${job.id}\t${job.schedule}\t${job.command}\n`);
    return 0;
  }

  let after: string;
  if (action === 'set') {
    const schedule = values.get('--schedule');
    const command = values.get('--command');
    if (!schedule) throw new UsageError('set needs --schedule');
    if (!command) throw new UsageError('set needs --command');
    after = upsertJob(before, { id, schedule, command });
  } else if (action === 'remove') {
    after = removeJob(before, id);
  } else {
    throw new UsageError(`unknown command: ${action}`);
  }

  if (after === before) {
    process.stderr.write(`${id}: already as requested, nothing to do\n`);
    return 0;
  }

  if (dryRun) {
    process.stdout.write(after);
    return 0;
  }

  writeCrontab(host, user, after);
  process.stderr.write(`${id}: ${action === 'remove' ? 'removed' : 'installed'}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError || error instanceof CronError) {
      process.stderr.write(`cronjob: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
