import { describe, expect, it } from 'vitest';

import { PIT_ALIASES, commands } from '../src/registry.ts';
import {
  type Plan,
  type Step,
  SysUpdateError,
  formatPlan,
  planSteps,
  runPlan,
} from '../src/sysupdate.ts';

/** Everything on the box, so the plan is about the flags and not the machine. */
const everything = () => true;
const nothing = () => false;
const only =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name);

/** The plan as plain command lines, which is what these tests are about. */
const lines = (plan: Plan): string[] =>
  plan.steps.map((step) => [step.file, ...step.args].join(' '));

describe('planSteps', () => {
  it('is the one-liner it replaces: lists, then packages, then snaps', () => {
    expect(lines(planSteps({ uid: 1000, has: everything }))).toEqual([
      'sudo apt update',
      'sudo apt upgrade',
      'sudo snap refresh',
    ]);
  });

  it('does not reach for sudo when it is already root', () => {
    // A minimal image may have no sudo at all, so asking for it there fails
    // for a reason that has nothing to do with updating anything.
    expect(lines(planSteps({ uid: 0, has: everything }))).toEqual([
      'apt update',
      'apt upgrade',
      'snap refresh',
    ]);
  });

  it('passes -y only where it means something', () => {
    // `apt update` has nothing to confirm; -y there is noise that suggests the
    // flag does more than it does.
    const plan = planSteps({ uid: 0, yes: true, has: everything });
    expect(lines(plan)).toEqual(['apt update', 'apt upgrade -y', 'snap refresh']);
  });

  it('skips snaps on a box with no snapd, and says why', () => {
    const plan = planSteps({ uid: 0, has: only('apt') });
    expect(lines(plan)).toEqual(['apt update', 'apt upgrade']);
    expect(plan.notes.join(' ')).toContain('no snapd');
  });

  it('skips snaps when asked, and says that too', () => {
    // A silent skip and a skip-because-absent look identical from outside,
    // and only one of them is something the caller chose.
    const plan = planSteps({ uid: 0, snap: false, has: everything });
    expect(lines(plan)).toEqual(['apt update', 'apt upgrade']);
    expect(plan.notes.join(' ')).toContain('--no-snap');
  });

  it('refuses a machine with no apt rather than half-running', () => {
    // Two of three steps on a box this was never meant for is worse than an
    // error: it looks like it worked.
    expect(() => planSteps({ uid: 0, has: nothing })).toThrow(SysUpdateError);
    expect(() => planSteps({ uid: 0, has: nothing })).toThrow(/apt/);
  });

  it('uses apt, not apt-get, and that is deliberate', () => {
    // They are different commands: apt installs a package that needs a new
    // dependency, apt-get holds it back. That is how security updates quietly
    // never land on a box somebody believes is current.
    const plan = planSteps({ uid: 0, has: everything });
    expect(plan.steps.every((step) => !step.args.includes('apt-get'))).toBe(true);
    expect(lines(plan)[0]).toBe('apt update');
  });
});

describe('formatPlan', () => {
  it('prints what would run, including the skips', () => {
    const text = formatPlan(planSteps({ uid: 1000, has: only('apt') }));
    expect(text).toContain('sudo apt update');
    expect(text).toContain('sudo apt upgrade');
    expect(text).toContain('(no snapd');
  });
});

describe('runPlan', () => {
  /** Records what was run and answers with the codes it was given. */
  function recorder(codes: number[]) {
    const ran: string[] = [];
    const spawner = async (file: string, args: readonly string[]): Promise<number> => {
      ran.push([file, ...args].join(' '));
      return codes[ran.length - 1] ?? 0;
    };
    return { ran, spawner };
  }

  const plan = (): Plan => planSteps({ uid: 0, has: everything });

  it('runs every step when each one succeeds', async () => {
    const { ran, spawner } = recorder([0, 0, 0]);
    const code = await runPlan(plan(), { spawner, write: () => {} });
    expect(code).toBe(0);
    expect(ran).toEqual(['apt update', 'apt upgrade', 'snap refresh']);
  });

  it('stops at the first failure, which is the && it replaces', async () => {
    // Upgrading against package lists that failed to refresh is pointless, and
    // a snap refresh afterwards only buries the real error up the scrollback.
    const { ran, spawner } = recorder([1]);
    const code = await runPlan(plan(), { spawner, write: () => {} });
    expect(code).toBe(1);
    expect(ran).toEqual(['apt update']);
  });

  it('hands back the failing exit status rather than a generic 1', async () => {
    const { spawner } = recorder([0, 100]);
    expect(await runPlan(plan(), { spawner, write: () => {} })).toBe(100);
  });

  it('says which step failed', async () => {
    let said = '';
    const { spawner } = recorder([0, 1]);
    await runPlan(plan(), { spawner, write: (text) => (said += text) });
    expect(said).toContain('upgrade the packages');
    expect(said).toContain('failed');
  });
});

describe('how it is wired into the command set', () => {
  it('is a real command, so it works from anywhere on PATH', () => {
    expect(commands().map((entry) => entry.name)).toContain('sysupdate');
  });

  it('is reachable from the pit as /update', () => {
    expect(PIT_ALIASES.update).toBe('sysupdate');
  });

  it('is not itself called update, because that word is taken', () => {
    // `cli-tools update` moves this checkout. One word cannot also mean
    // "upgrade the operating system" — whichever you meant, you get the other.
    expect(commands().map((entry) => entry.name)).not.toContain('update');
  });

  it('keeps the rule that no alias shares a name with a command', () => {
    // A shell function beats PATH, so an alias named after the file it wraps
    // silently shadows it and the two drift apart.
    const names = new Set(commands().map((entry) => entry.name));
    for (const alias of Object.keys(PIT_ALIASES)) {
      expect(names.has(alias), `/${alias} shadows the command ${alias}`).toBe(false);
    }
  });
});
