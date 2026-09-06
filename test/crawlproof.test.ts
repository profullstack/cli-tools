import { describe, expect, it } from 'vitest';
import {
  EXECUTABLE,
  MIN_NODE,
  PACKAGE,
  hasCoinpaySession,
  hasToken,
  installPlan,
  managers,
  meetsNodeFloor,
  prepareVendorDir,
  resolveRunner,
  vendorBin,
  vendorRoot,
  wantsSelfUpdate,
} from '../src/crawlproof.ts';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('vendorRoot', () => {
  it('follows XDG_DATA_HOME when it is set', () => {
    expect(vendorRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/cli-tools/vendor/crawlproof');
  });

  it('falls back to ~/.local/share', () => {
    expect(vendorRoot({ HOME: '/home/x' })).toBe('/home/x/.local/share/cli-tools/vendor/crawlproof');
  });

  it('installs into a private prefix, because the package owns our own name', () => {
    // Unlike hqtui, upstream's executable is called `crawlproof` and so is
    // this wrapper. A global install would put two of them on PATH.
    expect(vendorBin({ XDG_DATA_HOME: '/data' })).toBe(
      '/data/cli-tools/vendor/crawlproof/node_modules/.bin/crawlproof',
    );
    expect(EXECUTABLE).toBe('crawlproof');
    expect(PACKAGE).toBe('@profullstack/crawlproof');
  });
});

describe('installPlan', () => {
  it('keeps pnpm out of a workspace it happens to be standing in', () => {
    const plan = installPlan('pnpm');
    expect(plan.file).toBe('pnpm');
    expect(plan.args).toContain('--ignore-workspace');
    expect(plan.args.at(-1)).toBe(`${PACKAGE}@latest`);
  });

  it('installs a pinned spec when one is given', () => {
    expect(installPlan('npm', `${PACKAGE}@0.1.0`).args.at(-1)).toBe(`${PACKAGE}@0.1.0`);
  });
});

describe('managers', () => {
  it('is npm alone on a box without pnpm', () => {
    expect(managers({ PATH: '' })).toEqual(['npm']);
  });
});

describe('resolveRunner', () => {
  it('lets CRAWLPROOF_BIN win over everything', () => {
    const runner = resolveRunner({
      env: { CRAWLPROOF_BIN: '/opt/crawlproof' },
      exists: () => true,
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/crawlproof',
    });
    expect(runner).toEqual({ kind: 'env', file: '/opt/crawlproof' });
  });

  it('prefers the vendored copy to anything on PATH', () => {
    const runner = resolveRunner({
      env: { XDG_DATA_HOME: '/data' },
      exists: (p) => p === '/data/cli-tools/vendor/crawlproof/node_modules/.bin/crawlproof',
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/crawlproof',
    });
    expect(runner.kind).toBe('vendor');
  });

  it('follows a PATH copy that is somebody else', () => {
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'other',
      onPathTarget: () => '/usr/bin/crawlproof',
    });
    expect(runner).toEqual({ kind: 'path', file: '/usr/bin/crawlproof' });
  });

  it('refuses to follow itself, which would be an exec loop', () => {
    // The wrapper and the package share a name, so a PATH hit that resolves
    // into this repo's bin/ is this file.
    const runner = resolveRunner({
      env: {},
      exists: () => false,
      onPathStatus: () => 'ours',
      onPathTarget: () => '/home/x/.local/bin/crawlproof',
    });
    expect(runner).toEqual({ kind: 'missing', file: null });
  });
});

describe('prepareVendorDir', () => {
  it('writes the manifest both package managers insist on, once', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'cp-vendor-')), 'nested');
    try {
      prepareVendorDir(root);
      const manifest = join(root, 'package.json');
      expect(existsSync(manifest)).toBe(true);
      const first = readFileSync(manifest, 'utf8');
      expect(JSON.parse(first).private).toBe(true);

      prepareVendorDir(root);
      expect(readFileSync(manifest, 'utf8')).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('meetsNodeFloor', () => {
  it('accepts the floor and anything above it', () => {
    expect(meetsNodeFloor('22.6.0')).toBe(true);
    expect(meetsNodeFloor('v24.18.1')).toBe(true);
  });

  it('rejects anything below, including a same-major older minor', () => {
    expect(meetsNodeFloor('22.5.9')).toBe(false);
    expect(meetsNodeFloor('20.19.0')).toBe(false);
  });

  it('ignores prerelease and build suffixes', () => {
    expect(meetsNodeFloor('23.0.0-nightly')).toBe(true);
    expect(MIN_NODE).toBe('22.6.0');
  });
});

describe('the update verb', () => {
  it('claims the words that mean "install the latest"', () => {
    expect(wantsSelfUpdate(['update'])).toBe(true);
    expect(wantsSelfUpdate(['upgrade'])).toBe(true);
    expect(wantsSelfUpdate(['self-update'])).toBe(true);
  });

  it('leaves every other first word to the dashboard', () => {
    for (const word of ['dashboard', 'stats', 'ad', 'ads', 'help', 'version', '--json']) {
      expect(wantsSelfUpdate([word])).toBe(false);
    }
    expect(wantsSelfUpdate([])).toBe(false);
  });

  it('only claims it in first position, so a subcommand argument is safe', () => {
    // `crawlproof ads budget update` must reach upstream untouched.
    expect(wantsSelfUpdate(['ads', 'budget', 'update'])).toBe(false);
    expect(wantsSelfUpdate(['stats', 'update'])).toBe(false);
  });
});

describe('credential probes', () => {
  it('sees a token in the environment', () => {
    expect(hasToken({ CRAWLPROOF_TOKEN: 'crp_x' })).toBe(true);
  });

  it('sees a token in the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-cfg-'));
    const file = join(dir, 'crawlproof.json');
    writeFileSync(file, '{"token":"crp_x"}');
    try {
      expect(hasToken({ CRAWLPROOF_CONFIG: file })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no token rather than guessing one', () => {
    expect(hasToken({ HOME: join(tmpdir(), 'definitely-not-a-home') })).toBe(false);
  });

  it('reports the CoinPay session separately, since four screens work without it', () => {
    expect(hasCoinpaySession({ COINPAY_SESSION_TOKEN: 'jwt' })).toBe(true);
    expect(hasCoinpaySession({ HOME: join(tmpdir(), 'definitely-not-a-home') })).toBe(false);
  });
});
