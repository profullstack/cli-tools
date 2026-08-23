/**
 * codeburn — somebody else's CLI, kept current and kept off PATH's toes.
 *
 * `codeburn` is an npm package (AgentSeal's AI-spend dashboard). Nothing here
 * reimplements it; this is the part that has to exist so that `codeburn` is a
 * command on this box like every other one in the repo, rather than a thing you
 * remember to `npx`.
 *
 * Three decisions worth the words:
 *
 * It is INSTALLED rather than run through `pnpm dlx`/`npx` every time. dlx hits
 * the registry for metadata on each run before it hands over, which is fine for
 * a one-shot and wrong for a dashboard you open twenty times a day. The install
 * happens once, on first use, and `--self-update` refreshes it.
 *
 * It is installed into a PRIVATE PREFIX under ~/.local/share/cli-tools rather
 * than globally. A global install puts a second executable called `codeburn` on
 * PATH, and this repo's own `codeburn` link is already there: which one wins
 * then depends on the order of two directories in PATH, and the loser is
 * invisible. Worse, if the global one wins nothing breaks, and if ours wins we
 * would shell out to whichever `codeburn` PATH resolves to — which is us —
 * forever. The private prefix means the name exists exactly once.
 *
 * pnpm does the installing, npm is the fallback, and the fallback fires on
 * pnpm being ABSENT and on pnpm FAILING. That is the same order install.sh
 * uses, for the same reason: pnpm is the intent, npm is what a box without it
 * still has.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { onPath, resolveCommand } from './registry.ts';

/** The published package, and the executable it installs. */
export const PACKAGE = 'codeburn';

/**
 * codeburn wants a newer Node than this repo's floor of 20.
 *
 * Worth checking before spawning rather than after: an ink/React TUI on too old
 * a Node fails somewhere inside its own dependencies, and the stack trace names
 * none of this.
 */
export const MIN_NODE = '22.13.0';

export type PackageManager = 'pnpm' | 'npm';

/** Where XDG says durable, non-config state goes. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME ?? homedir(), '.local', 'share');
}

/** The private prefix: a directory whose entire job is to hold one package. */
export function vendorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), 'cli-tools', 'vendor', PACKAGE);
}

/** The installed executable, whether or not it exists yet. */
export function vendorBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(vendorRoot(env), 'node_modules', '.bin', PACKAGE);
}

/**
 * Is this Node new enough for codeburn?
 *
 * Deliberately not a semver dependency for one comparison. Prerelease and build
 * suffixes are dropped, which is the right answer for `23.0.0-nightly`: it is
 * newer than the floor and the tool will run.
 */
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

export interface InstallPlan {
  file: string;
  args: string[];
}

/**
 * How to install the package with each manager.
 *
 * `--ignore-workspace` is not decoration. pnpm walks up from the install
 * directory looking for a workspace root, and ~/.local/share is somebody's home
 * directory — one stray pnpm-workspace.yaml up there and the install lands
 * somewhere else entirely, or is refused.
 */
export function installPlan(manager: PackageManager, spec = `${PACKAGE}@latest`): InstallPlan {
  if (manager === 'pnpm') {
    return { file: 'pnpm', args: ['add', '--ignore-workspace', '--reporter=silent', spec] };
  }
  return { file: 'npm', args: ['install', '--no-audit', '--no-fund', '--silent', spec] };
}

/**
 * The managers to try, in order.
 *
 * A list rather than a choice, because "pnpm is installed" and "pnpm works
 * here" are different claims and only the second one matters.
 */
export function managers(env: NodeJS.ProcessEnv = process.env): PackageManager[] {
  return onPath('pnpm', env) ? ['pnpm', 'npm'] : ['npm'];
}

export type RunnerKind = 'env' | 'vendor' | 'path' | 'missing';

export interface Runner {
  kind: RunnerKind;
  /** The executable to spawn, or null when nothing is installed yet. */
  file: string | null;
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  /** Does this path exist? Injected so the precedence is testable. */
  exists?: (path: string) => boolean;
  /** What `codeburn` on PATH resolves to: ours, somebody's, or nothing. */
  onPathStatus?: () => 'ours' | 'other' | 'missing';
  /** Where that other copy lives, when there is one. */
  onPathTarget?: () => string | null;
}

/**
 * Which codeburn to run.
 *
 * The `ours` case is the one this function exists for. Our own wrapper is
 * installed on PATH under the name `codeburn`, so "is codeburn on PATH" answers
 * yes on every box where this command is installed, and acting on that answer
 * would have the wrapper exec itself until the process table gives out.
 */
export function resolveRunner(deps: ResolveDeps = {}): Runner {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const status = deps.onPathStatus ?? (() => resolveCommand(PACKAGE, undefined, env).status);
  const target = deps.onPathTarget ?? (() => resolveCommand(PACKAGE, undefined, env).target);

  // An explicit override wins outright: a checkout of codeburn itself, or a
  // brew install, is a deliberate act and not ours to second-guess.
  const override = env.CODEBURN_BIN;
  if (override) return { kind: 'env', file: override };

  const vendored = vendorBin(env);
  if (exists(vendored)) return { kind: 'vendor', file: vendored };

  // Only a copy that is NOT this wrapper counts. See above.
  if (status() === 'other') return { kind: 'path', file: target() };

  return { kind: 'missing', file: null };
}

/** Give the private prefix the package.json that both managers insist on. */
export function prepareVendorDir(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = join(root, 'package.json');
  if (existsSync(manifest)) return;

  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        name: 'cli-tools-vendor-codeburn',
        version: '0.0.0',
        private: true,
        description: 'Prefix owned by profullstack/cli-tools. Managed by the codeburn command.',
      },
      null,
      2,
    )}\n`,
  );
}

/** Run a child, inheriting stdio, and resolve its exit code. `null` on spawn failure. */
export function spawnInherit(
  file: string,
  args: readonly string[],
  cwd?: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export interface InstallResult {
  ok: boolean;
  /** Which manager actually did it, or the last one tried. */
  manager: PackageManager;
  bin: string;
}

/**
 * Install (or refresh) the package into the private prefix.
 *
 * `@latest` on purpose, including on the first install: the pin that matters
 * here is "whatever upstream shipped", and a lockfile for one leaf package we
 * do not develop would only be a thing to forget to update.
 */
export async function install(env: NodeJS.ProcessEnv = process.env): Promise<InstallResult> {
  const root = vendorRoot(env);
  prepareVendorDir(root);

  const tried = managers(env);
  let last: PackageManager = tried[tried.length - 1] ?? 'npm';

  for (const manager of tried) {
    last = manager;
    const plan = installPlan(manager);
    const code = await spawnInherit(plan.file, plan.args, root);
    // null is "could not spawn it at all", which is the same outcome as a
    // failed install from here: try the next one.
    if (code === 0 && existsSync(vendorBin(env))) {
      return { ok: true, manager, bin: vendorBin(env) };
    }
  }

  return { ok: false, manager: last, bin: vendorBin(env) };
}

/** What to print when neither manager could install it. */
export function installFailureMessage(manager: PackageManager, root: string): string {
  return [
    `codeburn: could not install ${PACKAGE} with ${manager}.`,
    `  cd ${root} && npm install ${PACKAGE}@latest    # by hand, to see the error`,
    `  CODEBURN_BIN=/path/to/codeburn codeburn …      # or point at a copy you have`,
  ].join('\n');
}

/** What to print when the Node running this is older than codeburn accepts. */
export function nodeFloorMessage(version: string): string {
  return [
    `codeburn: needs Node ${MIN_NODE} or newer, and this is ${version}.`,
    '  mise use -g node@lts       # then re-run',
    'Continuing anyway — the failure below, if any, is that.',
  ].join('\n');
}
