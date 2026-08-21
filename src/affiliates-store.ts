/**
 * Where the progress and the profile live.
 *
 * Same shape and the same reasoning as {@link ./credentials.ts}: one machine's
 * own file, 0600 in a 0700 directory, never synced. A referral link is not a
 * secret in the way an API key is, but the profile beside it carries a contact
 * address, and the two belong under the same permissions rather than in two
 * places with two answers about who can read them.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { type Profile, type State, extractEmail } from './affiliates.ts';

function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLI_TOOLS_AFFILIATES || join(xdgConfigHome(env), 'cli-tools', 'affiliates.json');
}

export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.CLI_TOOLS_AFFILIATE_PROFILE ||
    join(xdgConfigHome(env), 'cli-tools', 'affiliate-profile.json')
  );
}

/**
 * Read a JSON file that is allowed not to exist.
 *
 * A missing file is the normal first run. Malformed JSON is an error and not an
 * empty object, because silently starting over would present a list with every
 * row back at "pending" and no indication that the record of what you already
 * joined is sitting on disk one syntax error away.
 */
function readJson(path: string): Record<string, unknown> {
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
  return parsed as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // The mode above applies only on creation, so an existing file keeps whatever
  // it had — including a permissive mode from a hand edit.
  chmodSync(path, 0o600);
  return path;
}

export function loadState(env: NodeJS.ProcessEnv = process.env): State {
  return readJson(statePath(env)) as State;
}

export function saveState(state: State, env: NodeJS.ProcessEnv = process.env): string {
  return writeJson(statePath(env), state);
}

export type AccountReader = () => string | null;

/** Ask moshcode who is logged in. Absent or not logged in is not an error. */
export const moshcodeAccount: AccountReader = () => {
  const result = spawnSync('moshcode', ['whoami'], { encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) return null;
  return extractEmail(result.stdout ?? '');
};

export function loadProfile(
  env: NodeJS.ProcessEnv = process.env,
  account: AccountReader = moshcodeAccount,
): Profile {
  const stored = readJson(profilePath(env)) as Partial<Record<keyof Profile, string>>;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

  return {
    email: text(env.AFFILIATE_EMAIL) ?? text(stored.email) ?? account(),
    site: text(stored.site),
    audience: text(stored.audience),
    promotion: text(stored.promotion),
  };
}

export function saveProfile(
  profile: Partial<Profile>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stored = readJson(profilePath(env));
  const merged: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(profile)) {
    if (value === null || value === undefined || value === '') delete merged[key];
    else merged[key] = value;
  }
  return writeJson(profilePath(env), merged);
}
