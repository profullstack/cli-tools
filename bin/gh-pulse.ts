#!/usr/bin/env node
/**
 * gh-pulse — what moved on GitHub since yesterday, ranked, with traffic.
 *
 *   gh-pulse                        scan every repo, email the report, snapshot
 *   gh-pulse --dry-run              scan and write the report, send nothing
 *   gh-pulse show                   the last report and the history, as a TUI
 *   gh-pulse open                   the last HTML report, in the browser
 *   gh-pulse text                   the last report as plain text
 *   gh-pulse json                   the last report as JSON (what `show` reads)
 *
 * Options for a scan:
 *   --to a@b.c        recipient (default GH_PULSE_TO, then the git email)
 *   --from "N <a@b>"  sender on a verified Resend domain (default GH_PULSE_FROM)
 *   --top N           how many ranked repos get a chart and detail (12)
 *   --repo owner/name only this repo; repeatable; never moves the baseline
 *   --hours N         window when there is no previous snapshot (24)
 *
 * Every repo the gh token can see (yours plus every org, forks excluded) is
 * checked for movement since the previous run: stars, forks, commits, PRs,
 * issues, releases, and the traffic GitHub shows at /graphs/traffic. Movers are
 * ranked by a weighted score; each comes with its traffic, the top ones with a
 * 14-day chart, and new or lost followers are named.
 *
 * GitHub publishes traffic in UTC-day buckets one to two days late, so the
 * window is the growth of the buckets since the previous snapshot rather than
 * a clock. Snapshots live under ~/.local/share/gh-pulse (GH_PULSE_DATA) and are
 * the only long-run traffic record GitHub leaves you.
 *
 * Mail goes through Resend: RESEND_API_KEY from the environment, else from
 * ~/.config/logicsrc/shell.env (the cron case). A crash sends a FAILED mail.
 */

import { readFileSync } from 'node:fs';

import { UsageError, parseArgs } from '../src/args.ts';
import {
  DEFAULT_FROM,
  dataDir,
  defaultDeps,
  gitEmail,
  loadShellEnv,
  openInBrowser,
  outputPaths,
  run,
  sendFailure,
} from '../src/gh-pulse.ts';
import { isMain } from '../src/is-main.ts';

export const USAGE = `Usage:
  gh-pulse [--dry-run] [--to ADDR] [--from ADDR] [--top N] [--hours N] [--repo OWNER/NAME]...
  gh-pulse show
  gh-pulse open
  gh-pulse text
  gh-pulse json
  gh-pulse --help`;

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['--dry-run', '--help', '-h'],
    string: ['--to', '--from', '--top', '--hours', '--repo'],
  });
  if (parsed.flags.has('--help') || parsed.flags.has('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const dir = dataDir();
  const [verb, ...rest] = parsed.positional;
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);

  if (verb === 'show') {
    const { showTui } = await import('../src/gh-pulse-tui.ts');
    return showTui(dir);
  }
  if (verb === 'open') {
    const file = outputPaths(dir).html;
    if (openInBrowser(file)) return 0;
    process.stderr.write(`gh-pulse open: no opener found; the report is at ${file}\n`);
    return 1;
  }
  if (verb === 'text' || verb === 'json') {
    const file = verb === 'text' ? outputPaths(dir).text : outputPaths(dir).json;
    try {
      process.stdout.write(readFileSync(file, 'utf8'));
      return 0;
    } catch {
      process.stderr.write(`gh-pulse ${verb}: no report yet in ${dir}. Run \`gh-pulse\` first.\n`);
      return 1;
    }
  }
  if (verb !== undefined) throw new UsageError(`unknown command: ${verb}`);

  const top = Number(parsed.values.get('--top') ?? 12);
  const hours = Number(parsed.values.get('--hours') ?? 24);
  if (!Number.isFinite(top) || top < 0) throw new UsageError('--top wants a non-negative number');
  if (!Number.isFinite(hours) || hours <= 0) throw new UsageError('--hours wants a positive number');

  loadShellEnv();
  const to = parsed.values.get('--to') ?? process.env['GH_PULSE_TO'] ?? gitEmail();
  if (!to) throw new UsageError('no recipient: pass --to, set GH_PULSE_TO, or configure git user.email');
  const from = parsed.values.get('--from') ?? process.env['GH_PULSE_FROM'] ?? DEFAULT_FROM;
  const dryRun = parsed.flags.has('--dry-run');
  // parseArgs keeps the last value of a repeated flag; --repo is the one flag
  // people repeat, so it is gathered from argv directly.
  const repos: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--repo' && argv[i + 1]) repos.push(argv[i + 1]!);
    else if (a.startsWith('--repo=')) repos.push(a.slice('--repo='.length));
  }

  const deps = defaultDeps();
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
