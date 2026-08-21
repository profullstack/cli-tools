import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INTERVAL_MS,
  SERVICE_NAME,
  decide,
  formatInterval,
  isDue,
  parseStatus,
  renderService,
  renderTimer,
} from '../src/selfupdate.ts';

const CLEAN = `# branch.oid abc123
# branch.head master
# branch.upstream origin/master
# branch.ab +0 -3
`;

describe('parseStatus', () => {
  // v2 rather than the human-readable "Your branch is behind by 3 commits",
  // which is localised — on a non-English machine that check never fires.
  it('reads branch, upstream and ahead/behind', () => {
    expect(parseStatus(CLEAN)).toEqual({
      head: 'master',
      upstream: 'origin/master',
      ahead: 0,
      behind: 3,
      dirty: false,
    });
  });

  it('treats any non-header line as a dirty tree', () => {
    expect(parseStatus(`${CLEAN}1 .M N... 100644 100644 100644 aaa bbb src/x.ts`).dirty).toBe(true);
    expect(parseStatus(`${CLEAN}? untracked.txt`).dirty).toBe(true);
  });

  it('reports a detached HEAD as no branch', () => {
    expect(parseStatus('# branch.head (detached)\n').head).toBeNull();
  });

  it('survives a status with no upstream', () => {
    const status = parseStatus('# branch.head master\n');
    expect(status.upstream).toBeNull();
    expect(status.behind).toBe(0);
  });
});

describe('decide', () => {
  const base = parseStatus(CLEAN);

  it('pulls a clean default branch that is behind', () => {
    expect(decide(base)).toEqual({
      action: 'pull',
      reason: '3 commit(s) behind origin/master',
    });
  });

  // The install is symlinks into a working tree, so an unattended pull moves
  // somebody's actual checkout. Each refusal names what is in the way.
  it('refuses a branch that is not the default one', () => {
    const decision = decide({ ...base, head: 'feature-x' });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toMatch(/on feature-x, not master/);
  });

  it('refuses a dirty tree', () => {
    expect(decide({ ...base, dirty: true }).reason).toMatch(/uncommitted changes/);
  });

  it('refuses when there are unpushed commits', () => {
    expect(decide({ ...base, ahead: 2 }).reason).toMatch(/2 commit\(s\) not pushed/);
  });

  it('refuses a detached HEAD', () => {
    expect(decide({ ...base, head: null }).reason).toMatch(/detached HEAD/);
  });

  it('does nothing when already current', () => {
    expect(decide({ ...base, behind: 0 })).toEqual({ action: 'skip', reason: 'already current' });
  });

  it('honours a different default branch', () => {
    expect(decide({ ...base, head: 'main' }, { defaultBranch: 'main' }).action).toBe('pull');
  });
});

describe('isDue', () => {
  it('is due when nothing has been recorded', () => {
    expect(isDue(null, 1_000)).toBe(true);
  });

  it('waits out the interval', () => {
    const now = DEFAULT_INTERVAL_MS * 2;
    expect(isDue(now - 1_000, now)).toBe(false);
    expect(isDue(now - DEFAULT_INTERVAL_MS, now)).toBe(true);
  });

  // A stamp in the future is a clock that moved; waiting it out could be days.
  it('is due when the stamp is in the future', () => {
    expect(isDue(5_000, 1_000)).toBe(true);
  });

  it('is due when the stamp is unreadable', () => {
    expect(isDue(Number.NaN, 1_000)).toBe(true);
  });
});

describe('renderService', () => {
  // A user unit starts with roughly /usr/bin:/bin, while node here is a version
  // manager's shim under $HOME. Without this the timer fires, fails to find
  // node, and the checkout silently never updates.
  it('bakes the PATH in when given one', () => {
    expect(renderService('/home/a/.local/bin/cli-tools', '/home/a/.local/share/mise/shims:/usr/bin'))
      .toContain('Environment=PATH=/home/a/.local/share/mise/shims:/usr/bin');
  });

  it('omits the line entirely when there is no PATH to carry', () => {
    expect(renderService('/x/cli-tools')).not.toContain('Environment=');
  });

  it('runs the unattended form', () => {
    expect(renderService('/x/cli-tools')).toContain('ExecStart=/x/cli-tools update --auto');
  });
});

describe('renderTimer', () => {
  it('catches up a machine that was asleep', () => {
    expect(renderTimer(86_400)).toContain('Persistent=true');
  });

  it('points at the service and installs into timers.target', () => {
    const timer = renderTimer(3_600);
    expect(timer).toContain(`Unit=${SERVICE_NAME}`);
    expect(timer).toContain('OnUnitActiveSec=3600sec');
    expect(timer).toContain('WantedBy=timers.target');
  });
});

describe('formatInterval', () => {
  it('picks the largest whole unit', () => {
    expect(formatInterval(86_400)).toBe('1d');
    expect(formatInterval(3_600)).toBe('1h');
    expect(formatInterval(1_800)).toBe('30min');
    expect(formatInterval(45)).toBe('45s');
  });
});
