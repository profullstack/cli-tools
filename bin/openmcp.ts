#!/usr/bin/env node
/**
 * openmcp — the OpenMCP catalog from the terminal.
 *
 * A launcher for the `@logicsrc/openmcp` package, not a reimplementation of
 * it. Everything you type is handed through untouched, so upstream's docs are
 * the docs:
 *
 *   openmcp relays                     what openmcp.logicsrc.com lists
 *   openmcp find "fetch a page"        search every relay's tools
 *   openmcp call obscura.openmcp.logicsrc.com fetch_page '{"url":"https://example.com"}'
 *   openmcp add https://your.site      register a relay you operate
 *   openmcp probe https://your.site    what a catalog would find, without one
 *   openmcp serve                      run a catalog of your own
 *   openmcp --help                     all of it
 *
 * What this adds is that it is a command rather than an incantation: installed
 * on first use into a prefix of ours, refreshed when you ask, and never
 * fighting a global install for a name they both want. src/openmcp.ts says why
 * that last one is not hypothetical.
 *
 * Ours, and therefore NOT passed through:
 *   --self-update   reinstall the latest release
 *   --self-where    say which copy would run, and from where
 *
 * Both are spelled --self-* because every plain word is upstream's to use.
 *
 * The exception is `update`, `uninstall` and `where`, and only when the copy
 * that would run is the one we installed. Those three read a manifest written
 * by upstream's curl installer, which a copy npm put in our prefix does not
 * have, so upstream would answer "not installed by the installer" on a box
 * where this command installed it and works.
 */

import { isMain } from '../src/is-main.ts';
import { spawnInherit } from '../src/codeburn.ts';
import {
  MIN_NODE,
  PACKAGE,
  install,
  installFailureMessage,
  meetsNodeFloor,
  nodeFloorMessage,
  ownsInstallWord,
  removeVendor,
  resolveRunner,
  vendorBin,
  vendorRoot,
} from '../src/openmcp.ts';

const DESCRIBE: Record<string, string> = {
  env: 'OPENMCP_BIN',
  vendor: 'installed by cli-tools',
  path: 'already on PATH',
  missing: 'not installed yet',
};

/** Install, and say what happened. Shared by first run and every refresh. */
async function refresh(reason: string): Promise<string | null> {
  const spec = process.env.OPENMCP_SPEC || `${PACKAGE}@latest`;
  process.stderr.write(`openmcp: ${reason} ${spec}\n`);

  const result = await install(spec);
  if (!result.ok) {
    process.stderr.write(`${installFailureMessage(vendorRoot())}\n`);
    // An install that exited 0 and left the wrong version behind is the
    // confusing case, so the reason goes out rather than just the failure.
    if (result.note) process.stderr.write(`  ${result.note}\n`);
    return null;
  }

  process.stderr.write(
    `openmcp: installed ${result.version ?? ''} with ${result.manager}\n`.replace('  ', ' '),
  );
  return vendorBin();
}

async function main(argv: string[]): Promise<number> {
  const runner = resolveRunner();

  if (argv[0] === '--self-where') {
    process.stdout.write(
      [
        `${runner.file ?? '(none)'}  ${DESCRIBE[runner.kind]}`,
        `prefix: ${vendorRoot()}`,
        `node:   ${process.version}${meetsNodeFloor(process.version) ? '' : ` (below ${MIN_NODE})`}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  // `where` against a copy we installed. Answered with the same lines as
  // --self-where, because the honest answer to "where is it" is our prefix.
  if (ownsInstallWord(runner.kind, argv[0]) && argv[0] === 'where') {
    return main(['--self-where']);
  }

  if (ownsInstallWord(runner.kind, argv[0]) && argv[0] === 'uninstall') {
    if (!argv.includes('--yes')) {
      process.stdout.write(
        [
          `This will remove the copy cli-tools installed:`,
          `  ${vendorRoot()}`,
          '',
          'A catalog database you ran `openmcp serve` against is NOT touched.',
          '',
          'Run it for real with:  openmcp uninstall --yes',
          '',
        ].join('\n'),
      );
      return 0;
    }
    const removed = removeVendor();
    process.stdout.write(
      removed ? `Removed ${vendorRoot()}\n` : `Nothing to remove at ${vendorRoot()}\n`,
    );
    return 0;
  }

  const refreshing = argv[0] === '--self-update' || ownsInstallWord(runner.kind, argv[0]);
  const args = refreshing ? argv.slice(1) : argv;

  // The Node floor is a warning rather than a refusal. It is upstream's
  // constraint, it may move, and being wrong about it should not be the thing
  // that stops somebody using the tool.
  if (!meetsNodeFloor(process.version)) {
    process.stderr.write(`${nodeFloorMessage(process.version)}\n`);
  }

  let file = runner.file;

  if (refreshing || runner.kind === 'missing') {
    file = await refresh(refreshing ? 'updating' : 'first run, installing');
    if (file === null) return 1;

    // A bare `update` or `--self-update` is a maintenance run, not a launch.
    if (refreshing && args.length === 0) return 0;
  }

  if (file === null) {
    process.stderr.write(`${installFailureMessage(vendorRoot())}\n`);
    return 1;
  }

  const code = await spawnInherit(file, args);
  if (code === null) {
    process.stderr.write(
      `openmcp: could not start ${file}\n  openmcp --self-update   # reinstall it\n`,
    );
    return 1;
  }
  return code;
}

if (isMain(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
