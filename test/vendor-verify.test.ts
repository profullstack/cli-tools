import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  delivered,
  heldBackNote,
  installedVersion,
  pinnedVersion,
  registryLatest,
  wantedVersion,
} from '../src/vendor-verify.ts';

function prefixWith(pkg: string, version: string | null): string {
  const root = mkdtempSync(path.join(tmpdir(), 'vendor-verify-'));
  if (version !== null) {
    const dir = path.join(root, 'node_modules', ...pkg.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version }));
  }
  return root;
}

const fakeExec = (stdout: string, code = 0) =>
  (async () => ({ code, stdout, stderr: '' })) as never;

describe('installedVersion', () => {
  it('reads what is actually on disk', () => {
    const root = prefixWith('@profullstack/crawlproof', '0.1.0');
    try {
      expect(installedVersion(root, '@profullstack/crawlproof')).toBe('0.1.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is null when nothing is installed, rather than throwing', () => {
    const root = prefixWith('@profullstack/crawlproof', null);
    try {
      expect(installedVersion(root, '@profullstack/crawlproof')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pinnedVersion', () => {
  it('answers a spec that names a version', () => {
    expect(pinnedVersion('@profullstack/crawlproof@0.2.0')).toBe('0.2.0');
    expect(pinnedVersion('hqtui-demo@1.2.3')).toBe('1.2.3');
  });

  it('declines a tag or a range, so the registry is asked instead', () => {
    expect(pinnedVersion('@profullstack/crawlproof@latest')).toBeNull();
    expect(pinnedVersion('@profullstack/crawlproof@^0.1')).toBeNull();
    expect(pinnedVersion('@profullstack/crawlproof')).toBeNull();
  });
});

describe('registryLatest', () => {
  it('reads the version npm prints', async () => {
    expect(await registryLatest('pkg', fakeExec('0.2.0\n'))).toBe('0.2.0');
  });

  it('is null when npm fails, so an offline box is not told it is wrong', async () => {
    expect(await registryLatest('pkg', fakeExec('', 1))).toBeNull();
    expect(await registryLatest('pkg', fakeExec('not a version\n'))).toBeNull();
  });
});

describe('wantedVersion', () => {
  it('prefers the pin and never asks the registry for one', async () => {
    const boom = (async () => {
      throw new Error('should not be called');
    }) as never;
    expect(await wantedVersion('pkg@1.4.2', 'pkg', boom)).toBe('1.4.2');
  });

  it('asks the registry for a tag', async () => {
    expect(await wantedVersion('pkg@latest', 'pkg', fakeExec('9.9.9\n'))).toBe('9.9.9');
  });
});

describe('delivered', () => {
  // The whole point: pnpm 11 exits 0 having installed the previous release.
  it('rejects an install that left an older version behind', () => {
    expect(delivered('0.1.0', '0.2.0')).toBe(false);
  });

  it('accepts the version that was asked for', () => {
    expect(delivered('0.2.0', '0.2.0')).toBe(true);
  });

  it('accepts anything when the want could not be determined', () => {
    // An unreachable registry must not make a working reinstall look broken.
    expect(delivered('0.1.0', null)).toBe(true);
    expect(delivered(null, null)).toBe(true);
  });

  it('rejects an install that produced nothing at all', () => {
    expect(delivered(null, '0.2.0')).toBe(false);
  });
});

describe('heldBackNote', () => {
  it('names the version gap rather than saying it failed', () => {
    const note = heldBackNote('pnpm', '0.1.0', '0.2.0');
    expect(note).toContain('0.1.0');
    expect(note).toContain('0.2.0');
    expect(note).toContain('pnpm');
  });
});
