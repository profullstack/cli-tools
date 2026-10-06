/**
 * Keys for `proxy`, the @profullstack/proxy command.
 *
 * The package reads credentials from an environment record and nothing else,
 * so this side's whole job is to build that record: the shell first, then the
 * credential store, and on a box that has neither, one pull of the team vault
 * (the same one `cli-tools config pull` reads), cached so the next run is
 * local. Only the proxy variables are taken from the pull; the rest of the
 * vault is not this command's business.
 */

import { KNOWN_KEYS, loadStored, resolveCredentials, saveStored } from './credentials.ts';
import { pullVault, vaultTarget, type VaultTarget } from './vault.ts';

export const PROXY_VARIABLES = [
  'PROXIWARE_API_KEY',
  'PROXIWARE_PROXY_USER',
  'PROXIWARE_PROXY_PASSWORD',
  'WEBSHARE_API_KEY',
  'WEBSHARE_PROXY_USER',
  'WEBSHARE_PROXY_PASSWORD',
] as const;

// The store only keeps what KNOWN_KEYS names; a variable missing from there
// would be pulled every run and never cached.
for (const variable of PROXY_VARIABLES) {
  if (!Object.values(KNOWN_KEYS).includes(variable)) {
    throw new Error(`proxy: ${variable} is not in KNOWN_KEYS`);
  }
}

type Env = Record<string, string | undefined>;

/** Enough to send traffic through at least one provider. */
export function hasProxyLogin(env: Env): boolean {
  return Boolean(
    (env.PROXIWARE_PROXY_USER && env.PROXIWARE_PROXY_PASSWORD) ||
      (env.WEBSHARE_PROXY_USER && env.WEBSHARE_PROXY_PASSWORD) ||
      env.WEBSHARE_API_KEY,
  );
}

export interface ProxyEnvDeps {
  env?: NodeJS.ProcessEnv;
  pull?: (target: VaultTarget) => Record<string, string>;
  log?: (line: string) => void;
}

/**
 * The environment to hand the package: process env, with stored keys for any
 * proxy variable the shell does not set, pulling the vault once if there is no
 * usable login at all. Returns the record and where the keys came from.
 */
export function proxyEnv(deps: ProxyEnvDeps = {}): { env: Env; source: 'env' | 'store' | 'vault' | 'none' } {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const merged: Env = { ...env, ...pickDefined(resolveCredentials(env), PROXY_VARIABLES) };
  for (const variable of PROXY_VARIABLES) if (env[variable]) merged[variable] = env[variable];

  if (hasProxyLogin(merged)) {
    const fromShell = PROXY_VARIABLES.some((variable) => env[variable]);
    return { env: merged, source: fromShell ? 'env' : 'store' };
  }

  const target = vaultTarget(env);
  log(`proxy: no proxy keys on this machine; pulling them from ${target.team}/${target.project}--${target.env}…`);
  let vault: Record<string, string>;
  try {
    vault = (deps.pull ?? pullVault)(target);
  } catch (error) {
    log(`proxy: ${(error as Error).message}`);
    return { env: merged, source: 'none' };
  }

  const found = pickDefined(vault, PROXY_VARIABLES);
  if (Object.keys(found).length === 0) {
    log(`proxy: ${target.project}--${target.env} has none of ${PROXY_VARIABLES.join(', ')}`);
    return { env: merged, source: 'none' };
  }
  const path = saveStored({ ...loadStored(env), ...found }, env);
  log(`proxy: cached ${Object.keys(found).join(', ')} in ${path}`);
  return { env: { ...merged, ...found, ...pickDefined(env, PROXY_VARIABLES) }, source: 'vault' };
}

function pickDefined(record: Env, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = record[key];
    if (value) out[key] = value;
  }
  return out;
}
