import { Gh, type Check, type MergeState, type PullRequest } from './gh.ts';
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
  | { kind: 'waiting'; parked: number; secondsLeft: number }
  | { kind: 'fixme'; url: string; text: string; title: string }
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

const isPending = (check: Check): boolean => check.bucket === 'pending';

/**
 * Aggregate states in which GitHub will accept a squash merge.
 *
 * CLEAN is the obvious one. HAS_HOOKS is CLEAN with pre-receive hooks. UNSTABLE
 * means mergeable with a non-required context that is not green — GitHub takes
 * the merge, and the check gate below is the stricter test anyway, so treating
 * UNSTABLE as a blocker only skipped PRs that were ready. That was the bug: a
 * manifest refresh sat unmerged with two green checks and nothing wrong with it.
 */
const MERGE_STATE_OK: ReadonlySet<MergeState> = new Set<MergeState>([
  'CLEAN',
  'HAS_HOOKS',
  'UNSTABLE',
]);

/**
 * Why this PR cannot be merged, or empty when it can.
 *
 * One function so `--fix` re-judges with the same rules rather than a copy of
 * them. In the bash version this logic was inline in the loop, which is why
 * adding a re-check meant duplicating it.
 *
 * Checks are judged before the aggregate state deliberately: when both are
 * unhappy, the name of the red check is the useful sentence and
 * `mergeStateStatus=UNSTABLE` is the useless one.
 */
export function reasonNotMergeable(
  pr: PullRequest,
  checks: Check[],
  allowNoChecks: boolean,
): string {
  if (pr.state !== 'OPEN') return `state=${pr.state}`;
  if (pr.isDraft) return 'draft';
  if (pr.mergeable !== 'MERGEABLE') return `mergeable=${pr.mergeable}`;
  if (checks.length === 0 && !allowNoChecks) return 'no CI checks found';

  const bad = checks.filter(isBad);
  if (bad.length > 0) {
    return `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(', ')}`;
  }

  // UNSTABLE is only trustworthy because the checks above were read and were
  // green. With nothing to read there is no second opinion, so hold out for a
  // state GitHub itself calls clean.
  if (checks.length === 0 && pr.mergeStateStatus === 'UNSTABLE') {
    return 'mergeStateStatus=UNSTABLE with no checks to confirm it';
  }

  if (!MERGE_STATE_OK.has(pr.mergeStateStatus)) {
    return `mergeStateStatus=${pr.mergeStateStatus}`;
  }

  return '';
}

/**
 * Can `gh pr update-branch` help?
 *
 * It merges the base into the head, which is possible only when the two do not
 * conflict. DIRTY is GitHub's settled verdict that they do, so asking anyway
 * spends a round trip to be told "Cannot update PR branch due to conflicts" and
 * then prints the refusal as though it were news.
 *
 * A PR that is no longer open has nothing to update either: merging deletes the
 * head branch, so the request comes back "Could not resolve head ref" — a
 * frightening sentence about a PR that is simply already done.
 */
export function isUpdatable(pr: PullRequest): boolean {
  if (pr.state !== 'OPEN') return false;
  if (pr.mergeStateStatus === 'DIRTY') return false;
  return (
    pr.mergeStateStatus === 'BEHIND' ||
    pr.mergeStateStatus === 'UNKNOWN' ||
    pr.mergeable === 'CONFLICTING'
  );
}

/** A blocker `--fix` is willing to act on. */
export function isRepairable(pr: PullRequest, checks: Check[]): boolean {
  if (checks.some(isPending)) return true;
  return isUpdatable(pr);
}

/** A PR set aside until its checks finish, so it does not hold up the sweep. */
interface Parked {
  url: string;
  title: string;
  /** Already counted in `fixed` — a branch update repaired it before parking. */
  repaired: boolean;
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
        text: 'MODE: FIX — repairable blockers are repaired once; PRs whose checks ' +
          'are still running are parked and judged at the end.',
      });
    }
  } else {
    emit({ kind: 'mode', text: 'MODE: DRY RUN — nothing will be merged. Add --apply to merge.' });
  }

  /** Judge a PR believed to be settled, and merge it when it is eligible. */
  const judgeAndMerge = async (pr: PullRequest, checks: Check[]): Promise<void> => {
    const reason = reasonNotMergeable(pr, checks, options.allowNoChecks);

    if (reason) {
      emit({ kind: 'skip', url: pr.url, reason, title: pr.title });
      summary.skipped += 1;
      return;
    }

    emit({ kind: 'ready', url: pr.url, title: pr.title, checks: checks.length });
    summary.ready += 1;

    if (!options.apply) return;

    const merged = await gh.squashMerge(pr.url, pr.headRefOid);
    if (merged.code === 0) {
      emit({ kind: 'merged', url: pr.url });
      summary.merged += 1;
    } else {
      emit({
        kind: 'failed',
        url: pr.url,
        reason: `GitHub refused the merge: ${merged.stderr.trim() || merged.stdout.trim()}`,
      });
      summary.failed += 1;
    }
  };

  const parked: Parked[] = [];

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

    const checks = await gh.checks(url);
    const reason = reasonNotMergeable(pr, checks, options.allowNoChecks);

    // Repair is for open PRs. A PR that was merged or closed between the search
    // and this read is not a blocker to clear — it is finished — and every
    // repair below would ask GitHub about a head branch the merge deleted.
    if (reason && options.fix && pr.state === 'OPEN') {
      // Checks still running. The PR is not blocked, it is unfinished — the
      // only defect is that we looked too early. Set it aside rather than
      // standing here: every PR behind it in the sweep is merge-ready now and
      // should not wait out someone else's test suite.
      if (checks.some(isPending)) {
        emit({ kind: 'fixing', url, text: 'checks still running; parked for the second pass' });
        parked.push({ url, title: pr.title, repaired: false });
        continue;
      }

      if (isUpdatable(pr)) {
        // Base branch moved. GitHub merges it in without a local checkout, and
        // only when the result needs no human judgement.
        emit({ kind: 'fixing', url, text: `${reason}; asking GitHub to merge the base branch in` });
        const updated = await gh.updateBranch(url);

        if (updated.code === 0) {
          summary.fixed += 1;
          // New head, so every check re-runs. Park it for the same reason.
          parked.push({ url, title: pr.title, repaired: true });
          continue;
        }

        const message = (updated.stderr.trim() || updated.stdout.trim()).replace(/\s+/g, ' ');
        emit({
          kind: 'fixme',
          url,
          text: `GitHub could not merge the base in: ${message}`,
          title: pr.title,
        });
        summary.skipped += 1;
        continue;
      }

      if (pr.mergeStateStatus === 'DIRTY') {
        // A real conflict. Say so once — as FIXME, not as a second SKIP line
        // repeating it — and leave it alone: choosing between two authors'
        // intent is not a batch operation.
        emit({
          kind: 'fixme',
          url,
          text: `${reason}; the branch conflicts with its base and needs resolving by hand`,
          title: pr.title,
        });
        summary.skipped += 1;
        continue;
      }
    }

    await judgeAndMerge(pr, checks);
  }

  if (parked.length > 0) {
    await drainParked(parked, options, gh, emit, summary, judgeAndMerge);
  }

  return summary;
}

/**
 * Second pass: wait out the PRs whose checks were still running.
 *
 * The deadline is shared by the whole queue rather than spent per PR. Ten
 * minutes each turns a sweep of five unfinished PRs into fifty minutes of
 * sleeping, and they are all running their suites at the same time anyway.
 */
async function drainParked(
  queue: Parked[],
  options: MergeOptions,
  gh: Gh,
  emit: (line: Line) => void,
  summary: Summary,
  judgeAndMerge: (pr: PullRequest, checks: Check[]) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + options.fixWaitMs;
  let remaining = queue;

  for (;;) {
    const stillRunning: Parked[] = [];

    for (const item of remaining) {
      let checks: Check[];
      try {
        checks = await gh.checks(item.url);
      } catch (error) {
        emit({
          kind: 'warn',
          text: `could not re-read checks for ${item.url} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        stillRunning.push(item);
        continue;
      }

      if (checks.some(isPending)) {
        stillRunning.push(item);
        continue;
      }

      // Settled. Re-read the PR, because the run that just finished may have
      // moved the aggregate state as well as the checks. A PR whose branch was
      // updated first is already counted; waiting it out is the same repair
      // seen through, not a second one.
      if (!item.repaired) summary.fixed += 1;
      try {
        const pr = await gh.pullRequest(item.url);
        await judgeAndMerge(pr, checks);
      } catch (error) {
        emit({
          kind: 'skip',
          url: item.url,
          reason: `could not re-read PR metadata after its checks finished — ${
            error instanceof Error ? error.message : String(error)
          }`,
          title: item.title,
        });
        summary.skipped += 1;
      }
    }

    remaining = stillRunning;
    if (remaining.length === 0) return;

    const msLeft = deadline - Date.now();
    if (msLeft <= 0) {
      for (const item of remaining) {
        emit({
          kind: 'skip',
          url: item.url,
          reason: `checks still running after ${Math.round(options.fixWaitMs / 1000)}s`,
          title: item.title,
        });
        summary.skipped += 1;
      }
      return;
    }

    emit({
      kind: 'waiting',
      parked: remaining.length,
      secondsLeft: Math.round(msLeft / 1000),
    });
    await sleep(Math.min(options.pollMs, msLeft));
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
      return `      … ${line.parked} PR(s) still running checks; ${line.secondsLeft}s left`;
    case 'fixme':
      return `FIXME ${line.url} — ${line.text} — ${line.title}`;
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
