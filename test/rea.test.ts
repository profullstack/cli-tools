import { describe, expect, it } from 'vitest';
import { BIN, PACKAGE, installPlan, meetsNodeRange, resolveRunner, vendorBin, vendorRoot } from '../src/rea.ts';

describe('rea prefix', () => {
  it('installs rea-agents but runs rea', () => {
    expect(PACKAGE).toBe('rea-agents');
    expect(BIN).toBe('rea');
    expect(vendorRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/cli-tools/vendor/rea');
    expect(vendorBin({ HOME: '/home/x' })).toBe('/home/x/.local/share/cli-tools/vendor/rea/node_modules/.bin/rea');
  });

  it('installs the latest release of the package, not of the bin name', () => {
    expect(installPlan('npm').args.at(-1)).toBe('rea-agents@latest');
    expect(installPlan('pnpm').args).toContain('--ignore-workspace');
  });
});

describe('meetsNodeRange (^22.23.4 || ^24.22.1 || >=26.12.1)', () => {
  it('accepts each range from its floor', () => {
    for (const v of ['v22.23.4', 'v22.30.0', 'v24.22.1', 'v24.40.0', 'v26.12.1', 'v27.0.0']) {
      expect(meetsNodeRange(v), v).toBe(true);
    }
  });

  it('rejects below each floor, and the odd majors upstream skips', () => {
    for (const v of ['v20.19.0', 'v22.23.3', 'v22.13.0', 'v23.11.0', 'v24.22.0', 'v25.9.0', 'v26.12.0']) {
      expect(meetsNodeRange(v), v).toBe(false);
    }
  });
});

describe('resolveRunner', () => {
  const none = { exists: () => false, onPathStatus: () => 'missing' as const, onPathTarget: () => null };

  it('prefers REA_BIN', () => {
    expect(resolveRunner({ ...none, env: { REA_BIN: '/opt/rea' } })).toEqual({ kind: 'env', file: '/opt/rea' });
  });

  it('then the private copy', () => {
    const env = { HOME: '/h' };
    expect(resolveRunner({ ...none, env, exists: (p) => p === vendorBin(env) })).toEqual({
      kind: 'vendor',
      file: vendorBin(env),
    });
  });

  it('then an upstream install on PATH, but never itself', () => {
    const env = { HOME: '/h' };
    expect(
      resolveRunner({ ...none, env, onPathStatus: () => 'other', onPathTarget: () => '/h/.local/bin/rea' }),
    ).toEqual({ kind: 'path', file: '/h/.local/bin/rea' });
    expect(resolveRunner({ ...none, env, onPathStatus: () => 'ours' })).toEqual({ kind: 'missing', file: null });
  });
});
