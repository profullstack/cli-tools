#!/usr/bin/env -S npx --yes tsx
/**
 * codeburn — see where your AI spend goes, by task, tool, model and project.
 *
 * A launcher for the `codeburn` npm package, not a reimplementation of it.
 * Everything you type is handed through untouched, so the upstream docs are the
 * docs: `codeburn` alone opens the dashboard, `codeburn overview` prints the
 * month, `codeburn optimize` hunts waste, `codeburn --help` lists the rest.
 *
 * What this adds is that it is a command rather than an incantation: installed
 * on first use into a prefix of ours, refreshed when you ask, and never
 * fighting a global install for the name. src/codeburn.ts says why.
 *
 * Ours, and therefore NOT passed through:
 *   --self-update   reinstall the latest release
 *   --self-where    say which copy would run, and from where
 *
 * Both are spelled --self-* because every plain word is upstream's to use.
 */

import { isMain } from '../src/is-main.ts';
import {
  MIN_NODE,
  PACKAGE,
  install,
  installFailureMessage,
  meetsNodeFloor,
  nodeFloorMessage,
  resolveRunner,
  spawnInherit,
  vendorRoot,
} from '../src/codeburn.ts';

const DESCRIBE: Record<string, string> = {
  env: 'CODEBURN_BIN',
  vendor: 'installed by cli-tools',
  path: 'already on PATH',
  missing: 'not installed yet',
};

async function main(argv: string[]): Promise<number> {
  const runner = resolveRunner();

  if (argv[0] === '--self-where') {
    process.stdout.write(
      [
        `${runner.file ?? '(none)'}  — ${DESCRIBE[runner.kind]}`,
        `prefix: ${vendorRoot()}`,
        `node:   ${process.version}${meetsNodeFloor(process.version) ? '' : ` (below ${MIN_NODE})`}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  const refreshing = argv[0] === '--self-update';
  const args = refreshing ? argv.slice(1) : argv;

  // The Node floor is a warning rather than a refusal. It is upstream's
  // constraint, it may move, and being wrong about it should not be the thing
  // that stops somebody using the tool.
  if (!meetsNodeFloor(process.version)) {
    process.stderr.write(`${nodeFloorMessage(process.version)}\n`);
  }

  let file = runner.file;

  if (refreshing || runner.kind === 'missing') {
    process.stderr.write(
      refreshing ? `codeburn: updating ${PACKAGE}…\n` : `codeburn: installing ${PACKAGE}…\n`,
    );
    const result = await install();
    if (!result.ok) {
      process.stderr.write(`${installFailureMessage(result.manager, vendorRoot())}\n`);
      return 1;
    }
    file = result.bin;
    // A bare `--self-update` is a maintenance run, not a launch.
    if (refreshing && args.length === 0) {
      process.stderr.write(`codeburn: up to date (${result.manager}) at ${result.bin}\n`);
      return 0;
    }
  }

  if (!file) {
    process.stderr.write(`${installFailureMessage('npm', vendorRoot())}\n`);
    return 1;
  }

  const code = await spawnInherit(file, args);
  if (code === null) {
    process.stderr.write(
      `codeburn: could not start ${file}\n  codeburn --self-update   # reinstall it\n`,
    );
    return 1;
  }
  return code;
}

if (isMain(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
