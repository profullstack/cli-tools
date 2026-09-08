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

import { fileURLToPath } from 'node:url';

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
 * `archive` is the last resort, for a vendor who publishes a binary and no
 * installer at all: download the release, unpack it under `vendor/`, link what
 * it contains. Google's platform-tools is the case that forced it -- `adb` is
 * not on npm, has no install script, and the packages that claim to be it are
 * either a Node reimplementation of the protocol or somebody's mirror of the
 * zip. Vendoring it here is the same arrangement `install.sh` already has with
 * the Stripe CLI, moved somewhere `cli-tools update` can reach.
 *
 * All four are idempotent, which is what lets install, re-install and update
 * stay the same command.
 */
export type InstallMethod =
  | { kind: 'npm'; package: string }
  | { kind: 'script'; url: string; args?: readonly string[] }
  | { kind: 'go'; module: string }
  | {
      kind: 'archive';
      /** What to print as the source: a url with the platform left as `<os>`. */
      source: string;
      /** The download, per `process.platform`. Absent means no build for that box. */
      urls: Readonly<Partial<Record<NodeJS.Platform, string>>>;
      /** The directory the archive unpacks into, and the name it keeps under `vendor/`. */
      dir: string;
      /** The binaries inside it to link onto PATH. The first one is `name`. */
      bins: readonly string[];
    };

export interface Companion {
  /** The binary the package puts on PATH. */
  name: string;
  install: InstallMethod;
  summary: string;
  /** Where to read about it, for the message printed when installing fails. */
  home: string;
  /**
   * A set this companion belongs to, and is installed only when asked for.
   *
   * No group means the default set: small, useful on any box, installed by
   * `link` and by the installer. A group is for the ones that are neither --
   * `mobile` puts half a gigabyte of Expo on a machine, which a web server has
   * no use for. It is the same judgement `diskpush` gets with `--cli-only`:
   * a command-line toolbelt does not quietly place things this size.
   *
   * `cli-tools companions --install mobile` is how you say yes to one.
   */
  group?: string;
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
  {
    name: 'adb',
    // The Android Debug Bridge, and `fastboot` out of the same archive: one
    // download, two commands. Neither is on npm. What is published under those
    // names is either a Node reimplementation of the wire protocol (adbkit) or
    // somebody's mirror of this very zip, and a debugging bridge with root on
    // every attached device is the last thing to take from a mirror. Google
    // publishes no installer either, only the archive -- which is what the
    // `archive` kind exists for.
    //
    // Vendored under `vendor/platform-tools` for the reason the Stripe CLI is:
    // the name should exist once. An `adb` already on PATH -- apt's, or the one
    // inside an Android Studio SDK -- is left alone rather than shadowed, and
    // `--force` is what says otherwise.
    //
    // platform-tools deliberately, not the whole SDK. `adb` and `fastboot` are
    // what a command line needs against a device; the emulator, `sdkmanager`
    // and the build tools want a JDK and a licence-acceptance flow, which is
    // Android Studio's job rather than a toolbelt's.
    install: {
      kind: 'archive',
      source: 'https://dl.google.com/android/repository/platform-tools-latest-<os>.zip',
      // Windows is missing on purpose rather than for want of a build: Google
      // publishes that zip too, but this install is symlinks into a vendor
      // directory, which is not how a command gets onto PATH there. On Windows
      // it is Android Studio's SDK Manager.
      urls: {
        linux: 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
        darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
      },
      dir: 'platform-tools',
      bins: ['adb', 'fastboot'],
    },
    summary: 'Talk to Android devices and emulators — install, log, shell, port-forward (brings fastboot)',
    home: 'https://developer.android.com/tools/adb',
    group: 'mobile',
  },
  {
    name: 'expo',
    // The Expo CLI has no package of its own: it ships inside `expo`, and
    // Expo's own advice is `npx expo` from inside a project so the CLI always
    // matches that project's SDK. This global copy is for the other half —
    // creating an app before a project exists, and `expo` meaning something on
    // a box you have just sat down at. The two do not fight: `npx expo` still
    // prefers the project's own copy when there is one.
    //
    // Unscoped, unlike everything above it. That was an accident of every
    // companion having been ours or Bitwarden's, never a rule.
    //
    // It puts `fingerprint` and `expo-modules-autolinking` on PATH beside
    // `expo`. Only `expo` is checked here, because the package is one thing.
    install: { kind: 'npm', package: 'expo' },
    summary: 'Create and run Expo apps — the CLI that npx would fetch, with no project to hand',
    home: 'https://docs.expo.dev/more/expo-cli/',
    group: 'mobile',
  },
  {
    name: 'eas',
    // The half of Expo that is meant to be global: builds, signing, store
    // submission and OTA updates all happen on their infrastructure rather
    // than in a project, and Expo documents `npm install -g eas-cli` for
    // exactly that reason. It holds credentials for the App Store and Play
    // Console once authenticated, so like `myna` this is a front door and
    // nothing about the account lives here: `eas login` does that.
    install: { kind: 'npm', package: 'eas-cli' },
    summary: 'Build, sign and submit iOS and Android apps in the cloud, and ship OTA updates',
    home: 'https://docs.expo.dev/eas/',
    group: 'mobile',
  },
];

/**
 * The script that installs an `archive` companion.
 *
 * Resolved from this file rather than passed in by the caller. Every caller
 * would have to know the checkout root otherwise, and they would all compute
 * it from somewhere near here anyway -- while this module already knows
 * exactly which checkout it is part of, which is the one whose `vendor/` the
 * download belongs in.
 */
export const ARCHIVE_INSTALLER = fileURLToPath(
  new URL('../scripts/install-archive.ts', import.meta.url),
);

/**
 * The download for this box, or null when the vendor publishes nothing for it.
 *
 * Null is an answer, not a failure to find one: it is what makes an install on
 * an unsupported platform say so instead of downloading a Linux binary onto a
 * Mac.
 */
export function archiveUrl(
  companion: Companion,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (companion.install.kind !== 'archive') return null;
  return companion.install.urls[platform] ?? null;
}

export function findCompanion(name: string): Companion | null {
  const key = String(name ?? '').trim().toLowerCase();
  return COMPANIONS.find((entry) => entry.name === key) ?? null;
}

/** Every group named by the list, in the order they first appear. */
export function groups(list: readonly Companion[] = COMPANIONS): string[] {
  const seen: string[] = [];
  for (const companion of list) {
    if (companion.group && !seen.includes(companion.group)) seen.push(companion.group);
  }
  return seen;
}

/** The companions installed by default: the ones in no group. */
export function core(list: readonly Companion[] = COMPANIONS): Companion[] {
  return list.filter((companion) => !companion.group);
}

/**
 * Which companions a request names.
 *
 * Nothing named is the default set, because that is what `link` and the
 * installer ask for and neither should adopt half a gigabyte of Expo on the
 * strength of running an installer. A group name takes that group, a companion
 * name takes that one, and `all` takes everything -- and anything else comes
 * back in `unknown` rather than being quietly ignored, which is how a typo
 * ends up looking like a group that installed nothing.
 */
export function select(
  selectors: readonly string[],
  list: readonly Companion[] = COMPANIONS,
): { list: Companion[]; unknown: string[] } {
  if (selectors.length === 0) return { list: core(list), unknown: [] };

  const chosen: Companion[] = [];
  const unknown: string[] = [];
  for (const raw of selectors) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (key === 'all') {
      for (const companion of list) if (!chosen.includes(companion)) chosen.push(companion);
      continue;
    }
    const matches = list.filter(
      (companion) => companion.name === key || companion.group === key,
    );
    if (matches.length === 0) {
      unknown.push(raw);
      continue;
    }
    for (const companion of matches) if (!chosen.includes(companion)) chosen.push(companion);
  }
  // Back into list order, so the output does not depend on how it was asked for.
  return { list: list.filter((companion) => chosen.includes(companion)), unknown };
}

/**
 * What an update should touch: the default set, plus whatever grouped
 * companions this box actually has.
 *
 * Update means update, not adopt. Someone who never asked for the mobile set
 * should not find `eas` installed because they ran `cli-tools update`, and
 * someone who did ask should not have to ask again every time.
 */
export function forUpdate(
  onPath: (name: string) => string | null,
  list: readonly Companion[] = COMPANIONS,
): Companion[] {
  return list.filter((companion) => !companion.group || onPath(companion.name));
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

  if (companion.install.kind === 'archive') {
    // The only companion kind whose installer is ours. There is no upstream
    // command to run: something has to fetch the archive, unpack it under
    // `vendor/` and link what it contains, and that something is
    // `scripts/install-archive.ts`. `--force` is this kind's `@latest` --
    // without it the script leaves an existing install, or somebody else's
    // binary of that name, exactly where it is.
    const args = latest ? [ARCHIVE_INSTALLER, companion.name, '--force'] : [ARCHIVE_INSTALLER, companion.name];
    return { command: 'node', args, display: `node ${args.join(' ')}` };
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
    case 'archive':
      return companion.install.source;
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
    // The default set, not every companion. A caller that forgets to say which
    // ones it wants should get the small, universally useful ones -- never half
    // a gigabyte of Expo on a box that asked for a link.
    list = core(),
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
