/**
 * Did the install actually install anything?
 *
 * Exit code 0 is not proof. pnpm 11 ships a `minimumReleaseAge` cooldown that
 * refuses versions published in the last little while, and it does not fail
 * when it refuses one: it resolves to the newest version old enough to pass,
 * prints a note about an exclude list, and exits 0. So `pnpm add pkg@latest`
 * against a package published ten minutes ago installs the previous release and
 * reports success.
 *
 * Reproduced on 2026-09-06 in an empty directory, pnpm 11.18.0:
 *
 *     registry latest: 0.2.0
 *     pnpm add @profullstack/crawlproof@latest  -> 0.1.0, exit 0
 *     npm install @profullstack/crawlproof@latest -> 0.2.0
 *
 * The failure mode is the bad one. Someone runs `update`, is told it worked,
 * and keeps hitting the bug it was supposed to fix. So the wrappers ask what
 * landed instead of trusting the exit code, and move to the next package
 * manager when the answer is the wrong version.
 *
 * Deliberately not `--config.minimumReleaseAge=0`. The cooldown is a real
 * supply-chain protection and turning it off wholesale in a tool that installs
 * on other people's machines is a bigger decision than fixing an update.
 * Falling through to npm keeps the protection as pnpm's default behaviour and
 * still lets a deliberate `update` finish.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { run } from './exec.ts';

/** The version actually present in a vendor prefix, or null when nothing is. */
export function installedVersion(root: string, pkg: string): string | null {
  const manifest = path.join(root, 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version;
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
}

/**
 * The exact version a spec asks for, when it names one.
 *
 * `pkg@1.2.3` is answerable here; `pkg@latest` and `pkg@^1` are not, and
 * return null so the caller asks the registry instead of guessing.
 */
export function pinnedVersion(spec: string): string | null {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return null;
  const tag = spec.slice(at + 1);
  return /^\d+\.\d+\.\d+/.test(tag) ? tag : null;
}

/** What the registry calls latest, or null when it cannot be reached. */
export async function registryLatest(
  pkg: string,
  exec: typeof run = run,
): Promise<string | null> {
  const result = await exec('npm', ['view', pkg, 'version'], { timeoutMs: 60_000 });
  if (result.code !== 0) return null;
  const version = result.stdout.trim().split('\n').pop()?.trim() ?? '';
  return /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

/**
 * The version this install was supposed to produce.
 *
 * A pinned spec answers itself. `@latest` has to be asked, and when the
 * registry cannot be reached the answer is null, which callers must read as
 * "cannot verify" rather than as "wrong version" — an offline box should still
 * be able to reinstall what it already has.
 */
export async function wantedVersion(
  spec: string,
  pkg: string,
  exec: typeof run = run,
): Promise<string | null> {
  return pinnedVersion(spec) ?? (await registryLatest(pkg, exec));
}

/** Whether what landed is what was asked for. Unknown wants pass. */
export function delivered(installed: string | null, wanted: string | null): boolean {
  if (wanted === null) return true;
  return installed === wanted;
}

/** What to say when a manager reported success and delivered something older. */
export function heldBackNote(manager: string, installed: string | null, wanted: string | null): string {
  return (
    `${manager} reported success but left ${installed ?? 'nothing'} installed, not ${wanted}. ` +
    `pnpm holds back very recent releases; trying the next package manager.`
  );
}
