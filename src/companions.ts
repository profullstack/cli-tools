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

export interface Companion {
  /** The binary the package puts on PATH. */
  name: string;
  /** What to hand `npm install -g`. */
  package: string;
  summary: string;
}

export const COMPANIONS: readonly Companion[] = [
  {
    name: 'timer',
    package: '@profullstack/timer',
    summary: 'Track time against projects, for people and for agents',
  },
  {
    name: 'billing',
    package: '@profullstack/billing',
    summary: 'Clients, rates and invoices from the hours the timer tracked',
  },
];

export function findCompanion(name: string): Companion | null {
  const key = String(name ?? '').trim().toLowerCase();
  return COMPANIONS.find((entry) => entry.name === key) ?? null;
}

/**
 * What `npm install -g` should be handed.
 *
 * `@latest` is explicit on an update because a bare `npm install -g <pkg>` will
 * happily leave an already-satisfied version in place; naming the tag is what
 * makes "update" mean it.
 */
export function installArgs(companion: Companion, { latest = false } = {}): string[] {
  return ['install', '-g', latest ? `${companion.package}@latest` : companion.package];
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
    run: (args: string[]) => { status: number | null; stderr?: string };
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
    const outcome = run(installArgs(companion, { latest }));
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
      message: (outcome.stderr ?? '').trim().split('\n').at(-1) || `npm exited ${outcome.status}`,
    });
  }
  return results;
}
