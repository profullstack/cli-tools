#!/usr/bin/env node
/**
 * scorecard — one weekly number for the whole fleet.
 *
 *   scorecard                    the report, to stdout
 *   scorecard --send             the same, emailed, and the snapshot kept
 *   scorecard --range 30         a month instead of a week
 *   scorecard --json             the snapshot as JSON
 *   scorecard --no-save          do not write this run into the ledger
 *
 * It shells out to `crawlproof dashboard --json` and `myna dashboard --json`,
 * which already know the traffic, the ads and what went out. Nothing is
 * recomputed here that one of them can answer.
 *
 * Week over week needs a previous week, so the first run says so rather than
 * printing changes against zero. Snapshots live in ~/.local/share/scorecard.
 *
 * Mail goes through Resend, like gh-pulse: RESEND_API_KEY from the
 * environment, else from ~/.config/logicsrc/shell.env, which is the cron case.
 */
import { UsageError, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { run } from '../src/exec.ts';
import { loadShellEnv, sendResend } from '../src/gh-pulse.ts';
import {
  dataDir,
  formatHtml,
  formatReport,
  previousSnapshot,
  saveSnapshot,
  snapshotFrom,
  type Snapshot,
} from '../src/scorecard.ts';

const DEFAULT_FROM = 'Fleet Scorecard <scorecard@profullstack.com>';

const USAGE = `scorecard — one weekly number for the whole fleet

USAGE
  scorecard [--range 7] [--send] [--json] [--no-save]

OPTIONS
  --range N     days to report on (default 7)
  --send        email the report through Resend
  --to a@b.c    recipient (default SCORECARD_TO, then anthony@profullstack.com)
  --from "N <a@b>"  sender on a verified Resend domain
  --json        print the snapshot instead of the report
  --no-save     do not write this run into the ledger
`;

/**
 * Run a command that prints JSON.
 *
 * A tool that fails returns null rather than throwing: half a report is worth
 * having, and which half is missing is said out loud in the report's notes.
 */
export async function readJson<T>(command: string, args: string[], timeoutMs = 240_000): Promise<T | null> {
  const result = await run(command, args, { timeoutMs });
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}

/** crawlproof's range vocabulary, from a number of days. */
export function rangeFor(days: number): string {
  if (days >= 28) return '1m';
  if (days >= 7) return '1w';
  return '1d';
}

async function collect(rangeDays: number): Promise<Snapshot> {
  const [crawlproof, myna] = await Promise.all([
    readJson<Parameters<typeof snapshotFrom>[0]>('crawlproof', [
      'dashboard',
      `--range=${rangeFor(rangeDays)}`,
      '--json',
      '--no-coinpay',
    ]),
    readJson<Parameters<typeof snapshotFrom>[1]>('myna', ['dashboard', '--json'], 90_000),
  ]);
  return snapshotFrom(crawlproof, myna, { rangeDays });
}

async function main(argv: readonly string[]): Promise<number> {
  const { flags, values } = parseArgs(argv, {
    boolean: ['-h', '--help', '--send', '--json', '--no-save'],
    string: ['--range', '--to', '--from'],
  });

  if (flags.has('-h') || flags.has('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const rangeDays = Number(values.get('--range') ?? 7);
  if (!Number.isFinite(rangeDays) || rangeDays < 1) {
    throw new UsageError('--range wants a number of days, like 7 or 30.');
  }

  const snapshot = await collect(rangeDays);
  const previous = previousSnapshot(snapshot.at);

  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(snapshot, previous));
  }

  // Saved after the report is rendered, so this run never reads itself as the
  // previous week, and a crash while rendering leaves the ledger untouched.
  if (!flags.has('--no-save')) {
    const file = saveSnapshot(snapshot, dataDir());
    if (!flags.has('--json')) process.stdout.write(`\n  kept ${file}\n`);
  }

  if (flags.has('--send')) {
    loadShellEnv();
    const key = process.env['RESEND_API_KEY'];
    if (!key) throw new Error('RESEND_API_KEY is not set (and not in ~/.config/logicsrc/shell.env)');
    const to = values.get('--to') ?? process.env['SCORECARD_TO'] ?? 'anthony@profullstack.com';
    const id = await sendResend(
      {
        to,
        from: values.get('--from') ?? DEFAULT_FROM,
        subject: `Fleet scorecard, ${rangeDays} days to ${snapshot.at.slice(0, 10)}`,
        html: formatHtml(snapshot, previous),
        text: formatReport(snapshot, previous),
        images: [],
      },
      key,
      fetch,
    );
    process.stdout.write(`  mailed ${to} (${id})\n`);
  }

  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      console.error(error instanceof UsageError ? error.message : `scorecard: ${error.message}`);
      process.exit(1);
    });
}
