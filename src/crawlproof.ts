/**
 * crawlproof — what the fleet costs and what it returns, on every box.
 *
 * The dashboard itself is `@profullstack/crawlproof`, published from
 * profullstack/crawlproof.com. Nothing here reimplements it; this is the part
 * that has to exist so `crawlproof` is a command on a server like every other
 * one in this repo.
 *
 * INSTALLED rather than run through npx, for the same reason as hqtui: a
 * dashboard is opened many times a day and dlx hits the registry for metadata
 * on every one of those, which is the wrong dependency to have on a box you
 * are SSHed into because something is wrong. Installed once, refreshed with
 * --self-update.
 *
 * Into a PRIVATE PREFIX, and here the reason is sharper than it is for hqtui:
 * upstream's executable is called `crawlproof` and so is this wrapper. A
 * global install would put a second `crawlproof` on PATH, and whichever came
 * first would win — with a real chance of this command exec'ing itself. The
 * private prefix means the name exists exactly once on PATH, and
 * `resolveRunner` refuses to follow a PATH entry that resolves back into this
 * repository's bin/ for the same reason.
 *
 *   CRAWLPROOF_BIN    run this executable instead — a checkout, or a global install
 *   CRAWLPROOF_SPEC   what gets installed, when you want a pinned version
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { onPath, resolveCommand } from './registry.ts';
import { spawnInherit } from './codeburn.ts';
import { delivered, heldBackNote, installedVersion, wantedVersion } from './vendor-verify.ts';

/** The published package, and the executable it installs. */
export const PACKAGE = '@profullstack/crawlproof';
export const EXECUTABLE = 'crawlproof';

/** The floor the package itself declares. Its TUI needs it; so does hqtui. */
export const MIN_NODE = '22.6.0';

/** Where XDG says durable, non-config state goes. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME ?? homedir(), '.local', 'share');
}

/** The private prefix: a directory whose entire job is to hold one package. */
export function vendorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), 'cli-tools', 'vendor', 'crawlproof');
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
 * The `ours` check is load-bearing rather than defensive: the wrapper and the
 * package install the same name, so a PATH hit that resolves back into this
 * repository's bin/ is this file, and following it would be an exec loop.
 */
export function resolveRunner(deps: ResolveDeps = {}): Runner {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const status = deps.onPathStatus ?? (() => resolveCommand(EXECUTABLE, undefined, env).status);
  const target = deps.onPathTarget ?? (() => resolveCommand(EXECUTABLE, undefined, env).target);

  const override = env.CRAWLPROOF_BIN;
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
        name: 'cli-tools-vendor-crawlproof',
        version: '0.0.0',
        private: true,
        description: 'Prefix owned by profullstack/cli-tools. Managed by the crawlproof command.',
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

/** Install (or refresh) the dashboard in the private prefix. */
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
 * Whether this box can answer the money half at all.
 *
 * Reported rather than enforced: the traffic and ads screens work without a
 * CoinPay session, and the dashboard says which panels are missing. A wrapper
 * that refused to start would be hiding four working screens behind one
 * absent credential.
 */
export function hasCoinpaySession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COINPAY_SESSION_TOKEN?.trim()) return true;
  return existsSync(join(env.HOME ?? homedir(), '.coinpay.json'));
}

/**
 * The plain words this wrapper claims for itself.
 *
 * Everything else goes to the dashboard untouched. These are the exception,
 * deliberately and narrowly: installing is the wrapper's job and can never come
 * to mean something upstream, and `update` is the word `cli-tools update`
 * already uses, so typing it here and getting the dashboard's usage back is the
 * command being wrong rather than the person.
 */
export const UPDATE_WORDS = new Set(['update', 'upgrade', 'self-update']);

/**
 * Only the FIRST argument counts, so the word can never swallow some later
 * subcommand's own argument (`crawlproof ads budget update` stays upstream's).
 */
export function wantsSelfUpdate(argv: readonly string[]): boolean {
  return UPDATE_WORDS.has(argv[0] ?? '');
}

/** Whether a CrawlProof API token is reachable without the caller exporting one. */
export function hasToken(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CRAWLPROOF_TOKEN?.trim()) return true;
  return existsSync(env.CRAWLPROOF_CONFIG ?? join(env.HOME ?? homedir(), '.crawlproof.json'));
}
