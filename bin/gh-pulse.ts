#!/usr/bin/env node
/**
 * gh-pulse — what moved on GitHub, ranked, with traffic.
 *
 *   gh-pulse                        the daily run: scan every repo, email, snapshot
 *   gh-pulse --dry-run              scan and write the daily report, send nothing
 *   gh-pulse --range week           what moved in the last week, to stdout (no mail)
 *   gh-pulse --range month --send   the same, emailed
 *   gh-pulse --since 2026-09-01     any start date
 *   gh-pulse show [--range year]    the TUI: ranges and filters are clickable
 *   gh-pulse open [--range quarter] the HTML report, in the browser
 *   gh-pulse text [--range all]     plain text
 *   gh-pulse json [--range day]     JSON (what `show` reads)
 *
 * Ranges: hour, day, week, month, quarter, year, all (also 1h, 24h, 7d, 30d,
 * 90d, 365d). A range scan pulls the events live from GitHub for the whole
 * range and the traffic from the ledger of daily snapshots, which is the only
 * place GitHub's fourteen-day traffic window survives. It never moves the
 * daily baseline. `show`, `open`, `text` and `json` reuse a range report that
 * is under an hour old and scan otherwise.
 *
 * Options for a scan:
 *   --to a@b.c        recipient (default GH_PULSE_TO, then the committer email)
 *   --from "N <a@b>"  sender on a verified Resend domain (default GH_PULSE_FROM)
 *   --top N           how many ranked repos get a chart and detail (12)
 *   --repo owner/name only this repo; repeatable; never moves the baseline
 *   --hours N         daily window when there is no previous snapshot (24)
 *   --send            email a range report (the daily run always mails)
 *
 * Mail goes through Resend: RESEND_API_KEY from the environment, else from
 * ~/.config/logicsrc/shell.env (the cron case). A crash sends a FAILED mail.
 */

import { readFileSync } from 'node:fs';

import { UsageError, parseArgs } from '../src/args.ts';
import {
  DEFAULT_FROM,
  RANGE_KEYS,
  customRange,
  dataDir,
  defaultDeps,
  gitEmail,
  loadShellEnv,
  openInBrowser,
  outputPaths,
  parseRangeKey,
  rangeOutputPaths,
  rangeScan,
  rangeSlug,
  rangeSpec,
  readRangeReport,
  run,
  sendFailure,
  type RangeKey,
  type RangeSpec,
  type ReportJson,
} from '../src/gh-pulse.ts';
import { isMain } from '../src/is-main.ts';

export const USAGE = `Usage:
  gh-pulse [--dry-run] [--to ADDR] [--from ADDR] [--top N] [--hours N] [--repo OWNER/NAME]...
  gh-pulse --range ${RANGE_KEYS.join('|')} [--send] [--top N] [--repo OWNER/NAME]...
  gh-pulse --since YYYY-MM-DD [--send]
  gh-pulse show [--range KEY]
  gh-pulse open [--range KEY]
  gh-pulse text [--range KEY]
  gh-pulse json [--range KEY]
  gh-pulse --help`;

function specFrom(rangeText: string | undefined, sinceText: string | undefined, now: Date): RangeSpec | null {
  if (rangeText !== undefined && sinceText !== undefined) throw new UsageError('pass --range or --since, not both');
  if (sinceText !== undefined) return customRange(sinceText, now);
  if (rangeText === undefined) return null;
  const key = parseRangeKey(rangeText);
  if (!key) throw new UsageError(`--range wants one of ${RANGE_KEYS.join(', ')} (or 1h, 24h, 7d, 30d, 90d, 365d), not ${rangeText}`);
  return rangeSpec(key, now);
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['--dry-run', '--send', '--help', '-h'],
    string: ['--to', '--from', '--top', '--hours', '--repo', '--range', '--since'],
  });
  if (parsed.flags.has('--help') || parsed.flags.has('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const dir = dataDir();
  const [verb, ...rest] = parsed.positional;
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);

  const top = Number(parsed.values.get('--top') ?? 12);
  const hours = Number(parsed.values.get('--hours') ?? 24);
  if (!Number.isFinite(top) || top < 0) throw new UsageError('--top wants a non-negative number');
  if (!Number.isFinite(hours) || hours <= 0) throw new UsageError('--hours wants a positive number');
  // parseArgs keeps the last value of a repeated flag; --repo is the one flag
  // people repeat, so it is gathered from argv directly.
  const repos: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--repo' && argv[i + 1]) repos.push(argv[i + 1]!);
    else if (a.startsWith('--repo=')) repos.push(a.slice('--repo='.length));
  }

  loadShellEnv();
  const to = parsed.values.get('--to') ?? process.env['GH_PULSE_TO'] ?? gitEmail();
  const from = parsed.values.get('--from') ?? process.env['GH_PULSE_FROM'] ?? DEFAULT_FROM;
  const deps = defaultDeps();
  const spec = specFrom(parsed.values.get('--range'), parsed.values.get('--since'), deps.now());

  /** A range report, from the hour-fresh cache or a scan. Progress goes wherever the caller wants it. */
  const loadRange = async (s: RangeSpec, progress: (line: string) => void, force = false): Promise<ReportJson> => {
    const cached = force ? null : readRangeReport(dir, rangeSlug(s, repos));
    if (cached) return cached;
    return (await rangeScan({ spec: s, top, repos, dataDir: dir, send: false, to, from, progress }, deps)).report;
  };

  if (verb === 'show') {
    const { showTui } = await import('../src/gh-pulse-tui.ts');
    const startKey: RangeKey | undefined = spec && spec.key !== 'custom' ? spec.key : undefined;
    return showTui(dir, { range: startKey, loadRange: (key, progress) => loadRange(rangeSpec(key, deps.now()), progress) });
  }
  if (verb === 'open' || verb === 'text' || verb === 'json') {
    if (spec) await loadRange(spec, deps.log);
    const paths = spec ? rangeOutputPaths(dir, rangeSlug(spec, repos)) : outputPaths(dir);
    if (verb === 'open') {
      if (openInBrowser(paths.html)) return 0;
      process.stderr.write(`gh-pulse open: no opener found; the report is at ${paths.html}\n`);
      return 1;
    }
    try {
      process.stdout.write(readFileSync(verb === 'text' ? paths.text : paths.json, 'utf8'));
      return 0;
    } catch {
      process.stderr.write(`gh-pulse ${verb}: no report yet in ${dir}. Run \`gh-pulse\` first.\n`);
      return 1;
    }
  }
  if (verb !== undefined) throw new UsageError(`unknown command: ${verb}`);

  if (spec) {
    // A range scan prints the report; mail is opt-in, and the baseline never moves.
    const send = parsed.flags.has('--send');
    if (send && !to) throw new UsageError('no recipient: pass --to, set GH_PULSE_TO, or configure git user.email');
    try {
      await rangeScan({ spec, top, repos, dataDir: dir, send, to, from }, deps);
      process.stdout.write(readFileSync(rangeOutputPaths(dir, rangeSlug(spec, repos)).text, 'utf8'));
      return 0;
    } catch (error) {
      process.stderr.write(`gh-pulse: ${(error as Error).stack ?? String(error)}\n`);
      return 1;
    }
  }

  if (!to) throw new UsageError('no recipient: pass --to, set GH_PULSE_TO, or configure git user.email');
  const dryRun = parsed.flags.has('--dry-run');
  try {
    await run({ dryRun, to, from, top, hours, repos, dataDir: dir }, deps);
    return 0;
  } catch (error) {
    process.stderr.write(`gh-pulse: ${(error as Error).stack ?? String(error)}\n`);
    if (!dryRun) await sendFailure(error, to, from, deps.resendKey(), deps.fetch);
    return 1;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`gh-pulse: ${error.message}\n${USAGE}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`gh-pulse: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
