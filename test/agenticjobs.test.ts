import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXECUTABLE,
  INSTALL_WORDS,
  MIN_NODE,
  PACKAGE,
  installPlan,
  managers,
  meetsNodeFloor,
  ownsInstallWord,
  prepareVendorDir,
  removeVendor,
  resolveRunner,
  vendorBin,
  vendorRoot,
} from '../src/agenticjobs.ts';

describe('vendorRoot', () => {
  it('follows XDG_DATA_HOME when it is set', () => {
    expect(vendorRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/cli-tools/vendor/agenticjobs');
  });

  it('falls back to ~/.local/share', () => {
    expect(vendorRoot({ HOME: '/home/x' })).toBe(
      '/home/x/.local/share/cli-tools/vendor/agenticjobs',
    );
  });

  it('is not upstream’s own install directory', () => {
    // Upstream's curl installer owns ~/.local/share/agenticjobs and writes a
    // manifest there. Ours is a sibling under cli-tools/vendor, so the two
    // never manage each other's files.
    expect(vendorRoot({ HOME: '/home/x' })).not.toBe('/home/x/.local/share/agenticjobs');
  });
});

describe('vendorBin', () => {
  it('has the same name as this wrapper, which is the whole hazard', () => {
    // The package's bin is `agenticjobs` and so is our command. A global
    // install would put two of them on PATH and the winner would depend on
    // directory order; if ours won and we followed PATH we would exec
    // ourselves. The private prefix means the name exists exactly once.
    expect(EXECUTABLE).toBe('agenticjobs');
    expect(PACKAGE).toBe('@profullstack/agenticjobs');
    expect(vendorBin({ XDG_DATA_HOME: '/data' })).toBe(
      '/data/cli-tools/vendor/agenticjobs/node_modules/.bin/agenticjobs',
    );
  });
});

describe('installPlan', () => {
  it('keeps pnpm out of a workspace it happens to be standing in', () => {
    const plan = installPlan('pnpm');
    expect(plan.file).toBe('pnpm');
    expect(plan.args).toContain('--ignore-workspace');
    expect(plan.args.at(-1)).toBe(`${PACKAGE}@latest`);
  });

  it('installs a pinned spec when given one', () => {
    expect(installPlan('npm', `${PACKAGE}@0.5.0`).args.at(-1)).toBe(`${PACKAGE}@0.5.0`);
  });

  it('falls back to npm without pnpm flags', () => {
    const plan = installPlan('npm');
    expect(plan.file).toBe('npm');
    expect(plan.args).not.toContain('--ignore-workspace');
  });
});

describe('managers', () => {
  it('tries npm alone when pnpm is not on PATH', () => {
    expect(managers({ PATH: '/nowhere' })).toEqual(['npm']);
  });
});

describe('meetsNodeFloor', () => {
  it('accepts the floor itself and anything above it', () => {
    expect(meetsNodeFloor(MIN_NODE)).toBe(true);
    expect(meetsNodeFloor('v24.4.0')).toBe(true);
  });

  it('rejects the Node this repo itself floors at', () => {
    // The board wants 24 and cli-tools only promises 22.18, so a box that runs
    // every other command here can still be too old for this one. Checked
    // before spawning, because the failure otherwise names a file inside
    // node_modules and nothing that suggests the Node version.
    expect(meetsNodeFloor('v22.18.0')).toBe(false);
    expect(meetsNodeFloor('v20.19.0')).toBe(false);
  });

  it('treats a prerelease as its release version', () => {
    expect(meetsNodeFloor('v24.0.0-nightly20260101')).toBe(true);
  });
});

describe('resolveRunner', () => {
  it('lets an explicit override win outright', () => {
    const runner = resolveRunner({
      env: { AGENTICJOBS_BIN: '/opt/agenticjobs' },
      exists: () => true,
    });
    expect(runner).toEqual({ kind: 'env', file: '/opt/agenticjobs' });
  });

  it('prefers the vendored copy over anything on PATH', () => {
    const runner = resolveRunner({
      env: { XDG_DATA_HOME: '/data' },
      exists: (path) =>
        path === '/data/cli-tools/vendor/agenticjobs/node_modules/.bin/agenticjobs',
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/agenticjobs',
    });
    expect(runner.kind).toBe('vendor');
  });

  it('uses a copy on PATH that is not ours', () => {
    // Upstream's own installer, or a global npm install. A deliberate act, and
    // not ours to second-guess.
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'other',
      onPathTarget: () => '/home/x/.local/bin/agenticjobs',
    });
    expect(runner).toEqual({ kind: 'path', file: '/home/x/.local/bin/agenticjobs' });
  });

  it('refuses to follow our own wrapper back to itself', () => {
    // Both are called `agenticjobs`, so "is it on PATH" answers yes on every
    // box where this command is installed. Following that answer is a fork bomb.
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'ours',
      onPathTarget: () => '/home/x/.local/bin/agenticjobs',
    });
    expect(runner).toEqual({ kind: 'missing', file: null });
  });

  it('reports missing when there is nothing anywhere', () => {
    const runner = resolveRunner({ env: {}, exists: () => false, onPathStatus: () => 'missing' });
    expect(runner.kind).toBe('missing');
  });
});

describe('ownsInstallWord', () => {
  it('answers update, uninstall and where for the copy we installed', () => {
    // Upstream reads these from a manifest.json its curl installer writes. A
    // copy npm put in our prefix has none, so upstream would answer "not
    // installed by the installer" on a box where this command installed it.
    for (const word of INSTALL_WORDS) {
      expect(ownsInstallWord('vendor', word)).toBe(true);
      expect(ownsInstallWord('missing', word)).toBe(true);
    }
  });

  it('leaves them alone for a board installed some other way', () => {
    // A copy from upstream's installer HAS a manifest, and answering `update`
    // ourselves would leave that copy stale while updating a different one.
    for (const word of INSTALL_WORDS) {
      expect(ownsInstallWord('path', word)).toBe(false);
      expect(ownsInstallWord('env', word)).toBe(false);
    }
  });

  it('claims no other word, however install-shaped', () => {
    expect(ownsInstallWord('vendor', 'search')).toBe(false);
    expect(ownsInstallWord('vendor', 'serve')).toBe(false);
    expect(ownsInstallWord('vendor', 'migrate')).toBe(false);
    expect(ownsInstallWord('vendor', undefined)).toBe(false);
  });
});

describe('prepareVendorDir', () => {
  it('writes the manifest both package managers insist on', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenticjobs-vendor-'));
    try {
      prepareVendorDir(root);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.private).toBe(true);
      expect(manifest.name).toContain('agenticjobs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an existing manifest alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenticjobs-vendor-'));
    try {
      prepareVendorDir(root);
      const before = readFileSync(join(root, 'package.json'), 'utf8');
      writeFileSync(join(root, 'package.json'), before.replace('0.0.0', '9.9.9'));
      prepareVendorDir(root);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('9.9.9');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('removeVendor', () => {
  it('removes only the prefix this command owns', () => {
    const home = mkdtempSync(join(tmpdir(), 'agenticjobs-home-'));
    try {
      const env = { XDG_DATA_HOME: join(home, 'share') };
      const root = vendorRoot(env);
      prepareVendorDir(root);

      // Upstream's own install directory is a sibling, and stays.
      const theirs = join(home, 'share', 'agenticjobs');
      mkdirSync(theirs, { recursive: true });

      expect(removeVendor(env)).toBe(true);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(theirs)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so when there was nothing to remove', () => {
    expect(removeVendor({ XDG_DATA_HOME: join(tmpdir(), 'agenticjobs-not-here') })).toBe(false);
  });
});
