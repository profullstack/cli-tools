/**
 * rea — REA (morluto/rea), reverse engineer anything with agents.
 *
 * Upstream ships `curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh | bash`,
 * which is `npm install --global --prefix ~/.local rea-agents@<latest tag>`
 * followed by an interactive `rea setup`. This is the codeburn shape instead
 * (src/codeburn.ts has the long version of why): installed on first use into a
 * private prefix under ~/.local/share/cli-tools/vendor, so the name `rea` on
 * PATH is this launcher and nothing races it, and every argument is handed
 * through untouched so upstream's docs are the docs.
 *
 * Two things differ from codeburn:
 *
 * The package and the executable have different names (`rea-agents` installs
 * `rea`), so PACKAGE and BIN are separate constants.
 *
 * REA's Node floor is three ranges, not one minimum: ^22.23.4, ^24.22.1 or
 * >=26.12.1. Node 23 and 25 are excluded on purpose upstream, so a single
 * "at least X" comparison would wave them through. Like codeburn it is a
 * warning, not a refusal.
 *
 * If upstream's own installer already put a `rea` in ~/.local/bin, the linker
 * leaves it alone (see cli-tools-agenticjobs) and this launcher still works:
 * resolveRunner sees a `rea` on PATH that is not us and hands through to it.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataHome, managers, spawnInherit, type PackageManager } from './codeburn.ts';
import { resolveCommand } from './registry.ts';

export { spawnInherit };

/** The published package, and the executable it installs. */
export const PACKAGE = 'rea-agents';
export const BIN = 'rea';

/** Upstream's package.json#engines.node, kept in words for messages. */
export const NODE_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1';

/** The private prefix: a directory whose entire job is to hold one package. */
export function vendorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), 'cli-tools', 'vendor', BIN);
}

/** The installed executable, whether or not it exists yet. */
export function vendorBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(vendorRoot(env), 'node_modules', '.bin', BIN);
}

function parse(v: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = v
    .replace(/^v/, '')
    .split(/[-+]/)[0]!
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [a, b, c];
}

function atLeast(got: [number, number, number], want: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (got[i] !== want[i]) return got[i]! > want[i]!;
  }
  return true;
}

/** Does this Node satisfy ^22.23.4 || ^24.22.1 || >=26.12.1? */
export function meetsNodeRange(version: string): boolean {
  const v = parse(version);
  if (v[0] === 22) return atLeast(v, [22, 23, 4]);
  if (v[0] === 24) return atLeast(v, [24, 22, 1]);
  return atLeast(v, [26, 12, 1]);
}

export interface InstallPlan {
  file: string;
  args: string[];
}

/** Same flags as codeburn's, for the same reasons (see there). */
export function installPlan(manager: PackageManager, spec = `${PACKAGE}@latest`): InstallPlan {
  if (manager === 'pnpm') {
    return { file: 'pnpm', args: ['add', '--ignore-workspace', '--reporter=silent', spec] };
  }
  return { file: 'npm', args: ['install', '--no-audit', '--no-fund', '--silent', spec] };
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
 * Which rea to run: REA_BIN, then our private copy, then a `rea` on PATH that
 * is NOT this launcher (running ourselves would loop), else nothing yet.
 */
export function resolveRunner(deps: ResolveDeps = {}): Runner {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const status = deps.onPathStatus ?? (() => resolveCommand(BIN, undefined, env).status);
  const target = deps.onPathTarget ?? (() => resolveCommand(BIN, undefined, env).target);

  if (env.REA_BIN) return { kind: 'env', file: env.REA_BIN };

  const vendored = vendorBin(env);
  if (exists(vendored)) return { kind: 'vendor', file: vendored };

  if (status() === 'other') return { kind: 'path', file: target() };

  return { kind: 'missing', file: null };
}

function prepareVendorDir(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = join(root, 'package.json');
  if (existsSync(manifest)) return;
  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        name: 'cli-tools-vendor-rea',
        version: '0.0.0',
        private: true,
        description: 'Prefix owned by profullstack/cli-tools. Managed by the rea command.',
      },
      null,
      2,
    )}\n`,
  );
}

export interface InstallResult {
  ok: boolean;
  manager: PackageManager;
  bin: string;
}

/** Install (or refresh) rea-agents@latest into the private prefix, pnpm then npm. */
export async function install(env: NodeJS.ProcessEnv = process.env): Promise<InstallResult> {
  const root = vendorRoot(env);
  prepareVendorDir(root);

  const tried = managers(env);
  let last: PackageManager = tried[tried.length - 1] ?? 'npm';

  for (const manager of tried) {
    last = manager;
    const plan = installPlan(manager);
    const code = await spawnInherit(plan.file, plan.args, root);
    if (code === 0 && existsSync(vendorBin(env))) {
      return { ok: true, manager, bin: vendorBin(env) };
    }
  }

  return { ok: false, manager: last, bin: vendorBin(env) };
}

export function installFailureMessage(manager: PackageManager, root: string): string {
  return [
    `rea: could not install ${PACKAGE} with ${manager}.`,
    `  cd ${root} && npm install ${PACKAGE}@latest    # by hand, to see the error`,
    '  curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh | bash   # upstream installer',
    '  REA_BIN=/path/to/rea rea …                      # or point at a copy you have',
  ].join('\n');
}

export function nodeRangeMessage(version: string): string {
  return [
    `rea: REA needs Node ${NODE_RANGE}, and this is ${version}.`,
    '  mise use -g node@24       # then re-run',
    'Continuing anyway — the failure below, if any, is that.',
  ].join('\n');
}
