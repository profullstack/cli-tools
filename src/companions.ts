/**
 * Commands this set ships but does not implement.
 *
 * Everything in `bin/` is a TypeScript file symlinked onto PATH. A companion is
 * the other kind: a published npm package that installs its own binary, which
 * `cli-tools` installs, reports on and updates alongside its own commands so
 * that one install brings the whole set.
 *
 * Why they are not `bin/*.ts` like everything else. These two run on Windows,
 * and the install here cannot: it is symlinks into a git checkout executed
 * through an `npx --yes tsx` shebang. They are also useful with no checkout at
 * all — under any agentic CLI, from a Dockerfile, on a box that has never heard
 * of this repository — which is what being on npm buys. Vendoring them here to
 * make one list tidier would cost them all of that.
 *
 * So the relationship is the same one `cli-tools` has with the pit: this is the
 * front door, not the implementation. `npm install -g` is idempotent, which is
 * what lets install, re-install and update all be the same command.
 */

/**
 * How a companion gets onto the machine.
 *
 * `npm` covers anything published to the registry. `script` covers the ones
 * distributed as an installer instead, which is not a lesser choice: an
 * installer can place a desktop application and a command together, decide
 * between them by what the machine can actually run, and needs no Node on the
 * box at all. Both are idempotent, which is what lets install, re-install and
 * update stay the same command.
 */
export type InstallMethod =
  | { kind: 'npm'; package: string }
  | { kind: 'script'; url: string; args?: readonly string[] };

export interface Companion {
  /** The binary the package puts on PATH. */
  name: string;
  install: InstallMethod;
  summary: string;
  /** Where to read about it, for the message printed when installing fails. */
  home: string;
}

export const COMPANIONS: readonly Companion[] = [
  {
    name: 'timer',
    install: { kind: 'npm', package: '@profullstack/timer' },
    summary: 'Track time against projects, for people and for agents',
    home: 'https://github.com/profullstack/timer',
  },
  {
    name: 'billing',
    install: { kind: 'npm', package: '@profullstack/billing' },
    summary: 'Clients, rates and invoices from the hours the timer tracked',
    home: 'https://github.com/profullstack/billing',
  },
  {
    name: 'diskpush',
    // Not on npm, and not only a Node package: the installer places the
    // desktop app too when the machine has a desktop to run it on, and the CLI
    // it installs runs on the Node inside that app, so a desktop install needs
    // no system Node. `--cli-only` is what makes it a companion here rather
    // than a 100MB surprise on a server.
    install: { kind: 'script', url: 'https://diskpush.com/install.sh', args: ['--cli-only'] },
    summary: 'Browse servers like FileZilla, transfer with rsync — incremental, resumable, server-to-server',
    home: 'https://diskpush.com',
  },
];

export function findCompanion(name: string): Companion | null {
  const key = String(name ?? '').trim().toLowerCase();
  return COMPANIONS.find((entry) => entry.name === key) ?? null;
}

export interface InstallCommand {
  command: string;
  args: string[];
  /** How a person would run it, for the message when it fails. */
  display: string;
}

/**
 * The command that installs a companion.
 *
 * For npm, `@latest` is explicit on an update because a bare
 * `npm install -g <pkg>` will happily leave an already-satisfied version in
 * place; naming the tag is what makes "update" mean it. A script installer is
 * already idempotent and upgrades in place, so there is nothing to add.
 */
export function installCommand(companion: Companion, { latest = false } = {}): InstallCommand {
  if (companion.install.kind === 'npm') {
    const spec = latest ? `${companion.install.package}@latest` : companion.install.package;
    return { command: 'npm', args: ['install', '-g', spec], display: `npm install -g ${spec}` };
  }

  const { url, args = [] } = companion.install;
  // Piped into sh the same way the project documents it, so this and a manual
  // install take the same path and cannot drift apart.
  const line = args.length > 0 ? `curl -fsSL ${url} | sh -s -- ${args.join(' ')}` : `curl -fsSL ${url} | sh`;
  return { command: 'sh', args: ['-c', line], display: line };
}

/** The package or url a companion comes from, for display. */
export function source(companion: Companion): string {
  return companion.install.kind === 'npm' ? companion.install.package : companion.install.url;
}

export type CompanionState = 'installed' | 'missing';

export interface CompanionStatus extends Companion {
  state: CompanionState;
  /** Where the binary was found, or null. */
  path: string | null;
}

/**
 * Whether each companion is on PATH, and where.
 *
 * `onPath` is injected rather than imported so the tests can describe a machine
 * instead of arranging one — installing a global npm package inside a test is
 * not a thing a test gets to do.
 */
export function statuses(
  onPath: (name: string) => string | null,
  list: readonly Companion[] = COMPANIONS,
): CompanionStatus[] {
  return list.map((companion) => {
    const found = onPath(companion.name);
    return { ...companion, state: found ? 'installed' : 'missing', path: found };
  });
}

export interface EnsureResult extends CompanionStatus {
  /** What happened: it was already there, we installed it, or the install failed. */
  action: 'present' | 'installed' | 'failed';
  message?: string;
}

/**
 * Install the companions that are missing.
 *
 * Two rules, both about not being destructive on somebody else's machine:
 *
 *   A companion already on PATH is left alone unless `latest` is set. It may be
 *   a newer version, a local build, or a fork someone is testing, and silently
 *   reinstalling over it is exactly the surprise `link` refuses for symlinks.
 *
 *   A failure is reported and the loop continues. `npm install -g` fails for
 *   ordinary reasons — no npm, a read-only prefix, no network — and none of
 *   them are a reason for the rest of `cli-tools link` to have not happened.
 */
export function ensure(
  {
    onPath,
    run,
    latest = false,
    list = COMPANIONS,
  }: {
    onPath: (name: string) => string | null;
    run: (command: InstallCommand) => { status: number | null; stderr?: string };
    latest?: boolean;
    list?: readonly Companion[];
  },
): EnsureResult[] {
  const results: EnsureResult[] = [];
  for (const companion of list) {
    const found = onPath(companion.name);
    if (found && !latest) {
      results.push({ ...companion, state: 'installed', path: found, action: 'present' });
      continue;
    }
    const outcome = run(installCommand(companion, { latest }));
    if (outcome.status === 0) {
      const after = onPath(companion.name);
      results.push({
        ...companion,
        state: after ? 'installed' : 'missing',
        path: after,
        action: 'installed',
        // npm can exit 0 having installed into a prefix that is not on PATH.
        // Saying so beats reporting success for a command the operator cannot
        // then run — the same gap turso and gradient have in moshcode.
        //
        // Spread rather than `message: undefined`: exactOptionalPropertyTypes
        // is on, so an explicit undefined is not the same as an absent key.
        ...(after ? {} : { message: 'installed, but its bin directory is not on PATH' }),
      });
      continue;
    }
    results.push({
      ...companion,
      state: found ? 'installed' : 'missing',
      path: found,
      action: 'failed',
      message:
        (outcome.stderr ?? '').trim().split('\n').at(-1) ||
        `${installCommand(companion, { latest }).command} exited ${outcome.status}`,
    });
  }
  return results;
}
