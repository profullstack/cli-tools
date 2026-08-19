import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Read API keys out of a logicsrc team vault.
 *
 * The vault is the authority; {@link ../credentials.ts} is a cache of the few
 * keys these commands actually use. That direction matters — copying the whole
 * vault down would make the local file a second, silently drifting copy of
 * every team secret, which is the thing the vault exists to avoid.
 *
 * `logicsrc teams pull` can only write a decrypted `.env` to a path, so the
 * plaintext exists on disk for the length of one read. It goes to a 0700
 * temporary directory and is removed in a `finally`, including when the parse
 * throws.
 */

export interface VaultTarget {
  team: string;
  project: string;
  env: string;
}

/** The team vault holding account-level keys shared across the org. */
export const DEFAULT_TARGET: VaultTarget = {
  team: 'profullstack',
  project: 'profullstack-sharable-keys',
  env: 'prod',
};

/** Resolve the target, letting the environment point at a different vault. */
export function vaultTarget(env: NodeJS.ProcessEnv = process.env): VaultTarget {
  return {
    team: env.CLI_TOOLS_VAULT_TEAM || DEFAULT_TARGET.team,
    project: env.CLI_TOOLS_VAULT_PROJECT || DEFAULT_TARGET.project,
    env: env.CLI_TOOLS_VAULT_ENV || DEFAULT_TARGET.env,
  };
}

/** Parse a dotenv file. Only what a vault actually contains: KEY=value lines. */
export function parseEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;

    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) parsed[key] = value;
  }
  return parsed;
}

export type Runner = (args: readonly string[], envPath: string) => { status: number; stderr: string };

/** Shell out to the real logicsrc CLI. */
export const logicsrcRunner: Runner = (args, envPath) => {
  const result = spawnSync('logicsrc', [...args, '--env', envPath], { encoding: 'utf8' });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        status: 127,
        stderr:
          'logicsrc is not installed. Install it with `moshcode install secrets`, ' +
          'or see https://logicsrc.com',
      };
    }
    return { status: 1, stderr: result.error.message };
  }
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
};

/**
 * Pull a vault and return its keys.
 *
 * The decrypted file never leaves this function, and the caller receives only
 * the parsed record — so nothing downstream has a path it could accidentally
 * leave lying around.
 */
export function pullVault(
  target: VaultTarget = vaultTarget(),
  run: Runner = logicsrcRunner,
): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'cli-tools-vault-'));
  const envPath = join(dir, 'vault.env');

  try {
    const { status, stderr } = run(
      ['teams', 'pull', target.team, target.project, target.env],
      envPath,
    );
    if (status !== 0) {
      const detail = stderr.trim().split('\n').slice(-3).join('\n');
      throw new Error(
        `logicsrc teams pull ${target.team} ${target.project} ${target.env} failed` +
          (detail ? `:\n${detail}` : '.'),
      );
    }

    let text: string;
    try {
      text = readFileSync(envPath, 'utf8');
    } catch {
      throw new Error('logicsrc reported success but wrote no file — nothing imported.');
    }
    return parseEnvFile(text);
  } finally {
    // Recursive so the temp directory goes with it, and force so a failure
    // before the file existed is not itself an error.
    rmSync(dir, { recursive: true, force: true });
  }
}
