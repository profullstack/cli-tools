import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * API keys the commands here need, kept on this machine.
 *
 * This is a credential store in the sense `~/.aws/credentials` or `gh auth` is
 * one: a single machine's own copy, 0600, never committed and never handed to
 * anyone. It is deliberately not a `.env` — nothing reads it into a process
 * environment wholesale, nothing syncs it, and it is not how a secret travels
 * between machines. A production secret still belongs on the service that runs
 * it, with the vault as the record.
 *
 * The environment always wins over the file. A key exported in the shell, or
 * injected by CI, has to be able to override a stale stored one — and because
 * that is invisible when it happens, `cli-tools config` reports which source
 * each key is coming from rather than only whether one exists.
 */

/**
 * Friendly name → the environment variable the tools already read.
 *
 * The rule for this list is that a key earns its place by being read by a
 * command in this repository, not by being a key the team happens to own. The
 * team vault has more than twice as many; importing all of them would make this
 * file a second, drifting copy of the vault, which is the thing the vault
 * exists to avoid.
 */
export const KNOWN_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  porkbun: 'PORKBUN_API_KEY',
  porkbun_secret: 'PORKBUN_SECRET_API_KEY',
  // Read by `shorten`. Usually not needed: on a machine where the pit works,
  // `moshcode login` has already written the same token to
  // ~/.moshcode/credentials.json and that is what gets picked up. This is for a
  // box that has the key but not moshcode.
  moshcode: 'MOSHCODE_API_KEY',
};

export type Source = 'env' | 'file' | 'unset';

export interface KeyState {
  name: string;
  variable: string;
  source: Source;
  /** Masked, never the whole value. */
  preview: string | null;
}

function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLI_TOOLS_CREDENTIALS || join(xdgConfigHome(env), 'cli-tools', 'credentials.json');
}

/** Resolve a friendly name or an env var name to the env var name, or null. */
export function keyVariable(name: string): string | null {
  // Hyphens and underscores are the same separator here. The single-word keys
  // never needed this; `porkbun-secret-api-key` and `porkbun_secret_api_key`
  // are the same key and both have to land on the same entry.
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/_?(api_?)?key$/, '');
  if (Object.hasOwn(KNOWN_KEYS, key)) return KNOWN_KEYS[key]!;

  const upper = String(name ?? '')
    .trim()
    .toUpperCase();
  return Object.values(KNOWN_KEYS).includes(upper) ? upper : null;
}

/**
 * Read the stored keys.
 *
 * A missing file is the normal first-run case. Malformed JSON is an error,
 * because falling back to "no keys" would surface as a confusing "set
 * OPENAI_API_KEY" message pointing at the environment rather than at the file
 * that is actually broken.
 */
export function loadStored(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = credentialsPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: not valid JSON — ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const stored: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) stored[name] = value.trim();
  }
  return stored;
}

/** Write the store, readable only by its owner. */
export function saveStored(
  stored: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = credentialsPath(env);
  // 0700 on the directory as well: a 0600 file inside a world-readable new
  // directory is only half the protection, and this may be creating both.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode applies only when it creates the file, so an existing
  // one keeps whatever it had — including a permissive mode from a hand edit.
  chmodSync(path, 0o600);
  return path;
}

/**
 * The keys as the tools should see them: stored first, environment on top.
 *
 * Shaped as an environment record on purpose, so callers that already read
 * `process.env` take it without further change.
 */
export function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...loadStored(env) };
  for (const variable of Object.values(KNOWN_KEYS)) {
    if (env[variable]) merged[variable] = env[variable];
  }
  return merged;
}

/** Show enough of a key to recognise it, never enough to use it. */
export function mask(value: string): string {
  const text = String(value ?? '');
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 5)}…${text.slice(-4)} (${text.length} chars)`;
}

/** Where each known key is coming from, for `cli-tools config`. */
export function keyStates(env: NodeJS.ProcessEnv = process.env): KeyState[] {
  const stored = loadStored(env);
  return Object.entries(KNOWN_KEYS).map(([name, variable]) => {
    const fromEnv = env[variable];
    if (fromEnv) return { name, variable, source: 'env' as const, preview: mask(fromEnv) };
    const fromFile = stored[variable];
    if (fromFile) return { name, variable, source: 'file' as const, preview: mask(fromFile) };
    return { name, variable, source: 'unset' as const, preview: null };
  });
}
