import { describe, expect, it } from 'vitest';

import {
  COMPANIONS,
  ensure,
  findCompanion,
  installCommand,
  source,
  statuses,
  type Companion,
} from '../src/companions.ts';

const present = (...names: string[]) => (name: string) =>
  names.includes(name) ? `/usr/local/bin/${name}` : null;
const nothing = () => null;

describe('the companion list', () => {
  it('names the commands that come from elsewhere', () => {
    expect(COMPANIONS.map((c) => c.name)).toEqual([
      'timer',
      'billing',
      'bw',
      'diskpush',
      'myna',
      'devdb',
      'kali',
    ]);
  });

  it('gives every companion a summary and somewhere to read about it', () => {
    for (const companion of COMPANIONS) {
      expect(companion.summary.length, companion.name).toBeGreaterThan(0);
      expect(companion.home.startsWith('https://'), companion.name).toBe(true);
    }
  });

  it('names an npm companion by a scoped package', () => {
    for (const companion of COMPANIONS) {
      if (companion.install.kind !== 'npm') continue;
      expect(companion.install.package.startsWith('@'), companion.name).toBe(true);
      expect(companion.install.package.includes('/'), companion.name).toBe(true);
    }
  });

  it('states the binary name, because it is not derivable from the package', () => {
    // `@bitwarden/cli` installs `bw`. That is why `name` is a field rather than
    // something parsed off the end of the package -- an assumption that held
    // only while every companion happened to be one of ours.
    expect(findCompanion('bw')!.install).toMatchObject({ package: '@bitwarden/cli' });
  });

  it('gives a script companion an https installer', () => {
    for (const companion of COMPANIONS) {
      if (companion.install.kind !== 'script') continue;
      expect(companion.install.url.startsWith('https://'), companion.name).toBe(true);
    }
  });

  it('names a go companion by its module path, not a url', () => {
    // `go install` takes a module path. A https:// url is the thing that looks
    // right and does not work, so the shape is asserted rather than assumed.
    for (const companion of COMPANIONS) {
      if (companion.install.kind !== 'go') continue;
      expect(companion.install.module.startsWith('https://'), companion.name).toBe(false);
      expect(companion.install.module.includes('/'), companion.name).toBe(true);
    }
  });

  it('resolves a companion by name, case-insensitively', () => {
    expect(source(findCompanion('timer')!)).toBe('@profullstack/timer');
    expect(source(findCompanion('BILLING')!)).toBe('@profullstack/billing');
    expect(source(findCompanion('BW')!)).toBe('@bitwarden/cli');
    expect(source(findCompanion('DiskPush')!)).toBe('https://diskpush.com/install.sh');
    expect(source(findCompanion('MYNA')!)).toBe('https://mynaposter.com/install.sh');
    expect(source(findCompanion('DevDB')!)).toBe('github.com/terrablue/devdb');
    expect(findCompanion('nonsense')).toBeNull();
    expect(findCompanion('')).toBeNull();
  });
});

describe('installCommand', () => {
  const timer = findCompanion('timer') as Companion;
  const diskpush = findCompanion('diskpush') as Companion;
  const devdb = findCompanion('devdb') as Companion;

  it('installs an npm companion globally', () => {
    expect(installCommand(timer)).toMatchObject({
      command: 'npm',
      args: ['install', '-g', '@profullstack/timer'],
    });
  });

  it('names @latest on an update, because a bare install would be a no-op', () => {
    // `npm install -g <pkg>` leaves an already-satisfied version alone, so
    // without the tag `cli-tools update` would silently never move them.
    expect(installCommand(timer, { latest: true }).args).toEqual([
      'install',
      '-g',
      '@profullstack/timer@latest',
    ]);
  });

  it('pipes a script companion into sh, the way its project documents it', () => {
    const command = installCommand(diskpush);
    expect(command.command).toBe('sh');
    expect(command.args[0]).toBe('-c');
    expect(command.args[1]).toBe('curl -fsSL https://diskpush.com/install.sh | sh -s -- --cli-only');
  });

  it('installs the CLI only, so a server does not get a desktop app', () => {
    // The installer would otherwise place ~100MB of Electron wherever it finds
    // a desktop session, which is not what a command-line toolbelt asked for.
    expect(installCommand(diskpush).display).toContain('--cli-only');
  });

  it('adds nothing for a script companion on update: its installer upgrades in place', () => {
    expect(installCommand(diskpush, { latest: true })).toEqual(installCommand(diskpush));
  });

  it('installs a go companion by module path at @latest', () => {
    expect(installCommand(devdb)).toMatchObject({
      command: 'go',
      args: ['install', 'github.com/terrablue/devdb@latest'],
    });
  });

  it('carries @latest on a go install always, because it is the only spelling', () => {
    // Unlike npm, where the tag is what makes an update mean update, module-aware
    // `go install` refuses a bare module path outright. So install and update are
    // the same command here, and a bare one would be an error rather than a no-op.
    expect(installCommand(devdb, { latest: true })).toEqual(installCommand(devdb));
    expect(installCommand(devdb).display).toBe('go install github.com/terrablue/devdb@latest');
  });

  it('shows the command a person would run', () => {
    expect(installCommand(timer).display).toBe('npm install -g @profullstack/timer');
    expect(installCommand(diskpush).display.startsWith('curl -fsSL ')).toBe(true);
  });
});

describe('statuses', () => {
  it('reports what is on PATH and where', () => {
    const rows = statuses(present('timer'));
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['timer', 'installed'],
      ['billing', 'missing'],
      ['bw', 'missing'],
      ['diskpush', 'missing'],
      ['myna', 'missing'],
      ['devdb', 'missing'],
      ['kali', 'missing'],
    ]);
    expect(rows[0]?.path).toBe('/usr/local/bin/timer');
    expect(rows[1]?.path).toBeNull();
  });
});

describe('ensure', () => {
  it('leaves an installed companion alone', () => {
    // It may be a newer version, a local build, or a fork somebody is testing.
    // Reinstalling over it is the surprise `link` refuses for symlinks.
    const calls: string[] = [];
    const results = ensure({
      onPath: present('timer', 'billing', 'bw', 'diskpush', 'myna', 'devdb', 'kali'),
      run: ({ display }) => {
        calls.push(display);
        return { status: 0 };
      },
    });
    expect(calls).toEqual([]);
    expect(results.every((r) => r.action === 'present')).toBe(true);
  });

  it('installs only what is missing', () => {
    const calls: string[] = [];
    const installed = new Set<string>(['timer', 'bw', 'diskpush', 'myna', 'devdb', 'kali']);
    ensure({
      onPath: (name) => (installed.has(name) ? `/usr/local/bin/${name}` : null),
      run: ({ display }) => {
        calls.push(display);
        installed.add('billing');
        return { status: 0 };
      },
    });
    expect(calls).toEqual(['npm install -g @profullstack/billing']);
  });

  it('reinstalls everything at @latest when asked', () => {
    const calls: string[] = [];
    ensure({
      onPath: present('timer', 'billing', 'bw', 'diskpush', 'myna', 'devdb', 'kali'),
      run: ({ display }) => {
        calls.push(display);
        return { status: 0 };
      },
      latest: true,
    });
    expect(calls).toEqual([
      'npm install -g @profullstack/timer@latest',
      'npm install -g @profullstack/billing@latest',
      'npm install -g @bitwarden/cli@latest',
      // A script installer upgrades in place, so there is no @latest to add.
      'curl -fsSL https://diskpush.com/install.sh | sh -s -- --cli-only',
      'curl -fsSL https://mynaposter.com/install.sh | sh',
      // Same reason, one step further: `go install` has no bare form to add to.
      'go install github.com/terrablue/devdb@latest',
      'npm install -g @profullstack/kali@latest',
    ]);
  });

  it('keeps going after a failure, and says which package and why', () => {
    // npm fails for ordinary reasons — no npm, a read-only prefix, no network —
    // and none of them are a reason for the rest of `cli-tools link` to stop.
    const attempted: string[] = [];
    const results = ensure({
      onPath: nothing,
      run: ({ display }) => {
        attempted.push(display);
        return { status: 1, stderr: 'npm ERR! code EACCES\nnpm ERR! permission denied' };
      },
    });
    expect(attempted).toHaveLength(COMPANIONS.length);
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
