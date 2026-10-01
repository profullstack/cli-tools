/**
 * alchemy — Alchemy's CLI for onchain data, apps, wallets and x402, on this box.
 *
 * The package is `@alchemy/cli` (https://www.alchemy.com/docs/alchemy-cli).
 * Nothing here reimplements it; this is the part that makes `alchemy` a
 * command on a server like every other one in this repo, installed on first
 * use, rather than a global npm install you remember to do.
 *
 * INSTALLED rather than run through npx, for the same reason as openmcp and
 * agenticjobs: a balance or gas lookup is run many times a day and dlx hits
 * the registry for metadata before it hands over on every one of them.
 *
 * Into a PRIVATE PREFIX. The package's executable is called `alchemy`, which
 * is also the name of this wrapper, so a global install (`moshcode install
 * alchemy` does exactly that) puts a second `alchemy` on PATH. resolveRunner
 * accepts that copy when it is not this wrapper, and never follows PATH back
 * into ourselves.
 *
 * Unlike openmcp, no plain word is intercepted: upstream has no installer
 * manifest for an npm copy to lack, so everything but the two --self-* flags
 * is upstream's.
 *
 *   ALCHEMY_BIN    run this executable instead: a checkout, or a global install
 *   ALCHEMY_SPEC   what gets installed, when you want a pinned version
 *
 * Credentials are upstream's business: `alchemy auth` stores them, and
 * ALCHEMY_API_KEY in the environment is read by the package itself.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { firstOnPath, onPath, resolveCommand } from './registry.ts';
import { spawnInherit } from './codeburn.ts';
import { delivered, heldBackNote, installedVersion, wantedVersion } from './vendor-verify.ts';

/** The published package, and the executable it installs. */
export const PACKAGE = '@alchemy/cli';
export const EXECUTABLE = 'alchemy';

/** Where XDG says durable, non-config state goes. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME ?? homedir(), '.local', 'share');
}

/** The private prefix: a directory whose entire job is to hold one package. */
export function vendorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), 'cli-tools', 'vendor', 'alchemy');
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
 * `--ignore-workspace` because pnpm walks up from the install directory
 * looking for a workspace root, and ~/.local/share is inside a home directory.
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
 * Which Alchemy CLI to run.
 *
 * This wrapper is on PATH as `alchemy`, the same name as upstream's bin, so
 * "is alchemy on PATH" answers yes wherever this command is installed. Only a
 * copy that is NOT this wrapper counts, or we would exec ourselves forever.
 */
export function resolveRunner(deps: ResolveDeps = {}): Runner {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const status = deps.onPathStatus ?? (() => resolveCommand(EXECUTABLE, undefined, env).status);
  // The PATH entry itself, not its realpath: a global install under mise is a
  // shim symlinked to the mise binary, which only runs alchemy when invoked
  // by that name. Exec the realpath and you get `mise --json …`.
  const target = deps.onPathTarget ?? (() => firstOnPath(EXECUTABLE, env));

  const override = env.ALCHEMY_BIN;
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
        name: 'cli-tools-vendor-alchemy',
        version: '0.0.0',
        private: true,
        description: 'Prefix owned by profullstack/cli-tools. Managed by the alchemy command.',
      },
      null,
      2,
    )}\n`,
  );
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
 * Install (or refresh) the Alchemy CLI in the private prefix.
 *
 * Exit 0 is not proof: pnpm's release-age cooldown can install the previous
 * version and report success. src/vendor-verify.ts has the reproduction.
 */
export async function install(
  spec: string = `${PACKAGE}@latest`,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof spawnInherit = spawnInherit,
): Promise<InstallResult> {
  const root = vendorRoot(env);
  prepareVendorDir(root);

  // Null means the registry was unreachable; an unverifiable install is
  // allowed through so an offline box can reinstall what it already has.
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

/** What to print when neither manager could install it. */
export function installFailureMessage(root: string): string {
  return [
    `alchemy: could not install ${PACKAGE}.`,
    `  cd ${root} && npm install ${PACKAGE}@latest   # by hand, to see the error`,
    '  ALCHEMY_BIN=/path/to/alchemy alchemy          # or point at a copy you have',
  ].join('\n');
}
