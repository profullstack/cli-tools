import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXECUTABLE,
  PACKAGE,
  installFailureMessage,
  installPlan,
  managers,
  prepareVendorDir,
  resolveRunner,
  vendorBin,
  vendorRoot,
} from '../src/alchemy.ts';

describe('vendorRoot', () => {
  it('follows XDG_DATA_HOME when it is set', () => {
    expect(vendorRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/cli-tools/vendor/alchemy');
  });

  it('falls back to ~/.local/share', () => {
    expect(vendorRoot({ HOME: '/home/x' })).toBe('/home/x/.local/share/cli-tools/vendor/alchemy');
  });
});

describe('vendorBin', () => {
  it('has the same name as this wrapper, which is the whole hazard', () => {
    expect(EXECUTABLE).toBe('alchemy');
    expect(PACKAGE).toBe('@alchemy/cli');
    expect(vendorBin({ XDG_DATA_HOME: '/data' })).toBe(
      '/data/cli-tools/vendor/alchemy/node_modules/.bin/alchemy',
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
    expect(installPlan('npm', `${PACKAGE}@0.24.1`).args.at(-1)).toBe(`${PACKAGE}@0.24.1`);
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

describe('resolveRunner', () => {
  it('lets an explicit override win outright', () => {
    const runner = resolveRunner({ env: { ALCHEMY_BIN: '/opt/alchemy' }, exists: () => true });
    expect(runner).toEqual({ kind: 'env', file: '/opt/alchemy' });
  });

  it('prefers the vendored copy over anything on PATH', () => {
    const runner = resolveRunner({
      env: { XDG_DATA_HOME: '/data' },
      exists: (path) => path === '/data/cli-tools/vendor/alchemy/node_modules/.bin/alchemy',
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/alchemy',
    });
    expect(runner.kind).toBe('vendor');
  });

  it('uses a global install that is not ours', () => {
    // `moshcode install alchemy` runs `npm i -g @alchemy/cli`; that copy is
    // a deliberate act and works as well as ours would.
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'other',
      onPathTarget: () => '/home/x/.local/share/mise/installs/node/24/bin/alchemy',
    });
    expect(runner).toEqual({
      kind: 'path',
      file: '/home/x/.local/share/mise/installs/node/24/bin/alchemy',
    });
  });

  it('refuses to follow our own wrapper back to itself', () => {
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'ours',
      onPathTarget: () => '/home/x/.local/bin/alchemy',
    });
    expect(runner).toEqual({ kind: 'missing', file: null });
  });

  it('runs a shim by its PATH name, not its realpath', () => {
    // mise's shim for a global npm bin is a symlink to the mise binary, which
    // only dispatches to alchemy when invoked as `alchemy`.
    const root = mkdtempSync(join(tmpdir(), 'alchemy-shim-'));
    try {
      const manager = join(root, 'mise');
      writeFileSync(manager, '#!/bin/sh\n');
      chmodSync(manager, 0o755);
      symlinkSync(manager, join(root, 'alchemy'));
      const runner = resolveRunner({
        env: { PATH: root },
        exists: () => false,
        onPathStatus: () => 'other',
      });
      expect(runner).toEqual({ kind: 'path', file: join(root, 'alchemy') });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports missing when there is nothing anywhere', () => {
    const runner = resolveRunner({ env: {}, exists: () => false, onPathStatus: () => 'missing' });
    expect(runner.kind).toBe('missing');
  });
});

describe('messages', () => {
  it('name the package and the override', () => {
    const message = installFailureMessage('/x');
    expect(message).toContain(`npm install ${PACKAGE}@latest`);
    expect(message).toContain('ALCHEMY_BIN=');
  });
});

describe('prepareVendorDir', () => {
  it('writes the manifest both package managers insist on', () => {
    const root = mkdtempSync(join(tmpdir(), 'alchemy-vendor-'));
    try {
      const dir = join(root, 'vendor');
      prepareVendorDir(dir);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      expect(manifest.private).toBe(true);
      expect(manifest.name).toBe('cli-tools-vendor-alchemy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an existing manifest alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'alchemy-vendor-'));
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"kept"}\n');
      prepareVendorDir(root);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{"name":"kept"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
