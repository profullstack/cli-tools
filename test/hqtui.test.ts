import { describe, expect, it } from 'vitest';
import {
  EXECUTABLE,
  MIN_NODE,
  PACKAGE,
  installPlan,
  managers,
  meetsNodeFloor,
  prepareVendorDir,
  resolveRunner,
  vendorBin,
  vendorRoot,
} from '../src/hqtui.ts';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('vendorRoot', () => {
  it('follows XDG_DATA_HOME when it is set', () => {
    expect(vendorRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/cli-tools/vendor/hqtui');
  });

  it('falls back to ~/.local/share', () => {
    expect(vendorRoot({ HOME: '/home/x' })).toBe('/home/x/.local/share/cli-tools/vendor/hqtui');
  });

  it('points at the executable the package installs, not at our own name', () => {
    // The package is @profullstack/hqtui-demo and its bin is hqtui-demo. Our
    // wrapper is `hqtui`, which is also the bin of the sibling library, so
    // getting this wrong is how the command ends up exec'ing itself.
    expect(vendorBin({ XDG_DATA_HOME: '/data' })).toBe(
      '/data/cli-tools/vendor/hqtui/node_modules/.bin/hqtui-demo',
    );
    expect(EXECUTABLE).toBe('hqtui-demo');
    expect(PACKAGE).toBe('@profullstack/hqtui-demo');
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
    expect(installPlan('npm', `${PACKAGE}@0.1.9`).args.at(-1)).toBe(`${PACKAGE}@0.1.9`);
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
    expect(meetsNodeFloor('v24.0.0')).toBe(true);
  });

  it('rejects older majors and minors', () => {
    expect(meetsNodeFloor('v20.19.0')).toBe(false);
    expect(meetsNodeFloor('v22.5.0')).toBe(false);
  });

  it('treats a prerelease as its release version', () => {
    expect(meetsNodeFloor('v23.0.0-nightly20240101')).toBe(true);
  });
});

describe('resolveRunner', () => {
  it('lets an explicit override win outright', () => {
    const runner = resolveRunner({ env: { HQTUI_BIN: '/opt/hqtui' }, exists: () => true });
    expect(runner).toEqual({ kind: 'env', file: '/opt/hqtui' });
  });

  it('prefers the vendored copy over anything on PATH', () => {
    const runner = resolveRunner({
      env: { XDG_DATA_HOME: '/data' },
      exists: (path) => path === '/data/cli-tools/vendor/hqtui/node_modules/.bin/hqtui-demo',
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/hqtui-demo',
    });
    expect(runner.kind).toBe('vendor');
  });

  it('uses a copy on PATH that is not ours', () => {
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/hqtui-demo',
    });
    expect(runner).toEqual({ kind: 'path', file: '/usr/bin/hqtui-demo' });
  });

  it('refuses to follow our own wrapper back to itself', () => {
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'ours',
      onPathTarget: () => '/home/x/.local/bin/hqtui',
    });
    expect(runner).toEqual({ kind: 'missing', file: null });
  });

  it('reports missing when there is nothing anywhere', () => {
    const runner = resolveRunner({ env: {}, exists: () => false, onPathStatus: () => 'missing' });
    expect(runner.kind).toBe('missing');
  });
});

describe('prepareVendorDir', () => {
  it('writes the manifest both package managers insist on', () => {
    const root = mkdtempSync(join(tmpdir(), 'hqtui-vendor-'));
    try {
      prepareVendorDir(root);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(manifest.private).toBe(true);
      expect(manifest.name).toContain('hqtui');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an existing manifest alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'hqtui-vendor-'));
    try {
      prepareVendorDir(root);
      const before = readFileSync(join(root, 'package.json'), 'utf8');
      prepareVendorDir(root);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
      expect(existsSync(join(root, 'package.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
