import { describe, expect, it } from 'vitest';
import {
  Gh,
  parseChecks,
  parseMergeAsync,
  parsePullRequest,
  parsePullRequestUrl,
  GhError,
} from '../src/gh.ts';
import type { RunResult } from '../src/exec.ts';
import {
  defaults,
  isRepairable,
  isUpdatable,
  reasonNotMergeable,
  render,
  sweep,
  type Line,
  type MergeOptions,
} from '../src/prs-merge.ts';

const PR_URL = 'https://github.com/acme/repo/pull/1';

interface StubStep {
  mergeable?: string;
  mergeStateStatus?: string;
  isDraft?: boolean;
  state?: string;
  checks?: { name: string; bucket: string }[];
}

/**
 * A scripted `gh`.
 *
 * Each PR read and check read advances through `steps`, so a test can say "the
 * first look sees a pending suite, the second sees it green" — which is the
 * behaviour --fix exists for and the one a single-shot stub cannot express.
 */
function stubGh(options: {
  steps: StubStep[];
  updateBranchFails?: boolean;
  mergeFails?: boolean;
  /** Refuse `pr merge` the way GitHub refuses a PR that is part of a stack. */
  stacked?: boolean;
  /** How many polls the asynchronous merge takes before it reports merged. */
  asyncPolls?: number;
}) {
  const calls: string[] = [];
  let viewIndex = 0;
  let checkIndex = 0;
  let asyncPolls = options.asyncPolls ?? 0;

  const step = (index: number): StubStep =>
    options.steps[Math.min(index, options.steps.length - 1)]!;

  const exec = async (_file: string, args: readonly string[]): Promise<RunResult> => {
    calls.push(args.join(' '));
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });

    if (args[0] === 'search') {
      return ok(JSON.stringify([{ url: PR_URL, createdAt: '2026-01-01T00:00:00Z' }]));
    }

    if (args[0] === 'pr' && args[1] === 'view') {
      const current = step(viewIndex);
      viewIndex += 1;
      return ok(
        JSON.stringify({
          url: PR_URL,
          title: 'stub pr',
          state: current.state ?? 'OPEN',
          isDraft: current.isDraft ?? false,
          mergeable: current.mergeable ?? 'MERGEABLE',
          mergeStateStatus: current.mergeStateStatus ?? 'CLEAN',
          headRefOid: 'deadbeef',
        }),
      );
    }

    if (args[0] === 'pr' && args[1] === 'checks') {
      const current = step(checkIndex);
      checkIndex += 1;
      const checks = current.checks ?? [{ name: 'test', bucket: 'pass' }];
      // gh exits non-zero while still printing JSON when anything is pending.
      return {
        code: checks.some((c) => c.bucket !== 'pass') ? 1 : 0,
        stdout: JSON.stringify(checks),
        stderr: '',
      };
    }

    if (args[0] === 'pr' && args[1] === 'update-branch') {
      return options.updateBranchFails
        ? { code: 1, stdout: '', stderr: 'X Cannot update PR branch due to conflicts' }
        : ok('Updated branch');
    }

    if (args[0] === 'pr' && args[1] === 'merge') {
      if (options.stacked) {
        return {
          code: 1,
          stdout: '',
          stderr:
            'GraphQL: This pull request is part of a stack and must be merged ' +
            'using the asynchronous merge REST API. (mergePullRequest)',
        };
      }
      return options.mergeFails
        ? { code: 1, stdout: '', stderr: 'refused' }
        : ok('Merged');
    }

    // The asynchronous merge endpoint: the PUT enqueues, each GET polls.
    if (args[0] === 'api' && args.some((a) => a.includes('merge-async'))) {
      if (asyncPolls > 0) {
        asyncPolls -= 1;
        return ok(JSON.stringify({ status: 'pending', details: { uuid: 'u-1' } }));
      }
      return ok(JSON.stringify({ status: 'merged', details: { sha: 'cafe' } }));
    }

    if (args[0] === 'pr' && args[1] === 'ready') return ok('');

    return ok('');
  };

  return { gh: new Gh({ exec }), calls };
}

/**
 * A scripted `gh` serving several PRs at once.
 *
 * `stubGh` answers for exactly one URL, which cannot express the thing the
 * second pass exists for: whether a PR whose checks are still running holds up
 * the PRs behind it.
 */
function stubFleet(prs: { url: string; createdAt: string; steps: StubStep[] }[]) {
  const calls: string[] = [];
  const cursors = new Map<string, { view: number; check: number }>();

  const find = (args: readonly string[]) => {
    const url = args.find((a) => a.includes('/pull/'));
    const entry = prs.find((p) => p.url === url);
    if (!entry) throw new Error(`stubFleet: no PR for ${String(url)}`);
    const cursor = cursors.get(entry.url) ?? { view: 0, check: 0 };
    cursors.set(entry.url, cursor);
    return { entry, cursor };
  };

  const at = (entry: { steps: StubStep[] }, index: number): StubStep =>
    entry.steps[Math.min(index, entry.steps.length - 1)]!;

  const exec = async (_file: string, args: readonly string[]): Promise<RunResult> => {
    calls.push(args.join(' '));
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });

    if (args[0] === 'search') {
      return ok(JSON.stringify(prs.map((p) => ({ url: p.url, createdAt: p.createdAt }))));
    }

    if (args[0] === 'pr' && args[1] === 'view') {
      const { entry, cursor } = find(args);
      const current = at(entry, cursor.view);
      cursor.view += 1;
      return ok(
        JSON.stringify({
          url: entry.url,
          title: `stub ${entry.url}`,
          state: current.state ?? 'OPEN',
          isDraft: current.isDraft ?? false,
          mergeable: current.mergeable ?? 'MERGEABLE',
          mergeStateStatus: current.mergeStateStatus ?? 'CLEAN',
          headRefOid: 'deadbeef',
        }),
      );
    }

    if (args[0] === 'pr' && args[1] === 'checks') {
      const { entry, cursor } = find(args);
      const current = at(entry, cursor.check);
      cursor.check += 1;
      const checks = current.checks ?? [{ name: 'test', bucket: 'pass' }];
      return {
        code: checks.some((c) => c.bucket !== 'pass') ? 1 : 0,
        stdout: JSON.stringify(checks),
        stderr: '',
      };
    }

    if (args[0] === 'pr' && args[1] === 'update-branch') return ok('Updated branch');
    if (args[0] === 'pr' && args[1] === 'merge') return ok('Merged');
    if (args[0] === 'pr' && args[1] === 'ready') return ok('');

    return ok('');
  };

  return { gh: new Gh({ exec }), calls };
}

function baseOptions(overrides: Partial<MergeOptions> = {}): MergeOptions {
  return {
    orgs: ['acme'],
    users: [],
    limit: 10,
    apply: true,
    allowNoChecks: false,
    readyDrafts: true,
    fix: false,
    fixWaitMs: 1_000,
    pollMs: 1,
    ...overrides,
  };
}

async function runSweep(gh: Gh, options: MergeOptions) {
  const lines: Line[] = [];
  const summary = await sweep(options, gh, (line) => lines.push(line));
  return { summary, lines, text: lines.map(render).join('\n') };
}

describe('eligibility rules', () => {
  const pr = {
    url: PR_URL,
    title: 't',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: 'abc',
  } as const;

  it('accepts an open, clean PR with green checks', () => {
    expect(reasonNotMergeable(pr, [{ name: 'test', bucket: 'pass' }], false)).toBe('');
  });

  it('names the specific blocker', () => {
    expect(reasonNotMergeable({ ...pr, state: 'CLOSED' }, [], false)).toBe('state=CLOSED');
    expect(reasonNotMergeable({ ...pr, isDraft: true }, [], false)).toBe('draft');
    expect(reasonNotMergeable({ ...pr, mergeable: 'CONFLICTING' }, [], false)).toBe(
      'mergeable=CONFLICTING',
    );
    expect(reasonNotMergeable({ ...pr, mergeStateStatus: 'BLOCKED' }, [], true)).toBe(
      'mergeStateStatus=BLOCKED',
    );
    expect(reasonNotMergeable(pr, [], false)).toBe('no CI checks found');
    expect(reasonNotMergeable(pr, [{ name: 'test', bucket: 'fail' }], false)).toBe(
      'checks not green: test=fail',
    );
  });

  it('treats skipping as acceptable but pending as not', () => {
    expect(reasonNotMergeable(pr, [{ name: 'a', bucket: 'skipping' }], false)).toBe('');
    expect(reasonNotMergeable(pr, [{ name: 'a', bucket: 'pending' }], false)).toContain(
      'a=pending',
    );
  });

  it('only calls mechanical blockers repairable', () => {
    expect(isRepairable(pr, [{ name: 'a', bucket: 'pending' }])).toBe(true);
    expect(isRepairable({ ...pr, mergeStateStatus: 'BEHIND' }, [])).toBe(true);
    expect(isRepairable({ ...pr, mergeable: 'CONFLICTING' }, [])).toBe(true);
    // A check that ran and failed is a result, not an obstacle.
    expect(isRepairable(pr, [{ name: 'a', bucket: 'fail' }])).toBe(false);
  });

  it('merges UNSTABLE when the checks it can read are green', () => {
    // UNSTABLE is "mergeable, some non-required context is not green". GitHub
    // takes the merge; demanding CLEAN skipped ready PRs for nothing.
    const unstable = { ...pr, mergeStateStatus: 'UNSTABLE' } as const;
    expect(reasonNotMergeable(unstable, [{ name: 'test', bucket: 'pass' }], false)).toBe('');
    expect(reasonNotMergeable({ ...pr, mergeStateStatus: 'HAS_HOOKS' }, [
      { name: 'test', bucket: 'pass' },
    ], false)).toBe('');

    // But it is only trustworthy because the checks were read. With none to
    // read, nothing corroborates it.
    expect(reasonNotMergeable(unstable, [], true)).toContain('no checks to confirm it');
  });

  it('names the red check rather than the aggregate it explains', () => {
    // Both are unhappy at once; "socket=fail" is the sentence worth printing.
    expect(
      reasonNotMergeable({ ...pr, mergeStateStatus: 'UNSTABLE' }, [
        { name: 'socket', bucket: 'fail' },
      ], false),
    ).toBe('checks not green: socket=fail');
  });

  it('will not ask update-branch to merge over a settled conflict', () => {
    // DIRTY is GitHub having already decided the two sides conflict. The call
    // can only come back "Cannot update PR branch due to conflicts".
    expect(isUpdatable({ ...pr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toBe(false);
    expect(isRepairable({ ...pr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, [])).toBe(
      false,
    );
    expect(isUpdatable({ ...pr, mergeStateStatus: 'BEHIND' })).toBe(true);
  });
});

describe('gh response validation', () => {
  it('names the offending field rather than yielding a null string', () => {
    // `jq -r '.mergeable'` printed the four characters "null" here, which is
    // not MERGEABLE, so the PR read as ineligible for a reason nobody wrote.
    expect(() => parsePullRequest({ url: 'u', title: 't', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', headRefOid: 'a' }))
      .toThrow(/mergeable/);
  });

  it('rejects a bucket it does not know instead of silently passing it', () => {
    expect(() => parseChecks([{ name: 'a', bucket: 'sideways' }])).toThrow(/bucket/);
  });

  it('accepts the documented shapes', () => {
    expect(parseChecks([{ name: 'a', bucket: 'pass' }])).toEqual([
      { name: 'a', bucket: 'pass' },
    ]);
  });

  it('reports non-JSON output as such', async () => {
    const gh = new Gh({
      exec: async () => ({ code: 0, stdout: 'gh: not logged in', stderr: '' }),
    });
    await expect(gh.pullRequest(PR_URL, { attempts: 1 })).rejects.toBeInstanceOf(GhError);
  });
});

describe('sweep', () => {
  it('merges an eligible PR, pinned to the head it judged', async () => {
    const { gh, calls } = stubGh({ steps: [{}] });
    const { summary, text } = await runSweep(gh, baseOptions());

    expect(summary.merged).toBe(1);
    expect(text).toContain('MERGED');
    expect(calls.some((c) => c.includes('--match-head-commit deadbeef'))).toBe(true);
    // Protections stay enforced.
    expect(calls.some((c) => c.includes('--admin'))).toBe(false);
  });

  it('merges nothing in a dry run', async () => {
    const { gh, calls } = stubGh({ steps: [{}] });
    const { summary } = await runSweep(gh, baseOptions({ apply: false }));

    expect(summary.ready).toBe(1);
    expect(summary.merged).toBe(0);
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  it('skips a conflicting PR untouched when --fix is off', async () => {
    const { gh, calls } = stubGh({
      steps: [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }],
    });
    const { summary, text } = await runSweep(gh, baseOptions());

    expect(summary.skipped).toBe(1);
    expect(text).toContain('mergeable=CONFLICTING');
    expect(calls.some((c) => c.startsWith('pr update-branch'))).toBe(false);
  });

  it('repairs a BEHIND branch and then merges it', async () => {
    const { gh, calls } = stubGh({
      steps: [{ mergeStateStatus: 'BEHIND' }, { mergeStateStatus: 'CLEAN' }],
    });
    const { summary, text } = await runSweep(gh, baseOptions({ fix: true }));

    expect(text).toContain('FIXING');
    expect(summary.fixed).toBe(1);
    expect(summary.merged).toBe(1);
    expect(calls.some((c) => c.startsWith('pr update-branch'))).toBe(true);
  });

  it('reports a settled conflict once, without asking GitHub to merge over it', async () => {
    const { gh, calls } = stubGh({
      steps: [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }],
      updateBranchFails: true,
    });
    const { summary, lines, text } = await runSweep(gh, baseOptions({ fix: true }));

    expect(text).toContain('FIXME');
    expect(text).toContain('mergeable=CONFLICTING');
    expect(text).toContain('needs resolving by hand');
    expect(summary.merged).toBe(0);
    expect(summary.skipped).toBe(1);
    // Repair did not succeed, so it is not counted as one.
    expect(summary.fixed).toBe(0);
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);

    // The wasted round trip is gone, and so is the SKIP line that used to
    // repeat the FIXME immediately underneath it.
    expect(calls.some((c) => c.startsWith('pr update-branch'))).toBe(false);
    expect(lines.filter((l) => l.kind === 'skip')).toHaveLength(0);
  });

  it('merges a PR GitHub calls UNSTABLE when every check is green', async () => {
    // The false skip this sweep kept producing: MERGEABLE, two green checks,
    // and an aggregate state that only meant a non-required context was not.
    const { gh, calls } = stubGh({
      steps: [
        {
          mergeStateStatus: 'UNSTABLE',
          checks: [
            { name: 'test', bucket: 'pass' },
            { name: 'lint', bucket: 'pass' },
          ],
        },
      ],
    });
    const { summary, text } = await runSweep(gh, baseOptions());

    expect(summary.merged).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(text).not.toContain('mergeStateStatus=UNSTABLE');
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(true);
  });

  it('waits for a running check, then merges once it goes green', async () => {
    // The false skip that motivated --fix: nothing was wrong with the PR, the
    // sweep simply looked before Socket had reported.
    const { gh } = stubGh({
      steps: [
        { mergeStateStatus: 'UNSTABLE', checks: [{ name: 'socket', bucket: 'pending' }] },
        { mergeStateStatus: 'CLEAN', checks: [{ name: 'socket', bucket: 'pass' }] },
      ],
    });
    const { summary, text } = await runSweep(gh, baseOptions({ fix: true }));

    expect(text).toContain('checks still running');
    expect(summary.merged).toBe(1);
  });

  it('merges the rest of the sweep instead of queueing behind a running suite', async () => {
    // The sweep used to stand in front of the first unfinished PR for the
    // whole of --fix-wait. Every PR after it was ready and waited anyway.
    const slow = 'https://github.com/acme/repo/pull/1';
    const quick = 'https://github.com/acme/repo/pull/2';

    const { gh, calls } = stubFleet([
      {
        url: slow,
        createdAt: '2026-01-01T00:00:00Z',
        steps: [
          { mergeStateStatus: 'UNSTABLE', checks: [{ name: 'test', bucket: 'pending' }] },
          { mergeStateStatus: 'CLEAN', checks: [{ name: 'test', bucket: 'pass' }] },
        ],
      },
      { url: quick, createdAt: '2026-01-02T00:00:00Z', steps: [{}] },
    ]);

    const { summary, text } = await runSweep(gh, baseOptions({ fix: true }));

    expect(summary.merged).toBe(2);
    expect(text).toContain('parked for the second pass');

    const mergeOrder = calls.filter((c) => c.startsWith('pr merge'));
    expect(mergeOrder).toHaveLength(2);
    // The ready PR goes first even though the slow one was swept first.
    expect(mergeOrder[0]).toContain(quick);
    expect(mergeOrder[1]).toContain(slow);
  });

  it('spends --fix-wait on the parked queue as a whole, not per PR', async () => {
    // Two PRs, both stuck pending, one second of budget between them. Serially
    // this was two full waits; the deadline is shared, so it is one.
    const { gh } = stubFleet([
      {
        url: 'https://github.com/acme/repo/pull/1',
        createdAt: '2026-01-01T00:00:00Z',
        steps: [{ mergeStateStatus: 'UNSTABLE', checks: [{ name: 'a', bucket: 'pending' }] }],
      },
      {
        url: 'https://github.com/acme/repo/pull/2',
        createdAt: '2026-01-02T00:00:00Z',
        steps: [{ mergeStateStatus: 'UNSTABLE', checks: [{ name: 'b', bucket: 'pending' }] }],
      },
    ]);

    const started = Date.now();
    const { summary, text } = await runSweep(
      gh,
      baseOptions({ fix: true, fixWaitMs: 60, pollMs: 10 }),
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect(summary.skipped).toBe(2);
    expect(text).toContain('checks still running after');
  });

  it('gives up waiting at --fix-wait rather than hanging', async () => {
    const { gh } = stubGh({
      steps: [{ mergeStateStatus: 'UNSTABLE', checks: [{ name: 'x', bucket: 'pending' }] }],
    });
    const { summary } = await runSweep(gh, baseOptions({ fix: true, fixWaitMs: 0, pollMs: 1 }));

    expect(summary.merged).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('counts a refused merge as failed, not skipped', async () => {
    const { gh } = stubGh({ steps: [{}], mergeFails: true });
    const { summary } = await runSweep(gh, baseOptions());

    expect(summary.failed).toBe(1);
    expect(summary.merged).toBe(0);
  });

  it('merges a stacked PR through the asynchronous merge endpoint', async () => {
    const { gh, calls } = stubGh({ steps: [{}], stacked: true });
    const { summary } = await runSweep(gh, baseOptions());

    expect(summary.merged).toBe(1);
    expect(summary.failed).toBe(0);
    expect(calls.some((c) => c.includes('merge-async'))).toBe(true);
  });

  it('pins the head commit on the asynchronous merge too', async () => {
    const { gh, calls } = stubGh({ steps: [{}], stacked: true });
    await runSweep(gh, baseOptions());

    const put = calls.find((c) => c.startsWith('api --method PUT'));
    expect(put).toContain('sha=deadbeef');
    expect(put).toContain('merge_method=squash');
    // Still no admin override on this path.
    expect(calls.some((c) => c.includes('--admin'))).toBe(false);
  });

  it('marks a draft ready, then judges it normally', async () => {
    const { gh, calls } = stubGh({ steps: [{ isDraft: true }, { isDraft: false }] });
    const { summary } = await runSweep(gh, baseOptions());

    expect(calls.some((c) => c.startsWith('pr ready'))).toBe(true);
    expect(summary.readied).toBe(1);
    expect(summary.merged).toBe(1);
  });

  it('reports a draft without touching it in a dry run', async () => {
    const { gh, calls } = stubGh({ steps: [{ isDraft: true }] });
    const { summary, text } = await runSweep(gh, baseOptions({ apply: false }));

    expect(text).toContain('WOULD-READY');
    expect(calls.some((c) => c.startsWith('pr ready'))).toBe(false);
    expect(summary.skipped).toBe(1);
  });

  it('carries on when one scope is inaccessible', async () => {
    const gh = new Gh({
      exec: async (_f, args) =>
        args[0] === 'search'
          ? { code: 1, stdout: '', stderr: 'not found' }
          : { code: 0, stdout: '[]', stderr: '' },
    });
    const { summary, text } = await runSweep(gh, baseOptions({ orgs: ['nope'] }));

    expect(text).toContain('skipped inaccessible or invalid scope');
    expect(summary.failed).toBe(0);
  });
});

describe('defaults', () => {
  it('waits ten minutes and polls every twenty seconds', () => {
    expect(defaults.fixWaitMs).toBe(600_000);
    expect(defaults.pollMs).toBe(20_000);
  });
});

describe('asynchronous merge', () => {
  const PR = 'https://github.com/acme/repo/pull/7';

  /** A `gh` that refuses the mutation, then answers the REST endpoint. */
  function stubAsync(replies: string[], { refuse = true } = {}) {
    const calls: string[] = [];
    let index = 0;

    const exec = async (_f: string, args: readonly string[]): Promise<RunResult> => {
      calls.push(args.join(' '));

      if (args[0] === 'pr' && args[1] === 'merge') {
        return refuse
          ? {
              code: 1,
              stdout: '',
              stderr: 'must be merged using the asynchronous merge REST API. (mergePullRequest)',
            }
          : { code: 0, stdout: 'Merged', stderr: '' };
      }

      const reply = replies[Math.min(index, replies.length - 1)]!;
      index += 1;
      return { code: 0, stdout: reply, stderr: '' };
    };

    return { gh: new Gh({ exec }), calls };
  }

  it('polls the uuid until the merge settles', async () => {
    const { gh, calls } = stubAsync([
      JSON.stringify({ status: 'pending', details: { uuid: 'u-1' } }),
      JSON.stringify({ status: 'pending', details: { uuid: 'u-1' } }),
      JSON.stringify({ status: 'merged', details: { sha: 'cafe' } }),
    ]);

    const result = await gh.squashMerge(PR, 'deadbeef', { pollMs: 1 });

    expect(result.code).toBe(0);
    expect(calls.filter((c) => c.startsWith('api repos/acme/repo/pulls/7/merge-async/u-1')))
      .toHaveLength(2);
  });

  it('treats enqueued as merged, because a merge queue owns it from there', async () => {
    const { gh } = stubAsync([JSON.stringify({ status: 'enqueued', details: { uuid: 'u-1' } })]);
    const result = await gh.squashMerge(PR, 'deadbeef', { pollMs: 1 });

    expect(result.code).toBe(0);
  });

  it('reports a failed asynchronous merge with the reason GitHub gave', async () => {
    const { gh } = stubAsync([
      JSON.stringify({ status: 'failed', details: { message: 'head moved' } }),
    ]);
    const result = await gh.squashMerge(PR, 'deadbeef', { pollMs: 1 });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('head moved');
  });

  it('gives up rather than polling forever', async () => {
    const { gh } = stubAsync([JSON.stringify({ status: 'pending', details: { uuid: 'u-1' } })]);
    const result = await gh.squashMerge(PR, 'deadbeef', { pollMs: 1, attempts: 3 });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('never settled');
  });

  it('does not reach for the endpoint when the refusal is a different one', async () => {
    const calls: string[] = [];
    const gh = new Gh({
      exec: async (_f, args) => {
        calls.push(args.join(' '));
        return { code: 1, stdout: '', stderr: 'Pull request is not mergeable' };
      },
    });

    const result = await gh.squashMerge(PR, 'deadbeef', { pollMs: 1 });

    expect(result.code).toBe(1);
    expect(calls.some((c) => c.includes('merge-async'))).toBe(false);
  });

  it('never merges twice when the mutation already worked', async () => {
    const { gh, calls } = stubAsync([], { refuse: false });
    const result = await gh.squashMerge(PR, 'deadbeef', { pollMs: 1 });

    expect(result.code).toBe(0);
    expect(calls.some((c) => c.includes('merge-async'))).toBe(false);
  });
});

describe('parsePullRequestUrl', () => {
  it('reads owner, repo and number', () => {
    expect(parsePullRequestUrl('https://github.com/acme/repo/pull/7')).toEqual({
      slug: 'acme/repo',
      number: '7',
    });
  });

  it('returns nothing for something that is not a PR url', () => {
    expect(parsePullRequestUrl('https://example.com/acme/repo')).toBeUndefined();
  });
});

describe('parseMergeAsync', () => {
  it('lifts status, uuid and message out of the reply', () => {
    expect(
      parseMergeAsync(JSON.stringify({ status: 'failed', details: { message: 'no' } })),
    ).toEqual({ status: 'failed', uuid: undefined, message: 'no' });
  });

  it('returns nothing rather than inventing a status', () => {
    expect(parseMergeAsync('not json')).toBeUndefined();
  });
});
