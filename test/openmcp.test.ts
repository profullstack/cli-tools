import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXECUTABLE,
  INSTALL_WORDS,
  MIN_NODE,
  PACKAGE,
  installFailureMessage,
  installPlan,
  managers,
  meetsNodeFloor,
  nodeFloorMessage,
  ownsInstallWord,
  prepareVendorDir,
  removeVendor,
  resolveRunner,
  vendorBin,
  vendorRoot,
} from '../src/openmcp.ts';

describe('vendorRoot', () => {
  it('follows XDG_DATA_HOME when it is set', () => {
    expect(vendorRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/cli-tools/vendor/openmcp');
  });

  it('falls back to ~/.local/share', () => {
    expect(vendorRoot({ HOME: '/home/x' })).toBe('/home/x/.local/share/cli-tools/vendor/openmcp');
  });

  it('is not upstream’s own install directory', () => {
    // Upstream's curl installer owns ~/.local/share/openmcp and writes a
    // manifest (and possibly a private Node) there. Ours is a sibling under
    // cli-tools/vendor, so the two never manage each other's files.
    expect(vendorRoot({ HOME: '/home/x' })).not.toBe('/home/x/.local/share/openmcp');
  });
});

describe('vendorBin', () => {
  it('has the same name as this wrapper, which is the whole hazard', () => {
    expect(EXECUTABLE).toBe('openmcp');
    expect(PACKAGE).toBe('@logicsrc/openmcp');
    expect(vendorBin({ XDG_DATA_HOME: '/data' })).toBe(
      '/data/cli-tools/vendor/openmcp/node_modules/.bin/openmcp',
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
    expect(installPlan('npm', `${PACKAGE}@0.3.0`).args.at(-1)).toBe(`${PACKAGE}@0.3.0`);
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
    expect(meetsNodeFloor('v24.18.1')).toBe(true);
  });

  it('rejects the Node this repo itself floors at', () => {
    // node:sqlite is Node 24; on 22 the failure is a missing built-in module.
    expect(meetsNodeFloor('v22.18.0')).toBe(false);
    expect(meetsNodeFloor('v20.19.0')).toBe(false);
  });

  it('treats a prerelease as its release version', () => {
    expect(meetsNodeFloor('v24.0.0-nightly20260101')).toBe(true);
  });
});

describe('resolveRunner', () => {
  it('lets an explicit override win outright', () => {
    const runner = resolveRunner({ env: { OPENMCP_BIN: '/opt/openmcp' }, exists: () => true });
    expect(runner).toEqual({ kind: 'env', file: '/opt/openmcp' });
  });

  it('prefers the vendored copy over anything on PATH', () => {
    const runner = resolveRunner({
      env: { XDG_DATA_HOME: '/data' },
      exists: (path) => path === '/data/cli-tools/vendor/openmcp/node_modules/.bin/openmcp',
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/openmcp',
    });
    expect(runner.kind).toBe('vendor');
  });

  it('uses a copy on PATH that is not ours', () => {
    // Upstream's curl installer writes a real script to ~/.local/bin/openmcp.
    // A deliberate act, and not ours to second-guess.
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'other',
      onPathTarget: () => '/home/x/.local/bin/openmcp',
    });
    expect(runner).toEqual({ kind: 'path', file: '/home/x/.local/bin/openmcp' });
  });

  it('refuses to follow our own wrapper back to itself', () => {
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'ours',
      onPathTarget: () => '/home/x/.local/bin/openmcp',
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
    for (const word of INSTALL_WORDS) {
      expect(ownsInstallWord('vendor', word)).toBe(true);
      expect(ownsInstallWord('missing', word)).toBe(true);
    }
  });

  it('leaves them alone for a copy installed some other way', () => {
    // A copy from upstream's installer HAS a manifest, and answering `update`
    // ourselves would leave that copy stale while updating a different one.
    for (const word of INSTALL_WORDS) {
      expect(ownsInstallWord('path', word)).toBe(false);
      expect(ownsInstallWord('env', word)).toBe(false);
    }
  });

  it('claims no other word, however install-shaped', () => {
    expect(ownsInstallWord('vendor', 'relays')).toBe(false);
    expect(ownsInstallWord('vendor', 'serve')).toBe(false);
    expect(ownsInstallWord('vendor', 'refresh')).toBe(false);
    expect(ownsInstallWord('vendor', undefined)).toBe(false);
  });
});

describe('messages', () => {
  it('offer upstream’s one-line installer as the way out', () => {
    expect(installFailureMessage('/x')).toContain('curl -fsSL https://openmcp.logicsrc.com/install.sh | sh');
    expect(nodeFloorMessage('v22.18.0')).toContain('curl -fsSL https://openmcp.logicsrc.com/install.sh | sh');
    expect(nodeFloorMessage('v22.18.0')).toContain(MIN_NODE);
  });
});

describe('prepareVendorDir', () => {
  it('writes the manifest both package managers insist on', () => {
    const root = mkdtempSync(join(tmpdir(), 'openmcp-vendor-'));
    try {
      prepareVendorDir(root);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.private).toBe(true);
      expect(manifest.name).toContain('openmcp');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an existing manifest alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'openmcp-vendor-'));
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
    const home = mkdtempSync(join(tmpdir(), 'openmcp-home-'));
    try {
      const env = { XDG_DATA_HOME: join(home, 'share') };
      const root = vendorRoot(env);
      prepareVendorDir(root);

      // Upstream's own install directory is a sibling, and stays.
      const theirs = join(home, 'share', 'openmcp');
      mkdirSync(theirs, { recursive: true });

      expect(removeVendor(env)).toBe(true);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(theirs)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so when there was nothing to remove', () => {
    expect(removeVendor({ XDG_DATA_HOME: join(tmpdir(), 'openmcp-not-here') })).toBe(false);
  });
});
