import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { onPath } from './registry.ts';

/**
 * Bring a Debian or Ubuntu box up to date: package lists, packages, snaps.
 *
 * Deliberately not called `update`. `cli-tools update` already means "move
 * this checkout to the current commit", and a second, unrelated meaning of the
 * same word — one that reaches for sudo and upgrades the whole operating
 * system — is the kind of collision somebody discovers by running the wrong
 * one. The pit alias is `/update`, which is the short word people actually
 * want, and it cannot shadow anything because nothing on PATH is called that.
 *
 * The plan is built separately from running it so the decisions — whether sudo
 * is needed, whether there are snaps to refresh at all — can be tested without
 * a machine to upgrade.
 */

export class SysUpdateError extends Error {}

export interface Step {
  /** What this step is for, in words, so the output is readable. */
  name: string;
  file: string;
  args: string[];
}

export interface Plan {
  steps: Step[];
  /** Why something is *not* in the list. Silence about a skip reads as a bug. */
  notes: string[];
}

export interface PlanOptions {
  /** Answer apt's prompts with yes. */
  yes?: boolean;
  /** Refresh snaps too, when snapd is installed. Default true. */
  snap?: boolean;
  /** The caller's uid. 0 means the privileges are already in hand. */
  uid?: number;
  /** Is this name on PATH? Injected so the plan can be tested anywhere. */
  has?: (name: string) => boolean;
}

/**
 * What updating this box actually involves.
 *
 * Throws when there is no apt, rather than running the first two steps of a
 * three step plan on a machine this was never meant for.
 */
export function planSteps(options: PlanOptions = {}): Plan {
  const {
    yes = false,
    snap = true,
    uid = typeof process.getuid === 'function' ? process.getuid() : 0,
    has = (name: string) => onPath(name),
  } = options;

  if (!has('apt')) {
    throw new SysUpdateError('no apt here — sysupdate updates Debian and Ubuntu boxes');
  }

  // Root already has the privileges, and a minimal image may not even have
  // sudo on it. Asking for it there fails for a reason that has nothing to do
  // with updating anything, which is the worst kind of error message.
  const lift = (file: string, args: string[]): Pick<Step, 'file' | 'args'> =>
    uid === 0 ? { file, args } : { file: 'sudo', args: [file, ...args] };

  const steps: Step[] = [
    { name: 'refresh the package lists', ...lift('apt', ['update']) },
    // `apt upgrade`, not `apt-get upgrade`. They are not the same command:
    // apt installs a package that needs a new dependency, apt-get holds it
    // back. That difference is how kernels and security updates quietly never
    // land on a box someone believes is current — the same trap root-ubuntu.sh
    // works around with `apt-get --with-new-pkgs`.
    { name: 'upgrade the packages', ...lift('apt', yes ? ['upgrade', '-y'] : ['upgrade']) },
  ];

  const notes: string[] = [];

  if (!snap) {
    notes.push('snaps not refreshed (--no-snap)');
  } else if (has('snap')) {
    steps.push({ name: 'refresh the snaps', ...lift('snap', ['refresh']) });
  } else {
    // Plenty of boxes have no snapd at all — containers, Debian, a trimmed
    // server image. That is not a failure, but it is worth saying so nobody
    // waits for a step that was never going to run.
    notes.push('no snapd on this box — nothing to refresh');
  }

  return { steps, notes };
}

/** The plan as the commands it will run, for --dry-run and for the log. */
export function formatPlan(plan: Plan): string {
  const lines = plan.steps.map((step) => `  ${step.file} ${step.args.join(' ')}`);
  const notes = plan.notes.map((note) => `  (${note})`);
  return [...lines, ...notes].join('\n') + '\n';
}

export type Spawner = (file: string, args: readonly string[]) => Promise<number>;

/**
 * Run a child with our own stdio.
 *
 * Inherited rather than captured, because both halves of this need a terminal:
 * sudo prompts for a password on one, and apt draws progress on the other.
 * Capturing the output would hang on the password prompt with nothing on
 * screen to explain why.
 */
export const inheritSpawner: Spawner = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: 'inherit' });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new SysUpdateError(`command not found: ${file}`)
          : error,
      );
    });
    // A child killed by a signal has a null code; report it as a failure
    // rather than as the success that `?? 0` would quietly produce.
    child.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });

export interface RunPlanOptions {
  spawner?: Spawner;
  write?: (text: string) => void;
}

/**
 * Run the steps in order, stopping at the first failure.
 *
 * That is the `&&` the shell one-liner had: there is no point upgrading
 * against package lists that failed to refresh, and a snap refresh after a
 * broken apt run only buries the error further up the scrollback.
 *
 * Returns the exit status of whatever stopped it, or 0.
 */
export async function runPlan(plan: Plan, options: RunPlanOptions = {}): Promise<number> {
  const { spawner = inheritSpawner, write = (text) => process.stderr.write(text) } = options;

  for (const note of plan.notes) write(`sysupdate: ${note}\n`);

  for (const step of plan.steps) {
    write(`\n==> ${step.name}\n    ${step.file} ${step.args.join(' ')}\n`);
    const code = await spawner(step.file, step.args);
    if (code !== 0) {
      write(`\nsysupdate: ${step.name} failed (exit ${code}) — stopping here\n`);
      return code;
    }
  }

  return 0;
}

/**
 * Did the upgrade land something that only takes effect after a reboot?
 *
 * Worth saying at the end: a kernel or libc that has been replaced on disk is
 * not the one still running, and "I updated it" is exactly when people stop
 * thinking about it.
 */
export function rebootRequired(root = ''): string | null {
  const flag = `${root}/var/run/reboot-required`;
  if (!existsSync(flag)) return null;

  try {
    const packages = readFileSync(`${root}/var/run/reboot-required.pkgs`, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const unique = [...new Set(packages)];
    return unique.length > 0 ? unique.join(' ') : '';
  } catch {
    // The flag is the fact; the package list beside it is a nicety that a
    // permission or a missing file must not turn into a failed command.
    return '';
  }
}
