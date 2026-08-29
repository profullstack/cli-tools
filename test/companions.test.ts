import { describe, expect, it } from 'vitest';

import {
  COMPANIONS,
  ensure,
  findCompanion,
  installArgs,
  statuses,
  type Companion,
} from '../src/companions.ts';

const present = (...names: string[]) => (name: string) =>
  names.includes(name) ? `/usr/local/bin/${name}` : null;
const nothing = () => null;

describe('the companion list', () => {
  it('names the timer and billing packages', () => {
    expect(COMPANIONS.map((c) => c.name)).toEqual(['timer', 'billing']);
    expect(COMPANIONS.map((c) => c.package)).toEqual([
      '@profullstack/timer',
      '@profullstack/billing',
    ]);
  });

  it('gives every companion a scoped package and a summary', () => {
    for (const companion of COMPANIONS) {
      expect(companion.package.startsWith('@profullstack/'), companion.name).toBe(true);
      expect(companion.summary.length, companion.name).toBeGreaterThan(0);
      // The binary name is not derivable from the package name in general, so
      // it is stated; this holds it to the one case we actually ship.
      expect(companion.package.endsWith(`/${companion.name}`), companion.name).toBe(true);
    }
  });

  it('resolves a companion by name, case-insensitively', () => {
    expect(findCompanion('timer')?.package).toBe('@profullstack/timer');
    expect(findCompanion('BILLING')?.package).toBe('@profullstack/billing');
    expect(findCompanion('nonsense')).toBeNull();
    expect(findCompanion('')).toBeNull();
  });
});

describe('installArgs', () => {
  const timer = COMPANIONS[0] as Companion;

  it('installs the package globally', () => {
    expect(installArgs(timer)).toEqual(['install', '-g', '@profullstack/timer']);
  });

  it('names @latest on an update, because a bare install would be a no-op', () => {
    // `npm install -g <pkg>` leaves an already-satisfied version alone, so
    // without the tag `cli-tools update` would silently never move them.
    expect(installArgs(timer, { latest: true })).toEqual([
      'install',
      '-g',
      '@profullstack/timer@latest',
    ]);
  });
});

describe('statuses', () => {
  it('reports what is on PATH and where', () => {
    const rows = statuses(present('timer'));
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['timer', 'installed'],
      ['billing', 'missing'],
    ]);
    expect(rows[0]?.path).toBe('/usr/local/bin/timer');
    expect(rows[1]?.path).toBeNull();
  });
});

describe('ensure', () => {
  it('leaves an installed companion alone', () => {
    // It may be a newer version, a local build, or a fork somebody is testing.
    // Reinstalling over it is the surprise `link` refuses for symlinks.
    const calls: string[][] = [];
    const results = ensure({
      onPath: present('timer', 'billing'),
      run: (args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(calls).toEqual([]);
    expect(results.every((r) => r.action === 'present')).toBe(true);
  });

  it('installs only what is missing', () => {
    const calls: string[][] = [];
    const installed = new Set<string>(['timer']);
    ensure({
      onPath: (name) => (installed.has(name) ? `/usr/local/bin/${name}` : null),
      run: (args) => {
        calls.push(args);
        installed.add('billing');
        return { status: 0 };
      },
    });
    expect(calls).toEqual([['install', '-g', '@profullstack/billing']]);
  });

  it('reinstalls everything at @latest when asked', () => {
    const calls: string[][] = [];
    ensure({
      onPath: present('timer', 'billing'),
      run: (args) => {
        calls.push(args);
        return { status: 0 };
      },
      latest: true,
    });
    expect(calls).toEqual([
      ['install', '-g', '@profullstack/timer@latest'],
      ['install', '-g', '@profullstack/billing@latest'],
    ]);
  });

  it('keeps going after a failure, and says which package and why', () => {
    // npm fails for ordinary reasons — no npm, a read-only prefix, no network —
    // and none of them are a reason for the rest of `cli-tools link` to stop.
    const attempted: string[][] = [];
    const results = ensure({
      onPath: nothing,
      run: (args) => {
        attempted.push(args);
        return { status: 1, stderr: 'npm ERR! code EACCES\nnpm ERR! permission denied' };
      },
    });
    expect(attempted).toHaveLength(2);
    expect(results.every((r) => r.action === 'failed')).toBe(true);
    expect(results[0]?.message).toBe('npm ERR! permission denied');
    expect(results[0]?.state).toBe('missing');
  });

  it('does not call a zero exit a success when the binary is still not on PATH', () => {
    // npm can install into a prefix that is not on PATH and exit 0. Reporting
    // that as installed sends someone to a command they cannot run.
    const results = ensure({
      onPath: nothing,
      run: () => ({ status: 0 }),
    });
    expect(results[0]?.action).toBe('installed');
    expect(results[0]?.state).toBe('missing');
    expect(results[0]?.message).toMatch(/not on PATH/);
  });

  it('reports a missing npm as a failure rather than throwing', () => {
    const results = ensure({
      onPath: nothing,
      run: () => ({ status: 1, stderr: 'npm is not available: spawnSync npm ENOENT' }),
    });
    expect(results[0]?.action).toBe('failed');
    expect(results[0]?.message).toMatch(/npm is not available/);
  });
});
