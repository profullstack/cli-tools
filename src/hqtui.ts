/**
 * hqtui — the HQTUI system dashboard, on every box.
 *
 * The dashboard itself is `@profullstack/hqtui-demo`, published from
 * profullstack/hqtui. Nothing here reimplements it; this is the part that has
 * to exist so `hqtui` is a command on a server like every other one in this
 * repo, rather than a thing you remember to `npx`.
 *
 * INSTALLED rather than run through npx, for the same reason as codeburn: a
 * monitor is opened many times a day, and dlx hits the registry for metadata
 * before it hands over on every one of those. It also has to work on a box
 * that is having a bad day — a machine you are SSHing into precisely because
 * something is wrong is the worst moment to need the network to read a package
 * manifest. Installed once, refreshed with --self-update.
 *
 * Into a PRIVATE PREFIX rather than globally, and here that matters more than
 * it does for codeburn. Two published packages carry an executable this could
 * collide with: `@profullstack/hqtui-demo` installs `hqtui-demo`, and the
 * library `@profullstack/hqtui` installs `hqtui` — the same name as this
 * wrapper. A global install of either puts a second `hqtui` or a shadowing
 * `hqtui-demo` on PATH, and which one wins then depends on the order of two
 * directories. The private prefix means each name exists exactly once.
 *
 * The wrapper is `hqtui` and upstream's executable is `hqtui-demo`, so the
 * self-exec trap codeburn guards against cannot fire here. The guard is still
 * written down, because the library's `hqtui` bin means it could start to.
 *
 *   HQTUI_BIN    run this executable instead — a checkout, or a global install
 *   HQTUI_SPEC   what gets installed, when you want a pinned version
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { onPath, resolveCommand } from './registry.ts';
import { spawnInherit } from './codeburn.ts';

/** The published package, and the executable it installs. */
export const PACKAGE = '@profullstack/hqtui-demo';
export const EXECUTABLE = 'hqtui-demo';

/**
 * The floor the package itself declares.
 *
 * Its bin is compiled JavaScript, so it would very likely run on older Node
 * than this. "Very likely" is not a thing to put in front of somebody at 3am,
 * and the package says 22.6, so that is what gets checked.
 */
export const MIN_NODE = '22.6.0';

/** Where XDG says durable, non-config state goes. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME ?? homedir(), '.local', 'share');
}

/** The private prefix: a directory whose entire job is to hold one package. */
export function vendorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), 'cli-tools', 'vendor', 'hqtui');
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
 * Which dashboard to run.
 *
 * `ours` is checked even though this wrapper is called `hqtui` and upstream's
 * executable is `hqtui-demo`: the sibling library publishes a `hqtui` bin, so
 * a box with that installed globally can put a second `hqtui` on PATH, and
 * following it would be this command exec'ing itself.
 */
export function resolveRunner(deps: ResolveDeps = {}): Runner {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const status = deps.onPathStatus ?? (() => resolveCommand(EXECUTABLE, undefined, env).status);
  const target = deps.onPathTarget ?? (() => resolveCommand(EXECUTABLE, undefined, env).target);

  const override = env.HQTUI_BIN;
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
        name: 'cli-tools-vendor-hqtui',
        version: '0.0.0',
        private: true,
        description: 'Prefix owned by profullstack/cli-tools. Managed by the hqtui command.',
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
}

/** Install (or refresh) the dashboard in the private prefix. */
export async function install(
  spec: string = `${PACKAGE}@latest`,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof spawnInherit = spawnInherit,
): Promise<InstallResult> {
  const root = vendorRoot(env);
  prepareVendorDir(root);

  for (const manager of managers(env)) {
    const plan = installPlan(manager, spec);
    const code = await run(plan.file, plan.args, root);
    if (code === 0) return { ok: true, manager, code };
  }
  return { ok: false };
}
