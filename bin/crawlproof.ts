#!/usr/bin/env node
/**
 * crawlproof — what the fleet costs and what it returns.
 *
 *   crawlproof                     the live dashboard, last day, humans
 *   crawlproof dashboard --range=1m
 *   crawlproof stats [site]        who arrived and from where, as text
 *   crawlproof dashboard --json    the same snapshot, for a script
 *   crawlproof --help              upstream's CLI, so upstream's flags
 *   crawlproof --self-update       refresh the installed dashboard
 *   crawlproof --self-where        which copy runs, and from where
 *
 * Five screens: ROI, Traffic, Ads, Money, Spend — traffic across every site on
 * the account, ad delivery, and the bank feed behind it. The money screens
 * need a CoinPay session; without one the rest still works.
 *
 * The dashboard is @profullstack/crawlproof, installed on first use into a
 * private prefix rather than globally. src/crawlproof.ts says why that matters
 * more here than elsewhere: upstream's executable has the same name as this
 * wrapper.
 */

import {
  MIN_NODE,
  PACKAGE,
  hasToken,
  install,
  meetsNodeFloor,
  resolveRunner,
  vendorBin,
} from '../src/crawlproof.ts';
import { spawnInherit } from '../src/codeburn.ts';
import { isMain } from '../src/is-main.ts';

/**
 * The only two flags this wrapper keeps for itself.
 *
 * Spelled `--self-*` because every plain word belongs to the dashboard: it has
 * its own --help, --range, --who and --json, and intercepting any of them
 * would mean this file drifting out of step with a tool it does not own.
 */
const OURS = new Set(['--self-update', '--self-where']);

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((argument) => OURS.has(argument)));
  const rest = argv.filter((argument) => !OURS.has(argument));

  if (!meetsNodeFloor(process.versions.node)) {
    process.stderr.write(
      `crawlproof: needs Node ${MIN_NODE} or newer (found ${process.version}).\n`,
    );
    return 1;
  }

  if (flags.has('--self-update')) {
    const spec = process.env.CRAWLPROOF_SPEC || `${PACKAGE}@latest`;
    process.stdout.write(`crawlproof: installing ${spec}\n`);
    const result = await install(spec);
    if (!result.ok) {
      process.stderr.write('crawlproof: could not install the dashboard.\n');
      return 1;
    }
    process.stdout.write(`crawlproof: installed with ${result.manager}\n`);
    return 0;
  }

  let runner = resolveRunner();

  if (flags.has('--self-where')) {
    process.stdout.write(`${runner.file ?? '(not installed)'}\n`);
    return runner.file ? 0 : 1;
  }

  // First run on a box: install it, then run it. A dashboard that says "not
  // found" on the machine you are trying to look at is not much use.
  if (runner.kind === 'missing') {
    const spec = process.env.CRAWLPROOF_SPEC || `${PACKAGE}@latest`;
    process.stderr.write(`crawlproof: first run, installing ${spec}\n`);
    const result = await install(spec);
    if (!result.ok) {
      process.stderr.write(
        'crawlproof: could not install the dashboard. Check the network, or run:\n' +
          `  npm install -g ${PACKAGE}\n`,
      );
      return 1;
    }
    runner = { kind: 'vendor', file: vendorBin() };
  }

  if (!runner.file) {
    process.stderr.write('crawlproof: nothing to run.\n');
    return 1;
  }

  // Said once, before handing over, because the failure it prevents is a 401
  // from inside a TUI — where there is no good place to explain anything.
  if (!hasToken()) {
    process.stderr.write(
      'crawlproof: no API token. Set CRAWLPROOF_TOKEN, or put {"token":"crp_…"}\n' +
        '  in ~/.crawlproof.json. Mint one at crawlproof.com under Social → API tokens.\n',
    );
  }

  // No subcommand is the dashboard: the reason to type this on a box is to
  // look at it, and `crawlproof` alone printing usage would be a step in the
  // way of the only thing most people want.
  const args = rest.length === 0 ? ['dashboard'] : rest;

  const code = await spawnInherit(runner.file, args);
  if (code === null) {
    process.stderr.write(`crawlproof: could not start ${runner.file}\n`);
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
      process.stderr.write(`crawlproof: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
