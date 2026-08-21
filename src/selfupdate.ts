/**
 * Keeping the checkout current without being asked.
 *
 * The install is symlinks into a working tree, not a copied build, so "update"
 * means moving somebody's actual checkout. That is why almost all of this file
 * is about deciding *not* to: an unattended `git pull` that discards work, or
 * that quietly moves a branch someone was mid-way through, is far worse than a
 * command being a day out of date.
 *
 * So the rule is narrow and boring. Auto-update runs only when the tree is
 * clean, sitting on the default branch, with nothing of its own to push, and
 * genuinely behind. Anything else is reported and skipped. A person typing
 * `cli-tools update` still gets the old behaviour — their explicit ask, their
 * call.
 */

/** How often the stamp lets an automatic check happen at all. */
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface GitStatus {
  /** The branch name, or null on a detached HEAD. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * v2 rather than v1 because it reports ahead/behind as data. The alternative is
 * scraping the human-readable "Your branch is behind … by 3 commits" line,
 * which is localised — on a machine with a non-English locale that check
 * silently never fires.
 */
export function parseStatus(text: string): GitStatus {
  const status: GitStatus = { head: null, upstream: null, ahead: 0, behind: 0, dirty: false };

  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      status.head = head === '(detached)' ? null : head;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      continue;
    }
    // Anything not a header is a changed, untracked or unmerged path.
    if (line && !line.startsWith('#')) status.dirty = true;
  }

  return status;
}

export type Decision =
  | { action: 'pull'; reason: string }
  | { action: 'skip'; reason: string };

export interface DecideOptions {
  /** The branch an unattended update is allowed to move. */
  defaultBranch?: string;
}

/**
 * Should an unattended update move this checkout?
 *
 * Each refusal names the specific thing in the way, because the failure this
 * guards against is someone concluding auto-update is broken when it is working
 * exactly as designed — sitting on a feature branch, refusing to touch it.
 */
export function decide(status: GitStatus, options: DecideOptions = {}): Decision {
  const defaultBranch = options.defaultBranch ?? 'master';

  if (status.head === null) {
    return { action: 'skip', reason: 'detached HEAD — nothing to fast-forward' };
  }
  if (status.head !== defaultBranch) {
    return {
      action: 'skip',
      reason: `on ${status.head}, not ${defaultBranch} — a branch you are working on is yours to move`,
    };
  }
  if (status.dirty) {
    return { action: 'skip', reason: 'uncommitted changes — not touching them' };
  }
  if (!status.upstream) {
    return { action: 'skip', reason: 'no upstream branch to compare against' };
  }
  if (status.ahead > 0) {
    return {
      action: 'skip',
      reason: `${status.ahead} commit(s) not pushed — pushing or rebasing them is yours to do`,
    };
  }
  if (status.behind === 0) {
    return { action: 'skip', reason: 'already current' };
  }

  return { action: 'pull', reason: `${status.behind} commit(s) behind ${status.upstream}` };
}

/**
 * Has enough time passed since the last automatic check?
 *
 * The stamp exists so that wiring this into something that runs often does not
 * turn every invocation into a network round trip. A missing or unreadable
 * stamp reads as "due", which fails toward doing the check rather than toward
 * never doing it.
 */
export function isDue(
  stamp: number | null,
  now: number,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): boolean {
  if (stamp === null || !Number.isFinite(stamp)) return true;
  // A stamp in the future is a clock that moved; treat it as due rather than
  // waiting out a gap that might be days long.
  if (stamp > now) return true;
  return now - stamp >= intervalMs;
}

export const SERVICE_NAME = 'cli-tools-update.service';
export const TIMER_NAME = 'cli-tools-update.timer';

/**
 * The unit that does the work.
 *
 * The PATH is baked in rather than inherited, and that is the whole reason this
 * is a function instead of a static file. A user unit starts with a minimal
 * PATH — roughly `/usr/bin:/bin` — while the commands here run through a `npx
 * --yes tsx` shebang and the node behind it is usually a version manager's shim
 * somewhere under the home directory. Without the captured PATH the timer fires
 * on schedule, fails to find node, and reports success at the only place anyone
 * would look, so the checkout silently never updates.
 *
 * `Nice` because this is never the thing anyone is waiting for.
 */
export function renderService(execPath: string, pathEnv?: string): string {
  return `[Unit]
Description=cli-tools auto-update
Documentation=https://github.com/profullstack/cli-tools#keeping-it-current

[Service]
Type=oneshot
${pathEnv ? `Environment=PATH=${pathEnv}\n` : ''}ExecStart=${execPath} update --auto
Nice=10
`;
}

/**
 * `Persistent=true` so a machine that was asleep at the scheduled time runs the
 * check once when it comes back, rather than skipping the day entirely.
 */
export function renderTimer(intervalSec: number): string {
  return `[Unit]
Description=cli-tools auto-update (every ${formatInterval(intervalSec)})
Documentation=https://github.com/profullstack/cli-tools#keeping-it-current

[Timer]
OnBootSec=5min
OnUnitActiveSec=${intervalSec}sec
AccuracySec=1min
Persistent=true
Unit=${SERVICE_NAME}

[Install]
WantedBy=timers.target
`;
}

export function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}min`;
  return `${seconds}s`;
}
