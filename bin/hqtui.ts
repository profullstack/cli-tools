#!/usr/bin/env -S npx --yes tsx
/**
 * hqtui — the HQTUI system dashboard, on this box.
 *
 *   hqtui                    live metrics for this machine
 *   hqtui --sim              the deterministic simulation
 *   hqtui --screen traffic   open on a screen
 *   hqtui --help             upstream's CLI, so upstream's flags
 *   hqtui --self-update      refresh the installed dashboard
 *   hqtui --self-where       which copy runs, and from where
 *
 * Ten screens: system metrics, network traffic by protocol, HTTP requests read
 * from access logs, SSH activity, sessions, services, and the widget set. All
 * of it unprivileged; `sudo` additionally exposes socket process names, btmp,
 * access logs and the full journal.
 *
 * The dashboard is @profullstack/hqtui-demo, installed on first use into a
 * private prefix rather than globally. src/hqtui.ts says why.
 */

import {
  MIN_NODE,
  PACKAGE,
  install,
  meetsNodeFloor,
  resolveRunner,
  vendorBin,
} from '../src/hqtui.ts';
import { spawnInherit } from '../src/codeburn.ts';
import { isMain } from '../src/is-main.ts';


/**
 * The only two flags this wrapper keeps for itself.
 *
 * Spelled `--self-*` because every plain word belongs to the dashboard: it has
 * its own --help, --screen, --theme and --sim, and intercepting any of them
 * would mean this file drifting out of step with a tool it does not own.
 * Everything else is handed through untouched.
 */
const OURS = new Set(['--self-update', '--self-where']);

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((argument) => OURS.has(argument)));
  const rest = argv.filter((argument) => !OURS.has(argument));

  if (!meetsNodeFloor(process.versions.node)) {
    process.stderr.write(
      `hqtui: needs Node ${MIN_NODE} or newer (found ${process.version}).\n`,
    );
    return 1;
  }

  if (flags.has('--self-update')) {
    const spec = process.env.HQTUI_SPEC || `${PACKAGE}@latest`;
    process.stdout.write(`hqtui: installing ${spec}\n`);
    const result = await install(spec);
    if (!result.ok) {
      process.stderr.write('hqtui: could not install the dashboard.\n');
      return 1;
    }
    process.stdout.write(`hqtui: installed with ${result.manager}\n`);
    return 0;
  }

  let runner = resolveRunner();

  if (flags.has('--self-where')) {
    process.stdout.write(`${runner.file ?? '(not installed)'}\n`);
    return runner.file ? 0 : 1;
  }

  // First run on a box: install it, then run it. A monitor that says "not
  // found" on the machine you are trying to look at is not much use.
  if (runner.kind === 'missing') {
    const spec = process.env.HQTUI_SPEC || `${PACKAGE}@latest`;
    process.stderr.write(`hqtui: first run, installing ${spec}\n`);
    const result = await install(spec);
    if (!result.ok) {
      process.stderr.write(
        'hqtui: could not install the dashboard. Check the network, or run:\n' +
          `  npm install -g ${PACKAGE}\n`,
      );
      return 1;
    }
    runner = { kind: 'vendor', file: vendorBin() };
  }

  if (!runner.file) {
    process.stderr.write('hqtui: nothing to run.\n');
    return 1;
  }

  const code = await spawnInherit(runner.file, rest);
  if (code === null) {
    process.stderr.write(`hqtui: could not start ${runner.file}\n`);
    return 1;
  }
  return code;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`hqtui: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
