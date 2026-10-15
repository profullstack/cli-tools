#!/usr/bin/env node
/**
 * submitfleet — launch products on hundreds of directories, from the terminal.
 *
 *   submitfleet login              sign in through the browser (or: login --key KEY)
 *   submitfleet products list
 *   submitfleet catalog search ai
 *   submitfleet campaign status <id>
 *   submitfleet queue              submissions waiting for a person
 *   submitfleet mcp --stdio        the MCP server, signed in as you
 *   submitfleet --self-update      refresh the installed CLI
 *   submitfleet --self-where       which copy runs, and from where
 *
 * The CLI is @profullstack/submitfleet, installed on first use into a private
 * prefix rather than globally. src/submitfleet.ts says why: upstream's
 * executable has the same name as this wrapper.
 */

import {
  MIN_NODE,
  PACKAGE,
  hasToken,
  install,
  meetsNodeFloor,
  resolveRunner,
  vendorBin,
  wantsSelfUpdate,
} from '../src/submitfleet.ts';
import { spawnInherit } from '../src/codeburn.ts';
import { isMain } from '../src/is-main.ts';

/**
 * The only two flags this wrapper keeps for itself.
 *
 * Spelled `--self-*` because every plain word belongs to the CLI: it has
 * its own --help, --range, --who and --json, and intercepting any of them
 * would mean this file drifting out of step with a tool it does not own.
 */
const OURS = new Set(['--self-update', '--self-where']);


async function main(argv: string[]): Promise<number> {
  const wantsUpdate = wantsSelfUpdate(argv);
  const given = wantsUpdate ? argv.slice(1) : argv;

  const flags = new Set(given.filter((argument) => OURS.has(argument)));
  if (wantsUpdate) flags.add('--self-update');
  const rest = given.filter((argument) => !OURS.has(argument));

  if (!meetsNodeFloor(process.versions.node)) {
    process.stderr.write(
      `submitfleet: needs Node ${MIN_NODE} or newer (found ${process.version}).\n`,
    );
    return 1;
  }

  if (flags.has('--self-update')) {
    const spec = process.env.SUBMITFLEET_SPEC || `${PACKAGE}@latest`;
    process.stdout.write(`submitfleet: installing ${spec}\n`);
    const result = await install(spec);
    if (!result.ok) {
      process.stderr.write('submitfleet: could not install the CLI.\n');
      // An install that exited 0 and left the wrong version behind is the
      // confusing case, so the reason goes out rather than just the failure.
      if (result.note) process.stderr.write(`  ${result.note}\n`);
      return 1;
    }
    process.stdout.write(
      `submitfleet: installed ${result.version ?? ''} with ${result.manager}\n`.replace('  ', ' '),
    );
    return 0;
  }

  let runner = resolveRunner();

  if (flags.has('--self-where')) {
    process.stdout.write(`${runner.file ?? '(not installed)'}\n`);
    return runner.file ? 0 : 1;
  }

  // First run on a box: install it, then run it. A command that says "not
  // found" on the machine you are trying to look at is not much use.
  if (runner.kind === 'missing') {
    const spec = process.env.SUBMITFLEET_SPEC || `${PACKAGE}@latest`;
    process.stderr.write(`submitfleet: first run, installing ${spec}\n`);
    const result = await install(spec);
    if (!result.ok) {
      process.stderr.write(
        'submitfleet: could not install the CLI. Check the network, or run:\n' +
          `  npm install -g ${PACKAGE}\n`,
      );
      return 1;
    }
    runner = { kind: 'vendor', file: vendorBin() };
  }

  if (!runner.file) {
    process.stderr.write('submitfleet: nothing to run.\n');
    return 1;
  }

  // Said once, before handing over: without a sign-in the CLI falls back to a
  // local database, which is rarely what someone typing this on a box wants.
  const local = rest.includes('--local');
  if (!hasToken() && !local && !['login', 'help', '--help', '-h', 'version', 'init', 'serve', 'doctor'].includes(rest[0] ?? '')) {
    process.stderr.write(
      'submitfleet: not signed in, so this uses a local database. Run `submitfleet login`\n' +
        '  (or set SUBMITFLEET_API_KEY) to use your submitfleet.com account.\n',
    );
  }

  const args = rest.length === 0 ? ['help'] : rest;

  const code = await spawnInherit(runner.file, args);
  if (code === null) {
    process.stderr.write(`submitfleet: could not start ${runner.file}\n`);
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
      process.stderr.write(`submitfleet: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
