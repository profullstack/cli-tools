import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { keyVariable, loadStored, saveStored } from '../src/credentials.ts';
import { PROVIDERS } from '@profullstack/proxy';
import { hasProxyLogin, proxyEnv, PROXY_VARIABLES } from '../src/proxy.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sandbox(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-'));
  dirs.push(dir);
  return { XDG_CONFIG_HOME: dir, ...extra } as NodeJS.ProcessEnv;
}

const neverPull = () => {
  throw new Error('should not pull');
};

describe('proxy keys', () => {
  it('are config-settable by friendly name', () => {
    expect(keyVariable('proxiware')).toBe('PROXIWARE_API_KEY');
    expect(keyVariable('proxiware_proxy_user')).toBe('PROXIWARE_PROXY_USER');
    expect(keyVariable('proxiware-proxy-password')).toBe('PROXIWARE_PROXY_PASSWORD');
    expect(keyVariable('webshare')).toBe('WEBSHARE_API_KEY');
    expect(keyVariable('WEBSHARE_PROXY_PASSWORD')).toBe('WEBSHARE_PROXY_PASSWORD');
  });

  it('hasProxyLogin wants a full login, or a Webshare API key', () => {
    expect(hasProxyLogin({})).toBe(false);
    expect(hasProxyLogin({ PROXIWARE_PROXY_USER: 'u' })).toBe(false);
    expect(hasProxyLogin({ PROXIWARE_PROXY_USER: 'u', PROXIWARE_PROXY_PASSWORD: 'p' })).toBe(true);
    expect(hasProxyLogin({ WEBSHARE_API_KEY: 'k' })).toBe(true);
    expect(hasProxyLogin({ PROXIWARE_API_KEY: 'k' })).toBe(false);
    expect(hasProxyLogin({ HPROXY_API_KEY: 'hpx_k' })).toBe(true);
    expect(hasProxyLogin({ HPROXY_PROXY_USER: 'u' })).toBe(false);
    expect(hasProxyLogin({ HPROXY_PROXY_USER: 'u', HPROXY_PROXY_PASSWORD: 'p' })).toBe(true);
  });

  it('take the HProxy keys from a vault pull, and nothing else', async () => {
    const env = await sandbox();
    const pulled = { HPROXY_API_KEY: 'hpx_k', HPROXY_PLAN_ID: 'plan1', UNRELATED_SECRET: 'x' };
    const result = proxyEnv({ env, pull: () => pulled });
    expect(result.source).toBe('vault');
    expect(result.env.HPROXY_API_KEY).toBe('hpx_k');
    expect(result.env.HPROXY_PLAN_ID).toBe('plan1');
    expect(loadStored(env)).toEqual({ HPROXY_API_KEY: 'hpx_k', HPROXY_PLAN_ID: 'plan1' });
    expect(keyVariable('hproxy')).toBe('HPROXY_API_KEY');
    expect(keyVariable('hproxy_proxy_password')).toBe('HPROXY_PROXY_PASSWORD');
    expect(PROXY_VARIABLES).toContain('HPROXY_PROXY_USER');
  });
});

describe('proxyEnv', () => {
  it('uses the shell when it has a login, without touching the vault', async () => {
    const env = await sandbox({ PROXIWARE_PROXY_USER: 'u', PROXIWARE_PROXY_PASSWORD: 'p' });
    const result = proxyEnv({ env, pull: neverPull });
    expect(result.source).toBe('env');
    expect(result.env.PROXIWARE_PROXY_USER).toBe('u');
  });

  it('uses the store, and the shell still wins per variable', async () => {
    const env = await sandbox({ PROXIWARE_PROXY_PASSWORD: 'from-shell' });
    saveStored({ PROXIWARE_PROXY_USER: 'stored-user', PROXIWARE_PROXY_PASSWORD: 'stored-pass', PROXIWARE_API_KEY: 'k' }, env);
    const result = proxyEnv({ env, pull: neverPull });
    expect(result.env.PROXIWARE_PROXY_USER).toBe('stored-user');
    expect(result.env.PROXIWARE_PROXY_PASSWORD).toBe('from-shell');
    expect(result.env.PROXIWARE_API_KEY).toBe('k');
  });

  it('pulls the vault once when nothing is set, caches only the proxy keys', async () => {
    const env = await sandbox();
    const lines: string[] = [];
    let pulls = 0;
    const pull = () => {
      pulls++;
      return {
        PROXIWARE_PROXY_USER: 'vault-user',
        PROXIWARE_PROXY_PASSWORD: 'VAULT-PASS-SECRET',
        PROXIWARE_API_KEY: 'VAULT-KEY-SECRET',
        OPENAI_API_KEY: 'not-ours',
      };
    };
    const first = proxyEnv({ env, pull, log: (line) => lines.push(line) });
    expect(first.source).toBe('vault');
    expect(first.env.PROXIWARE_PROXY_PASSWORD).toBe('VAULT-PASS-SECRET');
    const stored = loadStored(env);
    expect(Object.keys(stored).sort()).toEqual(['PROXIWARE_API_KEY', 'PROXIWARE_PROXY_PASSWORD', 'PROXIWARE_PROXY_USER']);
    expect(lines.join('\n')).toMatch(/cached .*PROXIWARE_PROXY_USER/);
    expect(lines.join('\n')).not.toMatch(/SECRET/);

    const second = proxyEnv({ env, pull });
    expect(second.source).toBe('store');
    expect(pulls).toBe(1);
  });

  it('reports none when the vault fails or has no proxy keys', async () => {
    const env = await sandbox();
    expect(proxyEnv({ env, pull: () => ({ OPENAI_API_KEY: 'x' }) }).source).toBe('none');
    expect(
      proxyEnv({
        env,
        pull: () => {
          throw new Error('logicsrc is not installed');
        },
      }).source,
    ).toBe('none');
  });

  it('covers every variable the package reads', () => {
    // Read off the installed package, so a provider it adds fails here until
    // its keys are pulled and stored too. HPROXY_PLAN_ID is read beside them.
    const fromPackage = Object.values(PROVIDERS).flatMap((provider) => [provider.env.user, provider.env.password, provider.env.apiKey]);
    expect([...PROXY_VARIABLES].sort()).toEqual([...fromPackage, 'HPROXY_PLAN_ID'].sort());
  });
});
