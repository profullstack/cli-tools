import { Gh, type Check, type PullRequest } from './gh.ts';
import { sleep } from './exec.ts';

export interface MergeOptions {
  orgs: string[];
  users: string[];
  limit: number;
  apply: boolean;
  allowNoChecks: boolean;
  readyDrafts: boolean;
  fix: boolean;
  fixWaitMs: number;
  /** Poll interval while waiting on running checks. Shortened by tests. */
  pollMs: number;
}

export interface Summary {
  ready: number;
  readied: number;
  fixed: number;
  merged: number;
  skipped: number;
  failed: number;
}

export type Line =
  | { kind: 'mode'; text: string }
  | { kind: 'ready'; url: string; title: string; checks: number }
  | { kind: 'merged'; url: string }
  | { kind: 'readied'; url: string; title: string }
  | { kind: 'would-ready'; url: string; title: string }
  | { kind: 'fixing'; url: string; text: string }
  | { kind: 'waiting'; url: string; pending: number }
  | { kind: 'fixme'; url: string; text: string }
  | { kind: 'skip'; url: string; reason: string; title: string }
  | { kind: 'failed'; url: string; reason: string }
  | { kind: 'warn'; text: string };

export const defaults = {
  limit: 1000,
  fixWaitMs: 600_000,
  pollMs: 20_000,
} as const;

const isBad = (check: Check): boolean =>
  check.bucket !== 'pass' && check.bucket !== 'skipping';

/**
 * Why this PR cannot be merged, or empty when it can.
 *
 * One function so `--fix` re-judges with the same rules rather than a copy of
 * them. In the bash version this logic was inline in the loop, which is why
 * adding a re-check meant duplicating it.
 */
export function reasonNotMergeable(
  pr: PullRequest,
  checks: Check[],
  allowNoChecks: boolean,
): string {
  if (pr.state !== 'OPEN') return `state=${pr.state}`;
  if (pr.isDraft) return 'draft';
  if (pr.mergeable !== 'MERGEABLE') return `mergeable=${pr.mergeable}`;
  if (pr.mergeStateStatus !== 'CLEAN') return `mergeStateStatus=${pr.mergeStateStatus}`;
  if (checks.length === 0 && !allowNoChecks) return 'no CI checks found';

  const bad = checks.filter(isBad);
  if (bad.length > 0) {
    return `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(', ')}`;
  }

  return '';
}

/** A blocker `--fix` is willing to act on. */
export function isRepairable(pr: PullRequest, checks: Check[]): boolean {
  if (checks.some((check) => check.bucket === 'pending')) return true;
  return (
    pr.mergeStateStatus === 'BEHIND' ||
    pr.mergeStateStatus === 'DIRTY' ||
    pr.mergeable === 'CONFLICTING'
  );
}

export async function sweep(
  options: MergeOptions,
  gh: Gh,
  emit: (line: Line) => void,
): Promise<Summary> {
  const summary: Summary = {
    ready: 0,
    readied: 0,
    fixed: 0,
    merged: 0,
    skipped: 0,
    failed: 0,
  };

  const found = new Map<string, string>();

  for (const [qualifier, owners] of [
    ['org', options.orgs],
    ['user', options.users],
  ] as const) {
    for (const owner of owners) {
      try {
        const prs = await gh.searchPrs(qualifier, owner, {
          limit: options.limit,
          includeDrafts: options.readyDrafts,
        });
        for (const pr of prs) {
          if (!found.has(pr.url)) found.set(pr.url, pr.createdAt);
        }
      } catch (error) {
        emit({
          kind: 'warn',
          text: `skipped inaccessible or invalid scope ${qualifier}:${owner} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  }

  const urls = [...found.entries()]
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([url]) => url);

  if (options.apply) {
    emit({
      kind: 'mode',
      text: options.readyDrafts
        ? 'MODE: APPLY — drafts will be marked ready and eligible PRs squash-merged.'
        : 'MODE: APPLY — eligible PRs will be squash-merged.',
    });
    if (options.fix) {
      emit({
        kind: 'mode',
        text: 'MODE: FIX — repairable blockers will be repaired once, then re-judged.',
      });
    }
  } else {
    emit({ kind: 'mode', text: 'MODE: DRY RUN — nothing will be merged. Add --apply to merge.' });
  }

  for (const url of urls) {
    let pr: PullRequest;

    try {
      pr = await gh.pullRequest(url);
    } catch (error) {
      emit({
        kind: 'skip',
        url,
        reason: `could not read PR metadata — ${
          error instanceof Error ? error.message : String(error)
        }`,
        title: '',
      });
      summary.skipped += 1;
      continue;
    }

    // Take drafts out of draft first, then judge them like any other PR.
    if (pr.isDraft && pr.state === 'OPEN' && options.readyDrafts) {
      if (!options.apply) {
        emit({ kind: 'would-ready', url, title: pr.title });
        summary.skipped += 1;
        continue;
      }

      const readied = await gh.ready(url);
      if (readied.code !== 0) {
        emit({ kind: 'failed', url, reason: 'could not mark draft ready' });
        summary.failed += 1;
        continue;
      }

      emit({ kind: 'readied', url, title: pr.title });
      summary.readied += 1;

      try {
        pr = await gh.pullRequest(url, { awaitReady: true });
      } catch (error) {
        emit({
          kind: 'skip',
          url,
          reason: `could not re-read PR metadata after marking ready — ${
            error instanceof Error ? error.message : String(error)
          }`,
          title: pr.title,
        });
        summary.skipped += 1;
        continue;
      }
    }

    let checks = await gh.checks(url);
    let reason = reasonNotMergeable(pr, checks, options.allowNoChecks);

    if (reason && options.fix && isRepairable(pr, checks)) {
      const repaired = await repair({ url, checks, reason, options, gh, emit });

      if (repaired) {
        summary.fixed += 1;
        try {
          pr = await gh.pullRequest(url);
          checks = await gh.checks(url);
          reason = reasonNotMergeable(pr, checks, options.allowNoChecks);
        } catch (error) {
          emit({
            kind: 'warn',
            text: `could not re-read ${url} after repair — ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
    }

    if (reason) {
      emit({ kind: 'skip', url, reason, title: pr.title });
      summary.skipped += 1;
      continue;
    }

    emit({ kind: 'ready', url, title: pr.title, checks: checks.length });
    summary.ready += 1;

    if (!options.apply) continue;

    const merged = await gh.squashMerge(url, pr.headRefOid);
    if (merged.code === 0) {
      emit({ kind: 'merged', url });
      summary.merged += 1;
    } else {
      emit({
        kind: 'failed',
        url,
        reason: `GitHub refused the merge: ${merged.stderr.trim() || merged.stdout.trim()}`,
      });
      summary.failed += 1;
    }
  }

  return summary;
}

/**
 * One repair attempt. Returns true when something was done.
 *
 * Deliberately not a loop: if a repair did not make the PR mergeable, doing it
 * again will not either, and a tool that keeps trying turns a sweep into an
 * afternoon of API calls.
 */
async function repair(args: {
  url: string;
  checks: Check[];
  reason: string;
  options: MergeOptions;
  gh: Gh;
  emit: (line: Line) => void;
}): Promise<boolean> {
  const { url, checks, reason, options, gh, emit } = args;

  // Checks still running. The PR is not blocked, it is unfinished — the only
  // defect is that we looked too early. This is the common false skip.
  if (checks.some((check) => check.bucket === 'pending')) {
    emit({
      kind: 'fixing',
      url,
      text: `checks still running; waiting up to ${Math.round(options.fixWaitMs / 1000)}s`,
    });
    await waitForChecks(url, options, gh, emit);
    return true;
  }

  // Base branch moved. GitHub merges it in without a local checkout, and only
  // when the result needs no human judgement.
  emit({ kind: 'fixing', url, text: `${reason}; asking GitHub to merge the base branch in` });

  const updated = await gh.updateBranch(url);

  if (updated.code !== 0) {
    // A real conflict. Print what GitHub said and leave it alone: choosing
    // between two authors' intent is not a batch operation.
    const message = (updated.stderr.trim() || updated.stdout.trim()).replace(/\s+/g, ' ');
    emit({ kind: 'fixme', url, text: `GitHub could not merge the base in: ${message}` });
    return false;
  }

  // New head, so every check re-runs. Waiting here is what makes the repair
  // worth anything — otherwise the re-judge sees a pending suite and skips for
  // the very reason we just set in motion.
  await waitForChecks(url, options, gh, emit);
  return true;
}

async function waitForChecks(
  url: string,
  options: MergeOptions,
  gh: Gh,
  emit: (line: Line) => void,
): Promise<void> {
  const deadline = Date.now() + options.fixWaitMs;

  for (;;) {
    const checks = await gh.checks(url);
    const pending = checks.filter((check) => check.bucket === 'pending').length;

    if (pending === 0) return;
    if (Date.now() >= deadline) return;

    emit({ kind: 'waiting', url, pending });
    await sleep(options.pollMs);
  }
}

export function render(line: Line): string {
  switch (line.kind) {
    case 'mode':
      return line.text;
    case 'ready':
      return `READY ${line.url} — ${line.checks} checks green — ${line.title}`;
    case 'merged':
      return `MERGED ${line.url}`;
    case 'readied':
      return `READIED ${line.url} — ${line.title}`;
    case 'would-ready':
      return `WOULD-READY ${line.url} — draft; would mark ready, then re-check — ${line.title}`;
    case 'fixing':
      return `FIXING ${line.url} — ${line.text}`;
    case 'waiting':
      return `      … ${line.pending} check(s) still running on ${line.url}; waiting`;
    case 'fixme':
      return `FIXME ${line.url} — ${line.text}`;
    case 'skip':
      return `SKIP  ${line.url} — ${line.reason} — ${line.title}`;
    case 'failed':
      return `FAILED ${line.url} — ${line.reason}`;
    case 'warn':
      return `WARN: ${line.text}`;
  }
}

export function renderSummary(summary: Summary): string {
  return (
    `\nSummary: ready=${summary.ready} readied=${summary.readied} ` +
    `fixed=${summary.fixed} merged=${summary.merged} ` +
    `skipped=${summary.skipped} failed=${summary.failed}`
  );
}
