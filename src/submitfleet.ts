/**
 * submitfleet — launch products on hundreds of directories, from any box.
 *
 * The CLI itself is `@profullstack/submitfleet`, published from
 * profullstack/submitfleet. Nothing here reimplements it; this is the part that
 * has to exist so `submitfleet` is a command on a server like every other one
 * in this repo.
 *
 * INSTALLED rather than run through npx: agents call it many times in a run, and
 * dlx would hit the registry for metadata on every call. Installed once,
 * refreshed with --self-update.
 *
 * Into a PRIVATE PREFIX because upstream's executable is also called
 * `submitfleet`. A global install would put a second `submitfleet` on PATH and
 * this command could exec itself; `resolveRunner` refuses to follow a PATH
 * entry that resolves back into this repository's bin/ for the same reason.
 *
 *   SUBMITFLEET_BIN    run this executable instead — a checkout, or a global install
 *   SUBMITFLEET_SPEC   what gets installed, when you want a pinned version
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { onPath, resolveCommand } from './registry.ts';
import { spawnInherit } from './codeburn.ts';
import { delivered, heldBackNote, installedVersion, wantedVersion } from './vendor-verify.ts';

/** The published package, and the executable it installs. */
export const PACKAGE = '@profullstack/submitfleet';
export const EXECUTABLE = 'submitfleet';

/** The floor the package itself declares (node:sqlite-era libSQL client and fetch). */
export const MIN_NODE = '22.5.0';

/** Where XDG says durable, non-config state goes. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME ?? homedir(), '.local', 'share');
}

/** The private prefix: a directory whose entire job is to hold one package. */
export function vendorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), 'cli-tools', 'vendor', 'submitfleet');
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
 * Which submitfleet executable to run.
 *
 * The `ours` check is load-bearing rather than defensive: the wrapper and the
 * package install the same name, so a PATH hit that resolves back into this
 * repository's bin/ is this file, and following it would be an exec loop.
 */
export function resolveRunner(deps: ResolveDeps = {}): Runner {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const status = deps.onPathStatus ?? (() => resolveCommand(EXECUTABLE, undefined, env).status);
  const target = deps.onPathTarget ?? (() => resolveCommand(EXECUTABLE, undefined, env).target);

  const override = env.SUBMITFLEET_BIN;
  if (override) return { kind: 'env', file: override };

  const vendored = vendorBin(env);
  if (exists(vendored)) return { kind: 'vendor', file: vendored };

  if (status() === 'other') return { kind: 'path', file: target() };

  return { kind: 'missing', file: null };
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
        name: 'cli-tools-vendor-submitfleet',
        version: '0.0.0',
        private: true,
        description: 'Prefix owned by profullstack/cli-tools. Managed by the submitfleet command.',
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

/** Install (or refresh) the CLI in the private prefix. */
export async function install(
  spec: string = `${PACKAGE}@latest`,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof spawnInherit = spawnInherit,
): Promise<InstallResult> {
  const root = vendorRoot(env);
  prepareVendorDir(root);

  // What this install is supposed to produce, asked once rather than per
  // manager. Null means the registry was unreachable, and an unverifiable
  // install is allowed through: an offline box should still be able to
  // reinstall what it already has.
  const wanted = await wantedVersion(spec, PACKAGE);
  let lastNote: string | undefined;

  for (const manager of managers(env)) {
    const plan = installPlan(manager, spec);
    const code = await run(plan.file, plan.args, root);
    if (code !== 0) continue;

    // Exit 0 is not proof. See src/vendor-verify.ts: pnpm's release-age
    // cooldown installs the previous version and reports success.
    const got = installedVersion(root, PACKAGE);
    if (delivered(got, wanted)) return { ok: true, manager, code, ...(got ? { version: got } : {}) };
    lastNote = heldBackNote(manager, got, wanted);
  }

  return { ok: false, ...(lastNote ? { note: lastNote } : {}) };
}


/**
 * The plain words this wrapper claims for itself.
 *
 * Everything else goes to the CLI untouched. These are the exception,
 * deliberately and narrowly: installing is the wrapper's job and can never come
 * to mean something upstream, and `update` is the word `cli-tools update`
 * already uses, so typing it here and getting the CLI's usage back is the
 * command being wrong rather than the person.
 */
export const UPDATE_WORDS = new Set(['update', 'upgrade', 'self-update']);

/**
 * Only the FIRST argument counts, so the word can never swallow some later
 * subcommand's own argument (`submitfleet campaign update` stays upstream's).
 */
export function wantsSelfUpdate(argv: readonly string[]): boolean {
  return UPDATE_WORDS.has(argv[0] ?? '');
}

/** Whether a SubmitFleet API token is reachable without the caller exporting one. */
export function hasToken(env: NodeJS.ProcessEnv = process.env): boolean {
  // An API key in the environment, or a sign-in saved by `submitfleet login` (browser or --key).
  if (env.SUBMITFLEET_API_KEY?.trim()) return true;
  const config = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config');
  return existsSync(env.SUBMITFLEET_AUTH_FILE ?? join(config, 'submitfleet', 'auth.json'));
}
