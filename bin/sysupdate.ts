#!/usr/bin/env -S npx --yes tsx
/**
 * sysupdate — bring this Debian/Ubuntu box up to date.
 *
 *   sysupdate            # apt update, apt upgrade, snap refresh
 *   sysupdate --yes      # ...without stopping to ask
 *   sysupdate --dry-run  # print what it would run, run nothing
 *
 * The pit calls it `/update`. It is not called `update` here because
 * `cli-tools update` already means "move this checkout to the current commit",
 * and one word cannot usefully mean both that and "upgrade the operating
 * system".
 */

import { UsageError, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { SysUpdateError, formatPlan, planSteps, rebootRequired, runPlan } from '../src/sysupdate.ts';

const USAGE = `Usage:
  sysupdate [--yes] [--no-snap] [--dry-run]

Updates this machine: apt update, then apt upgrade, then snap refresh.
Stops at the first step that fails rather than carrying on regardless.

Options:
  -y, --yes      answer apt's prompts with yes
      --no-snap  skip the snap refresh
  -n, --dry-run  print the commands, run none of them
  -h, --help     show this help

Runs each step through sudo unless you are already root, and skips the snap
step entirely on a box with no snapd. Says so afterwards if the upgrade needs
a reboot to take effect.
`;

if (isMain(import.meta.url)) {
  try {
    const { flags } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '-y', '--yes', '--no-snap', '-n', '--dry-run'],
    });

    if (flags.has('-h') || flags.has('--help')) {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    const plan = planSteps({
      yes: flags.has('-y') || flags.has('--yes'),
      snap: !flags.has('--no-snap'),
    });

    if (flags.has('-n') || flags.has('--dry-run')) {
      process.stdout.write(formatPlan(plan));
      process.exit(0);
    }

    const code = await runPlan(plan);

    if (code === 0) {
      const pending = rebootRequired();
      process.stderr.write('\nsysupdate: up to date\n');
      if (pending !== null) {
        process.stderr.write('sysupdate: a reboot is required for this to take effect\n');
        if (pending) process.stderr.write(`           ${pending}\n`);
      }
    }

    process.exit(code);
  } catch (error) {
    if (error instanceof UsageError || error instanceof SysUpdateError) {
      process.stderr.write(`sysupdate: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`sysupdate: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
