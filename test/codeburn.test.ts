import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIN_NODE,
  installPlan,
  managers,
  meetsNodeFloor,
  resolveRunner,
  vendorBin,
  vendorRoot,
} from '../src/codeburn.ts';

describe('vendorRoot', () => {
  it('follows XDG_DATA_HOME when it is set', () => {
    expect(vendorRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/cli-tools/vendor/codeburn');
  });

  it('falls back to ~/.local/share', () => {
    expect(vendorRoot({ HOME: '/home/x' })).toBe('/home/x/.local/share/cli-tools/vendor/codeburn');
  });

  it('puts the executable where a package manager leaves one', () => {
    expect(vendorBin({ XDG_DATA_HOME: '/data' })).toBe(
      '/data/cli-tools/vendor/codeburn/node_modules/.bin/codeburn',
    );
  });
});

describe('meetsNodeFloor', () => {
  it('compares numerically rather than as strings', () => {
    // '9' > '22' lexically, which is the bug this exists to not have.
    expect(meetsNodeFloor('v9.0.0')).toBe(false);
    expect(meetsNodeFloor('v22.13.0')).toBe(true);
    expect(meetsNodeFloor('v24.0.0')).toBe(true);
  });

  it('reads the patch level, because the floor has one', () => {
    expect(meetsNodeFloor('v22.12.0')).toBe(false);
    expect(meetsNodeFloor('v22.13.1')).toBe(true);
  });

  it('treats a prerelease as the version it is a prerelease of', () => {
    expect(meetsNodeFloor('v23.0.0-nightly20260101')).toBe(true);
    expect(meetsNodeFloor('v22.0.0-nightly20260101')).toBe(false);
  });

  it('agrees with the floor it publishes', () => {
    expect(meetsNodeFloor(MIN_NODE)).toBe(true);
  });
});

describe('installPlan', () => {
  /*
   * ~/.local/share is inside a home directory, and pnpm walks up looking for a
   * workspace root. One stray pnpm-workspace.yaml above the prefix and the
   * install lands somewhere else or is refused, so the flag is not optional.
   */
  it('keeps pnpm out of any workspace it might find above the prefix', () => {
    const plan = installPlan('pnpm');
    expect(plan.file).toBe('pnpm');
    expect(plan.args).toContain('--ignore-workspace');
    expect(plan.args).toContain('codeburn@latest');
  });

  it('gives npm the same job without its noise', () => {
    const plan = installPlan('npm');
    expect(plan.file).toBe('npm');
    expect(plan.args.slice(0, 1)).toEqual(['install']);
    expect(plan.args).toContain('codeburn@latest');
  });

  it('installs a version when it is given one', () => {
    expect(installPlan('pnpm', 'codeburn@0.9.20').args).toContain('codeburn@0.9.20');
  });
});

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function binDirWith(name?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codeburn-'));
  dirs.push(dir);
  if (name) {
    const file = join(dir, name);
    await writeFile(file, '#!/bin/sh\nexit 0\n');
    await chmod(file, 0o755);
  }
  return dir;
}

describe('managers', () => {
  it('prefers pnpm and keeps npm behind it', async () => {
    expect(managers({ PATH: await binDirWith('pnpm') })).toEqual(['pnpm', 'npm']);
  });

  /*
   * npm alone is a real configuration, not a degraded one: install.sh already
   * treats a box without pnpm as ordinary, and this has to agree with it.
   */
  it('is npm alone on a box with no pnpm', async () => {
    expect(managers({ PATH: await binDirWith() })).toEqual(['npm']);
  });
});

describe('resolveRunner', () => {
  const env = { XDG_DATA_HOME: '/data' };

  it('lets CODEBURN_BIN win outright', () => {
    const runner = resolveRunner({
      env: { ...env, CODEBURN_BIN: '/opt/codeburn' },
      exists: () => true,
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/codeburn',
    });
    expect(runner).toEqual({ kind: 'env', file: '/opt/codeburn' });
  });

  it('runs the copy it installed before anything on PATH', () => {
    const runner = resolveRunner({
      env,
      exists: (p) => p === '/data/cli-tools/vendor/codeburn/node_modules/.bin/codeburn',
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/codeburn',
    });
    expect(runner.kind).toBe('vendor');
  });

  it('uses somebody else’s install when there is one and ours is absent', () => {
    const runner = resolveRunner({
      env,
      exists: () => false,
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/codeburn',
    });
    expect(runner).toEqual({ kind: 'path', file: '/usr/bin/codeburn' });
  });

  /*
   * The one that matters.
   *
   * This wrapper is itself installed on PATH as `codeburn`, so "is codeburn on
   * PATH" is true on every box that has this repo — and spawning that answer
   * would have the command exec itself until the process table gives out.
   */
  it('never treats this wrapper as the thing it launches', () => {
    const runner = resolveRunner({
      env,
      exists: () => false,
      onPathStatus: () => 'ours',
      onPathTarget: () => '/home/x/.local/bin/codeburn',
    });
    expect(runner).toEqual({ kind: 'missing', file: null });
  });

  it('reports missing when nothing is installed anywhere', () => {
    const runner = resolveRunner({
      env,
      exists: () => false,
      onPathStatus: () => 'missing',
      onPathTarget: () => null,
    });
    expect(runner.kind).toBe('missing');
  });
});
