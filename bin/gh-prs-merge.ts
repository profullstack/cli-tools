#!/usr/bin/env node
/**
 * gh-prs-merge — sweep open pull requests and squash-merge the ones that are
 * genuinely ready.
 *
 * Dry run by default. `--apply` merges. `--fix` additionally repairs the
 * blockers that are mechanical rather than substantive, then judges the PR
 * again against the identical rules.
 *
 *   gh-prs-merge --orgs profullstack
 *   gh-prs-merge --orgs profullstack --apply
 *   gh-prs-merge --orgs profullstack --apply --fix
 */

import { csv, integer, parseArgs, UsageError } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { Gh } from '../src/gh.ts';
import { defaults, render, renderSummary, sweep, type MergeOptions } from '../src/prs-merge.ts';

const USAGE = `Usage:
  gh-prs-merge --orgs ORG1,ORG2 [--users USER1,USER2] [--limit N] [--apply]
  gh-prs-merge --users USER1,USER2 [--limit N] [--apply]

By default, this performs a dry run.

Options:
  --orgs ORG1,ORG2       Search repositories owned by these organizations
  --users USER1,USER2    Search repositories owned by these personal accounts
  --limit N              Maximum PRs per owner; default 1000
  --apply                Actually squash-merge eligible PRs
  --allow-no-checks      Also merge clean PRs that have no CI checks
  --no-ready-drafts      Ignore draft PRs instead of marking them ready
  --fix                  Repair mechanical blockers, then re-evaluate
  --fix-wait SECONDS     How long --fix waits on running checks; default 600
  -h, --help             Show this help

Eligibility:
  - PR is open, and not a draft (or was successfully marked ready)
  - mergeable is MERGEABLE and mergeStateStatus is CLEAN
  - at least one CI check exists, unless --allow-no-checks
  - every check is pass or skipping
  - the head commit has not changed when the merge is submitted

Fixing (--fix):
  A skip is not always a verdict on the PR. Some are this tool arriving at the
  wrong moment. Requires --apply, since every repair writes.

  Repaired:
    checks still running    waits for them to settle, up to --fix-wait
    mergeStateStatus=BEHIND asks GitHub to merge the base branch in
    mergeable=CONFLICTING   same request; it succeeds when the base merely
                            moved underneath the branch

  Never repaired:
    A conflict GitHub declines to merge is left alone and its message printed.
    Resolving one means choosing between two authors' intent. A check that ran
    and failed is a result, not an obstacle.
`;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['--apply', '--allow-no-checks', '--ready-drafts', '--no-ready-drafts', '--fix', '--no-fix', '-h', '--help'],
    string: ['--orgs', '--users', '--limit', '--fix-wait'],
  });

  if (parsed.flags.has('-h') || parsed.flags.has('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const options: MergeOptions = {
    orgs: csv(parsed.values, '--orgs'),
    users: csv(parsed.values, '--users'),
    limit: integer(parsed.values, '--limit', defaults.limit, { min: 1, max: 1000 }),
    apply: parsed.flags.has('--apply'),
    allowNoChecks: parsed.flags.has('--allow-no-checks'),
    readyDrafts: !parsed.flags.has('--no-ready-drafts'),
    fix: parsed.flags.has('--fix') && !parsed.flags.has('--no-fix'),
    fixWaitMs:
      integer(parsed.values, '--fix-wait', defaults.fixWaitMs / 1000, { max: 86_400 }) * 1000,
    pollMs: defaults.pollMs,
  };

  if (options.orgs.length === 0 && options.users.length === 0) {
    process.stderr.write(USAGE);
    throw new UsageError('pass --orgs, --users, or both');
  }

  // A dry run that mutated every repairable PR is the one thing a dry run
  // promises not to do.
  if (options.fix && !options.apply) {
    throw new UsageError('--fix requires --apply');
  }

  const summary = await sweep(options, new Gh(), (line) => {
    const text = render(line);
    if (line.kind === 'failed' || line.kind === 'fixme' || line.kind === 'warn') {
      process.stderr.write(`${text}\n`);
    } else {
      process.stdout.write(`${text}\n`);
    }
  });

  process.stdout.write(`${renderSummary(summary)}\n`);
  return summary.failed > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`gh-prs-merge: ${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(
        `gh-prs-merge: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
