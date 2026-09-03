/**
 * Commands this set ships but does not implement.
 *
 * Everything in `bin/` is a TypeScript file symlinked onto PATH. A companion is
 * the other kind: a command published in its own right -- on npm, behind an
 * installer, or as a Go module -- which `cli-tools` installs, reports on and
 * updates alongside its own commands so that one install brings the whole set.
 *
 * Why they are not `bin/*.ts` like everything else. They run on Windows, and
 * the install here cannot: it is symlinks into a git checkout executed through
 * an `npx --yes tsx` shebang. They are also useful with no checkout at all —
 * under any agentic CLI, from a Dockerfile, on a box that has never heard of
 * this repository — which is what being on npm buys. Vendoring them here to
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
 * box at all. `go` covers a Go program published as a module rather than to a
 * registry: `go install` fetches, builds and places it in one step, which is
 * how that ecosystem distributes a command.
 *
 * All three are idempotent, which is what lets install, re-install and update
 * stay the same command.
 */
export type InstallMethod =
  | { kind: 'npm'; package: string }
  | { kind: 'script'; url: string; args?: readonly string[] }
  | { kind: 'go'; module: string };

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
    name: 'bw',
    // The only companion here that is nobody's but Bitwarden's. It earns the
    // place the same way the others do: published, self-installing, and useful
    // on a box with no checkout. It covers the secrets `vault.ts` deliberately
    // does not -- that reads a logicsrc team vault of shared API keys, which is
    // a different thing from one person's passwords.
    install: { kind: 'npm', package: '@bitwarden/cli' },
    summary: 'Read and write a Bitwarden vault — logins, notes and exports',
    home: 'https://bitwarden.com/help/cli/',
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
  {
    name: 'myna',
    // A compiled binary with its runtime inside, so the installer needs no
    // Node on the box at all -- which is the whole reason it is a companion
    // rather than a `bin/*.ts` here. It is also the one command in this set
    // that posts publicly, so it stays a front door: `myna login` does the
    // credential handling, and nothing about the account lives in this repo.
    install: { kind: 'script', url: 'https://mynaposter.com/install.sh' },
    summary: 'Post, schedule and read across 25 social networks from a TUI',
    home: 'https://mynaposter.com',
  },
  {
    name: 'devdb',
    // A Go program, and the first companion here that is neither on npm nor
    // behind an installer script. Its releases carry linux and darwin binaries
    // only, so `go install` is the wider door, not the narrower one: it builds
    // for whatever the box is, Windows included, which is where the published
    // assets stop and where the rest of this set cannot follow.
    //
    // It needs a container runtime at run time -- Docker, Podman or OrbStack --
    // which no other companion does. That is devdb's precondition to state, not
    // ours to install: a toolbelt that quietly put a container daemon on a box
    // would be the surprise `link` refuses everywhere else.
    install: { kind: 'go', module: 'github.com/terrablue/devdb' },
    summary: 'Spin up a throwaway local database for development or testing — needs Docker, Podman or OrbStack',
    home: 'https://github.com/terrablue/devdb',
  },
  {
    name: 'kali',
    // A front door in the truest sense: the package installs the `kali` command
    // and nothing else, and that command is itself an installer -- it puts the
    // Kali-style web pentest toolbelt (nmap, nuclei, ffuf, sqlmap, zaproxy and
    // the rest) onto a plain Debian/Ubuntu box, choosing apt, `go install`,
    // gem, snap or a release binary per tool. It is a companion rather than a
    // `bin/*.ts` for the usual reason: published and self-installing, it is
    // useful under any agentic CLI or from a Dockerfile with no checkout of
    // this repo. The tools it installs are dual-use -- it equips a box you are
    // authorized to test, and nothing about a target lives here.
    install: { kind: 'npm', package: '@profullstack/kali' },
    summary: 'Install a Kali-style web pentesting toolbelt on Debian/Ubuntu',
    home: 'https://github.com/profullstack/kali',
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

  if (companion.install.kind === 'go') {
    // `go install` in module-aware mode requires a version, so the tag is not
    // an update-only flourish the way npm's is -- it is the only spelling there
    // is. It refetches, rebuilds and replaces the binary every time, so an
    // update needs nothing added and an install is already idempotent.
    const spec = `${companion.install.module}@latest`;
    return { command: 'go', args: ['install', spec], display: `go install ${spec}` };
  }

  const { url, args = [] } = companion.install;
  // Piped into sh the same way the project documents it, so this and a manual
  // install take the same path and cannot drift apart.
  const line = args.length > 0 ? `curl -fsSL ${url} | sh -s -- ${args.join(' ')}` : `curl -fsSL ${url} | sh`;
  return { command: 'sh', args: ['-c', line], display: line };
}

/** The package, module or url a companion comes from, for display. */
export function source(companion: Companion): string {
  switch (companion.install.kind) {
    case 'npm':
      return companion.install.package;
    case 'go':
      return companion.install.module;
    default:
      return companion.install.url;
  }
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
