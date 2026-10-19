import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { run, type RunResult } from './exec.ts';
import { parsePullRequestUrl, type PullRequest } from './gh.ts';

/**
 * Lockfiles a package manager can rebuild from the manifests beside it.
 *
 * A conflict in one of these is not two authors disagreeing: each side bumped
 * a dependency, and the merged package.json already says what both wanted. Take
 * the base's lockfile and let the tool that owns it re-resolve. Lockfile-only
 * and no scripts, so nothing from the branch is executed.
 *
 * yarn.lock is absent on purpose: classic yarn has no lockfile-only mode, and
 * guessing which yarn a repo uses is worse than a FIXME.
 */
export const LOCKFILES: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  'bun.lock': ['bun', ['install', '--lockfile-only', '--ignore-scripts']],
  'bun.lockb': ['bun', ['install', '--lockfile-only', '--ignore-scripts']],
  'pnpm-lock.yaml': ['pnpm', ['install', '--lockfile-only', '--ignore-scripts']],
  'package-lock.json': [
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  ],
};

export const isLockfile = (path: string): boolean => basename(path) in LOCKFILES;

export type LockfileOutcome =
  | { kind: 'resolved'; files: string[] }
  | { kind: 'manual'; reason: string };

/** Resolves a DIRTY PR when every conflicting file is a lockfile. */
export type LockfileResolver = (pr: PullRequest) => Promise<LockfileOutcome>;

const tail = (result: RunResult): string =>
  (result.stderr.trim() || result.stdout.trim()).replace(/\s+/g, ' ').slice(-300);

/**
 * Merge the base into the head in a throwaway blobless clone, rebuild the
 * conflicting lockfiles, and push the merge commit. Never a force push: if the
 * branch moved underneath us the push is refused and the PR stays a FIXME.
 *
 * The clone lives under ~/.cache, not os.tmpdir(): on these boxes /tmp is a
 * quota'd tmpfs and a repo checkout is exactly what fills it.
 */
export async function resolveLockfileConflicts(
  pr: PullRequest,
  exec: typeof run = run,
): Promise<LockfileOutcome> {
  const parsed = parsePullRequestUrl(pr.url);
  if (!parsed) return { kind: 'manual', reason: `cannot parse ${pr.url}` };

  const env = { ...process.env, GH_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
  const view = await exec(
    'gh',
    ['pr', 'view', pr.url, '--json', 'headRefName,baseRefName,isCrossRepository'],
    { env },
  );
  if (view.code !== 0) return { kind: 'manual', reason: `gh pr view failed: ${tail(view)}` };

  const refs = JSON.parse(view.stdout) as {
    headRefName: string;
    baseRefName: string;
    isCrossRepository: boolean;
  };
  // A fork's branch is not ours to push to, and its manifests are not ours to trust.
  if (refs.isCrossRepository) return { kind: 'manual', reason: 'PR is from a fork' };

  const root = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'gh-prs-merge');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, `${parsed.slug.replace('/', '-')}-${parsed.number}-`));

  const git = (args: string[], cwd = dir) =>
    exec('git', ['-c', 'advice.mergeConflict=false', ...args], { env, cwd, timeoutMs: 600_000 });

  try {
    const clone = await exec(
      'gh',
      ['repo', 'clone', parsed.slug, dir, '--', '--filter=blob:none', '--branch', refs.headRefName],
      { env, timeoutMs: 600_000 },
    );
    if (clone.code !== 0) return { kind: 'manual', reason: `clone failed: ${tail(clone)}` };

    const head = await git(['rev-parse', 'HEAD']);
    if (head.stdout.trim() !== pr.headRefOid) {
      return { kind: 'manual', reason: 'head moved since it was judged' };
    }

    const fetch = await git(['fetch', '--quiet', 'origin', refs.baseRefName]);
    if (fetch.code !== 0) return { kind: 'manual', reason: `fetch failed: ${tail(fetch)}` };

    const message = `Merge ${refs.baseRefName} into ${refs.headRefName}`;
    const merge = await git(['merge', '--no-ff', '--no-commit', '-m', message, 'FETCH_HEAD']);

    const unmerged = await git(['diff', '--name-only', '--diff-filter=U']);
    const conflicted = unmerged.stdout.split('\n').filter(Boolean);

    if (merge.code !== 0 && conflicted.length === 0) {
      return { kind: 'manual', reason: `git merge failed: ${tail(merge)}` };
    }

    const other = conflicted.filter((f) => !isLockfile(f));
    if (other.length > 0) {
      return { kind: 'manual', reason: `conflicts outside lockfiles: ${other.join(', ')}` };
    }

    for (const file of conflicted) {
      // Merging base into head, "theirs" is the base: the lockfile main already
      // resolved, which the branch's own changes are then applied on top of.
      const take = await git(['checkout', '--theirs', '--', file]);
      if (take.code !== 0) return { kind: 'manual', reason: `checkout ${file}: ${tail(take)}` };

      const [bin, args] = LOCKFILES[basename(file)]!;
      const regen = await exec(bin, [...args], {
        env,
        cwd: join(dir, dirname(file)),
        timeoutMs: 600_000,
      });
      if (regen.code !== 0) {
        return { kind: 'manual', reason: `${bin} could not rebuild ${file}: ${tail(regen)}` };
      }

      const add = await git(['add', '--', file]);
      if (add.code !== 0) return { kind: 'manual', reason: `git add ${file}: ${tail(add)}` };
    }

    const body =
      conflicted.length > 0 ? `\n\nRegenerated ${conflicted.join(', ')} by gh-prs-merge --fix.` : '';
    const commit = await git(['commit', '--no-verify', '-m', `${message}${body}`]);
    if (commit.code !== 0) return { kind: 'manual', reason: `commit failed: ${tail(commit)}` };

    const push = await git(['push', '--quiet', 'origin', `HEAD:refs/heads/${refs.headRefName}`]);
    if (push.code !== 0) return { kind: 'manual', reason: `push refused: ${tail(push)}` };

    return { kind: 'resolved', files: conflicted };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
