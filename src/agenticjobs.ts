/**
 * agenticjobs — the job board where agents do the applying, on this box.
 *
 * The board is `@profullstack/agenticjobs`, published from profullstack/
 * agenticjobs and running at agenticjobs.work. Nothing here reimplements it;
 * this is the part that has to exist so `agenticjobs` is a command on a server
 * like every other one in this repo rather than a thing you remember to `npx`.
 *
 * INSTALLED rather than run through npx, for the same reason as codeburn: a
 * search is run many times a day and dlx hits the registry for metadata before
 * it hands over on every one of them.
 *
 * Into a PRIVATE PREFIX, and here it matters more than usual. The package's
 * own executable is called `agenticjobs`, which is also the name of this
 * wrapper, so a global install puts a second `agenticjobs` on PATH and which
 * one wins depends on the order of two directories. If theirs wins, nothing
 * looks broken and this file never runs. If ours wins and we followed PATH, we
 * would exec ourselves until the process table gave out. resolveRunner only
 * ever accepts a copy that is NOT this wrapper.
 *
 * THE PACKAGE MANAGES ITS OWN INSTALL, which is the thing worth reading twice.
 * `agenticjobs update`, `uninstall` and `where` all read a manifest.json that
 * upstream's curl installer writes, and a copy put here by npm has no such
 * file. Upstream answers "not installed by the installer" and exits, which on
 * a box where cli-tools plainly did install it is the misleading kind of
 * wrong. So those three words are answered here when the copy running is ours,
 * and handed straight through when it is not. See ownsInstallWord.
 *
 *   AGENTICJOBS_BIN    run this executable instead: a checkout, or their installer
 *   AGENTICJOBS_SPEC   what gets installed, when you want a pinned version
 *
 * Deliberately NOT set here: AGENTICJOBS_HOME. That is upstream's variable for
 * finding its own manifest, and pointing it at a prefix with no manifest in it
 * would trade a clear message for a confusing one.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { onPath, resolveCommand } from './registry.ts';
import { spawnInherit } from './codeburn.ts';
import { delivered, heldBackNote, installedVersion, wantedVersion } from './vendor-verify.ts';

/** The published package, and the executable it installs. */
export const PACKAGE = '@profullstack/agenticjobs';
export const EXECUTABLE = 'agenticjobs';

/**
 * The floor the package declares.
 *
 * Higher than this repo's own floor of 22.18, so it is checked rather than
 * assumed: the board's bin loads compiled ESM that uses newer built-ins, and
 * the failure on older Node names a file inside node_modules and nothing else.
 */
export const MIN_NODE = '24.0.0';

/** Where XDG says durable, non-config state goes. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME ?? homedir(), '.local', 'share');
}

/** The private prefix: a directory whose entire job is to hold one package. */
export function vendorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), 'cli-tools', 'vendor', 'agenticjobs');
}

/** The installed executable, whether or not it exists yet. */
export function vendorBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(vendorRoot(env), 'node_modules', '.bin', EXECUTABLE);
}

export type PackageManager = 'pnpm' | 'npm';

export interface InstallPlan {
  file: string;
  args: string[];
}

/**
 * How to install with each manager.
 *
 * `--ignore-workspace` is not decoration: pnpm walks up from the install
 * directory looking for a workspace root, and ~/.local/share is inside
 * somebody's home directory.
 */
export function installPlan(manager: PackageManager, spec = `${PACKAGE}@latest`): InstallPlan {
  if (manager === 'pnpm') {
    return { file: 'pnpm', args: ['add', '--ignore-workspace', '--reporter=silent', spec] };
  }
  return { file: 'npm', args: ['install', '--no-audit', '--no-fund', '--silent', spec] };
}

/** The managers to try, in order. pnpm is the intent, npm is what a bare box has. */
export function managers(env: NodeJS.ProcessEnv = process.env): PackageManager[] {
  return onPath('pnpm', env) ? ['pnpm', 'npm'] : ['npm'];
}

export type RunnerKind = 'env' | 'vendor' | 'path' | 'missing';

export interface Runner {
  kind: RunnerKind;
  file: string | null;
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  onPathStatus?: () => 'ours' | 'other' | 'missing';
  onPathTarget?: () => string | null;
}

/**
 * Which board client to run.
 *
 * The `ours` case is the whole reason this function exists. This wrapper is
 * installed on PATH under the name `agenticjobs`, the same name the package's
 * own bin uses, so "is agenticjobs on PATH" answers yes on every box where
 * this command is installed. Acting on that answer is a fork bomb.
 */
export function resolveRunner(deps: ResolveDeps = {}): Runner {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const status = deps.onPathStatus ?? (() => resolveCommand(EXECUTABLE, undefined, env).status);
  const target = deps.onPathTarget ?? (() => resolveCommand(EXECUTABLE, undefined, env).target);

  // An explicit override wins outright: a checkout of the board, or a copy put
  // there by upstream's own installer, is a deliberate act and not ours to
  // second-guess.
  const override = env.AGENTICJOBS_BIN;
  if (override) return { kind: 'env', file: override };

  const vendored = vendorBin(env);
  if (exists(vendored)) return { kind: 'vendor', file: vendored };

  // Only a copy that is NOT this wrapper counts. See above.
  if (status() === 'other') return { kind: 'path', file: target() };

  return { kind: 'missing', file: null };
}

/**
 * The words about an install that only make sense against ours.
 *
 * `update`, `uninstall` and `where` are upstream's commands and upstream
 * answers them from a manifest.json its curl installer writes. A copy npm put
 * in our prefix has no manifest, so upstream would say "not installed by the
 * installer" on a box where this command installed it and works. These three
 * are therefore answered here, and ONLY when the copy that would run is the
 * one we installed: a board put there by upstream's installer, or pointed at
 * with AGENTICJOBS_BIN, keeps upstream's behaviour exactly.
 */
export const INSTALL_WORDS = new Set(['update', 'uninstall', 'where']);

export function ownsInstallWord(kind: RunnerKind, word: string | undefined): boolean {
  if (word === undefined || !INSTALL_WORDS.has(word)) return false;
  return kind === 'vendor' || kind === 'missing';
}

/** Give the private prefix the package.json both managers insist on. */
export function prepareVendorDir(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = join(root, 'package.json');
  if (existsSync(manifest)) return;

  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        name: 'cli-tools-vendor-agenticjobs',
        version: '0.0.0',
        private: true,
        description:
          'Prefix owned by profullstack/cli-tools. Managed by the agenticjobs command.',
      },
      null,
      2,
    )}\n`,
  );
}

/** Is this Node new enough? Prerelease and build suffixes are dropped. */
export function meetsNodeFloor(version: string, floor: string = MIN_NODE): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const got = parse(version);
  const want = parse(floor);

  for (let i = 0; i < 3; i += 1) {
    const a = got[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export interface InstallResult {
  ok: boolean;
  manager?: PackageManager;
  code?: number | null;
  /** What actually landed, when it could be read. */
  version?: string;
  /** Why an install that exited 0 was not accepted. */
  note?: string;
}

/**
 * Install (or refresh) the board client in the private prefix.
 *
 * Exit 0 is not proof: pnpm's release-age cooldown installs the previous
 * version and reports success, which is how an `update` run to pick up a fix
 * can leave the fix uninstalled. src/vendor-verify.ts has the reproduction.
 */
export async function install(
  spec: string = `${PACKAGE}@latest`,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof spawnInherit = spawnInherit,
): Promise<InstallResult> {
  const root = vendorRoot(env);
  prepareVendorDir(root);

  // Asked once rather than per manager. Null means the registry was
  // unreachable, and an unverifiable install is allowed through: an offline
  // box should still be able to reinstall what it already has.
  const wanted = await wantedVersion(spec, PACKAGE);
  let lastNote: string | undefined;

  for (const manager of managers(env)) {
    const plan = installPlan(manager, spec);
    const code = await run(plan.file, plan.args, root);
    if (code !== 0) continue;

    const got = installedVersion(root, PACKAGE);
    if (delivered(got, wanted)) return { ok: true, manager, code, ...(got ? { version: got } : {}) };
    lastNote = heldBackNote(manager, got, wanted);
  }

  return { ok: false, ...(lastNote ? { note: lastNote } : {}) };
}

/**
 * Remove the copy we installed.
 *
 * Only ever the prefix this command owns. Upstream's `uninstall` reads a
 * manifest and removes the paths its own installer wrote, which is the right
 * thing for a board installed that way and no business of ours.
 *
 * Configuration is deliberately left alone. ~/.config/agenticjobs holds the
 * boards you are signed in to and the tokens for them, and upstream keeps them
 * across its own uninstall for the same reason: removing a program is not the
 * same as saying you never want to log in again.
 */
export function removeVendor(env: NodeJS.ProcessEnv = process.env): boolean {
  const root = vendorRoot(env);
  if (!existsSync(root)) return false;
  rmSync(root, { recursive: true, force: true });
  return true;
}

/** What to print when neither manager could install it. */
export function installFailureMessage(root: string): string {
  return [
    `agenticjobs: could not install ${PACKAGE}.`,
    `  cd ${root} && npm install ${PACKAGE}@latest       # by hand, to see the error`,
    '  AGENTICJOBS_BIN=/path/to/agenticjobs agenticjobs  # or point at a copy you have',
  ].join('\n');
}

/** What to print when the Node running this is older than the board accepts. */
export function nodeFloorMessage(version: string): string {
  return [
    `agenticjobs: needs Node ${MIN_NODE} or newer, and this is ${version}.`,
    '  mise use -g node@lts       # then re-run',
    'Continuing anyway, so the failure below, if any, is that.',
  ].join('\n');
}
