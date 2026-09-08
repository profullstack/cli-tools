import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_INSTALLER,
  archiveUrl,
  COMPANIONS,
  core,
  ensure,
  findCompanion,
  forUpdate,
  groups,
  installCommand,
  select,
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
      'telnyx',
      'adb',
      'expo',
      'eas',
    ]);
  });

  it('gives every companion a summary and somewhere to read about it', () => {
    for (const companion of COMPANIONS) {
      expect(companion.summary.length, companion.name).toBeGreaterThan(0);
      expect(companion.home.startsWith('https://'), companion.name).toBe(true);
    }
  });

  it('names an npm companion by a package that exists, scoped or not', () => {
    // This used to insist on a scope, which held only while every npm
    // companion was ours or Bitwarden's. `expo` and `eas-cli` are neither, and
    // an unscoped name is not a malformed one -- so what is asserted now is
    // the thing that was actually meant: a package name, not a url or a path.
    for (const companion of COMPANIONS) {
      if (companion.install.kind !== 'npm') continue;
      expect(companion.install.package.length, companion.name).toBeGreaterThan(0);
      expect(companion.install.package.startsWith('http'), companion.name).toBe(false);
      if (companion.install.package.startsWith('@')) {
        expect(companion.install.package.includes('/'), companion.name).toBe(true);
      }
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
      ['telnyx', 'missing'],
      ['adb', 'missing'],
      ['expo', 'missing'],
      ['eas', 'missing'],
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
      onPath: present('timer', 'billing', 'bw', 'diskpush', 'myna', 'devdb', 'kali', 'telnyx'),
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
    const installed = new Set<string>(['timer', 'bw', 'diskpush', 'myna', 'devdb', 'kali', 'telnyx']);
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
      onPath: present('timer', 'billing', 'bw', 'diskpush', 'myna', 'devdb', 'kali', 'telnyx'),
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
      'npm install -g @telnyx/api-cli@latest',
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
    // The default set, not every companion: a caller that names no list gets
    // the ones that install on any box.
    expect(attempted).toHaveLength(core().length);
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

describe('the archive kind', () => {
  const adb = findCompanion('adb') as Companion;

  it('links the name it is checked by, first', () => {
    // `statuses` asks whether `adb` is on PATH; the archive is what puts it
    // there. If the first binary linked were not the companion's own name, an
    // install would report success for a command still missing.
    for (const companion of COMPANIONS) {
      if (companion.install.kind !== 'archive') continue;
      expect(companion.install.bins[0], companion.name).toBe(companion.name);
    }
  });

  it('has a build for the platforms this install can actually work on', () => {
    expect(archiveUrl(adb, 'linux')).toContain('platform-tools-latest-linux.zip');
    expect(archiveUrl(adb, 'darwin')).toContain('platform-tools-latest-darwin.zip');
    // Google publishes a Windows zip. This is symlinks into a vendor
    // directory, which is not how a command reaches PATH there, so the entry
    // is absent on purpose and the installer says so rather than half-working.
    expect(archiveUrl(adb, 'win32')).toBeNull();
  });

  it('answers null for a companion that is not an archive', () => {
    expect(archiveUrl(findCompanion('timer') as Companion, 'linux')).toBeNull();
  });

  it('runs our own installer, because there is no upstream one to run', () => {
    const command = installCommand(adb);
    expect(command.command).toBe('node');
    expect(command.args).toEqual([ARCHIVE_INSTALLER, 'adb']);
  });

  it('passes --force on an update, which is this kind of @latest', () => {
    expect(installCommand(adb, { latest: true }).args).toEqual([ARCHIVE_INSTALLER, 'adb', '--force']);
  });

  it('points at a script that is actually there', () => {
    // The path is resolved from companions.ts, so a rename of the script would
    // otherwise fail at install time on somebody's machine rather than here.
    expect(existsSync(ARCHIVE_INSTALLER)).toBe(true);
  });

  it('shows the download, with the platform left as <os>', () => {
    expect(source(adb)).toBe(
      'https://dl.google.com/android/repository/platform-tools-latest-<os>.zip',
    );
  });
});

describe('groups', () => {
  it('keeps the heavy set out of the default one', () => {
    // Expo and eas-cli are about half a gigabyte between them, and a web
    // server has no use for either. Installing them because someone ran the
    // installer is the surprise `diskpush --cli-only` exists to avoid.
    expect(groups()).toEqual(['mobile']);
    expect(core().map((c) => c.name)).not.toContain('expo');
    expect(COMPANIONS.filter((c) => c.group === 'mobile').map((c) => c.name)).toEqual([
      'adb',
      'expo',
      'eas',
    ]);
  });

  it('selects the default set when nothing is named', () => {
    expect(select([]).list).toEqual(core());
  });

  it('takes a group, a name, or everything', () => {
    expect(select(['mobile']).list.map((c) => c.name)).toEqual(['adb', 'expo', 'eas']);
    expect(select(['eas']).list.map((c) => c.name)).toEqual(['eas']);
    expect(select(['all']).list).toEqual([...COMPANIONS]);
  });

  it('is case-insensitive, and answers in list order however it was asked', () => {
    expect(select(['EAS', 'mobile']).list.map((c) => c.name)).toEqual(['adb', 'expo', 'eas']);
  });

  it('names what it did not recognise rather than installing nothing quietly', () => {
    // A typo would otherwise look exactly like a group whose members were all
    // already installed.
    const { list, unknown } = select(['mobil']);
    expect(list).toEqual([]);
    expect(unknown).toEqual(['mobil']);
  });

  it('updates what the box has, and never adopts what it does not', () => {
    // `cli-tools update` must not be how `eas` arrives on a machine.
    expect(forUpdate(present('adb')).map((c) => c.name)).toEqual([
      ...core().map((c) => c.name),
      'adb',
    ]);
    expect(forUpdate(nothing).map((c) => c.name)).toEqual(core().map((c) => c.name));
  });

  it('installs a whole group when asked for one', () => {
    const calls: string[] = [];
    ensure({
      onPath: nothing,
      run: ({ display }) => {
        calls.push(display);
        return { status: 0 };
      },
      list: select(['mobile']).list,
    });
    expect(calls).toEqual([
      `node ${ARCHIVE_INSTALLER} adb`,
      'npm install -g expo',
      'npm install -g eas-cli',
    ]);
  });
});
