import { describe, expect, it } from 'vitest';
import type { RunResult } from '../src/exec.ts';
import type { PullRequest } from '../src/gh.ts';
import {
  isLockfile,
  resolveLockfileConflicts,
  resolveVersionConflict,
} from '../src/lockfile-conflicts.ts';

/** package.json after `git merge main` into a branch: ours is the head, theirs the base. */
const conflict = (head: string, base: string, diff3 = false) =>
  [
    '{',
    '  "name": "nixamp",',
    '<<<<<<< HEAD',
    `  "version": "${head}",`,
    ...(diff3 ? ['||||||| abc123', '  "version": "0.52.1",'] : []),
    '=======',
    `  "version": "${base}",`,
    '>>>>>>> FETCH_HEAD',
    '  "type": "module"',
    '}',
    '',
  ].join('\n');

describe('version-line conflict resolution', () => {
  it('bumps the base patch when the head is behind it', () => {
    expect(resolveVersionConflict(conflict('0.52.2', '0.53.3'))).toBe(
      '{\n  "name": "nixamp",\n  "version": "0.53.4",\n  "type": "module"\n}\n',
    );
  });

  it('keeps the head version when it is already ahead', () => {
    expect(resolveVersionConflict(conflict('1.0.0', '0.53.3'))).toContain('"version": "1.0.0",');
  });

  it('bumps rather than ties when both sides picked the same next version', () => {
    expect(resolveVersionConflict(conflict('0.53.4', '0.53.4'))).toContain('"version": "0.53.5",');
  });

  it('reads diff3 markers', () => {
    expect(resolveVersionConflict(conflict('0.52.2', '0.53.3', true))).toContain(
      '"version": "0.53.4",',
    );
  });

  it('refuses anything that is not one version line a side', () => {
    expect(resolveVersionConflict(conflict('0.52.2-beta.1', '0.53.3'))).toBeNull();
    expect(
      resolveVersionConflict(conflict('0.52.2', '0.53.3').replace('=======', '  "private": true,\n=======')),
    ).toBeNull();
    expect(resolveVersionConflict('{"version": "1.0.0"}\n')).toBeNull();
  });
});

const pr: PullRequest = {
  url: 'https://github.com/acme/repo/pull/7',
  title: 't',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  headRefOid: 'deadbeef',
};

/** A scripted gh/git/bun; `conflicted` is what `git diff --diff-filter=U` reports. */
function stubExec(options: {
  conflicted: string[];
  fork?: boolean;
  head?: string;
  pushFails?: boolean;
}) {
  const calls: string[] = [];
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const exec = async (file: string, args: readonly string[]): Promise<RunResult> => {
    const argv = args.filter((a, i) => !(a === '-c' || args[i - 1] === '-c'));
    calls.push(`${file} ${argv.join(' ')}`);
    if (file === 'gh' && argv[0] === 'pr') {
      return ok(
        JSON.stringify({
          headRefName: 'feat',
          baseRefName: 'main',
          isCrossRepository: !!options.fork,
        }),
      );
    }
    if (file === 'git' && argv[0] === 'rev-parse') return ok(`${options.head ?? 'deadbeef'}\n`);
    if (file === 'git' && argv[0] === 'merge') {
      return options.conflicted.length ? { code: 1, stdout: 'CONFLICT', stderr: '' } : ok();
    }
    if (file === 'git' && argv[0] === 'diff') return ok(options.conflicted.join('\n'));
    if (file === 'git' && argv[0] === 'push' && options.pushFails) {
      return { code: 1, stdout: '', stderr: '! [rejected] (fetch first)' };
    }
    return ok();
  };
  return { exec, calls };
}

describe('lockfile conflict resolution', () => {
  it('recognises lockfiles anywhere in the tree, and nothing else', () => {
    expect(isLockfile('bun.lock')).toBe(true);
    expect(isLockfile('apps/web/pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('yarn.lock')).toBe(false);
    expect(isLockfile('package.json')).toBe(false);
  });

  it('takes the base lockfile, rebuilds it lockfile-only, and pushes without force', async () => {
    const { exec, calls } = stubExec({ conflicted: ['bun.lock'] });
    const outcome = await resolveLockfileConflicts(pr, exec);

    expect(outcome).toEqual({ kind: 'resolved', files: ['bun.lock'] });
    expect(calls).toContain('git checkout --theirs -- bun.lock');
    expect(calls).toContain('bun install --lockfile-only --ignore-scripts');
    const push = calls.find((c) => c.startsWith('git push'))!;
    expect(push).toContain('HEAD:refs/heads/feat');
    expect(push).not.toMatch(/--force|\+HEAD/);
  });

  it('declines when a code file conflicts too, before rebuilding anything', async () => {
    const { exec, calls } = stubExec({ conflicted: ['bun.lock', 'src/index.ts'] });
    const outcome = await resolveLockfileConflicts(pr, exec);

    expect(outcome).toEqual({
      kind: 'manual',
      reason: 'conflicts outside lockfiles: src/index.ts',
    });
    expect(calls.some((c) => c.startsWith('bun '))).toBe(false);
    expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('never touches a fork', async () => {
    const { exec, calls } = stubExec({ conflicted: ['bun.lock'], fork: true });
    expect(await resolveLockfileConflicts(pr, exec)).toEqual({
      kind: 'manual',
      reason: 'PR is from a fork',
    });
    expect(calls.some((c) => c.includes('clone'))).toBe(false);
  });

  it('declines when the head moved after the PR was judged', async () => {
    const { exec, calls } = stubExec({ conflicted: ['bun.lock'], head: 'cafe' });
    const outcome = await resolveLockfileConflicts(pr, exec);
    expect(outcome.kind).toBe('manual');
    expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('resolves a version-only package.json before rebuilding the lockfile', async () => {
    const { exec, calls } = stubExec({ conflicted: ['package.json', 'bun.lock'] });
    const written: Record<string, string> = {};
    const fs = {
      read: async () => conflict('0.52.2', '0.53.3'),
      write: async (path: string, text: string) => {
        written[path] = text;
        calls.push(`write ${path.split('/').pop()}`);
      },
    };
    const outcome = await resolveLockfileConflicts(pr, exec, fs);

    expect(outcome).toEqual({ kind: 'resolved', files: ['package.json', 'bun.lock'] });
    expect(Object.values(written)[0]).toContain('"version": "0.53.4",');
    expect(calls.indexOf('write package.json')).toBeLessThan(
      calls.indexOf('bun install --lockfile-only --ignore-scripts'),
    );
  });

  it('declines a package.json conflict that is more than the version', async () => {
    const { exec, calls } = stubExec({ conflicted: ['package.json'] });
    const fs = {
      read: async () => conflict('0.52.2', '0.53.3').replace('"version": "0.52.2",', '"version": "0.52.2",\n  "private": true,'),
      write: async () => {},
    };
    expect(await resolveLockfileConflicts(pr, exec, fs)).toEqual({
      kind: 'manual',
      reason: 'package.json conflicts beyond its version line',
    });
    expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('reports a refused push instead of claiming the repair', async () => {
    const { exec } = stubExec({ conflicted: ['bun.lock'], pushFails: true });
    const outcome = await resolveLockfileConflicts(pr, exec);
    expect(outcome.kind).toBe('manual');
    expect(outcome.kind === 'manual' && outcome.reason).toContain('push refused');
  });
});
