#!/usr/bin/env node
/**
 * rea — reverse engineer anything with agents (REA, github.com/morluto/rea).
 *
 * A launcher for the `rea-agents` npm package, not a reimplementation of it.
 * Everything you type is handed through untouched: `rea setup`, `rea doctor`,
 * `rea analyze <path>`, `rea mcp add`, `rea --help` for the rest.
 *
 * Ours, and therefore NOT passed through:
 *   --self-update   reinstall the latest release
 *   --self-where    say which copy would run, and from where
 *
 * src/rea.ts says why it is shaped like this.
 */

import { isMain } from '../src/is-main.ts';
import {
  NODE_RANGE,
  PACKAGE,
  install,
  installFailureMessage,
  meetsNodeRange,
  nodeRangeMessage,
  resolveRunner,
  spawnInherit,
  vendorRoot,
} from '../src/rea.ts';

const DESCRIBE: Record<string, string> = {
  env: 'REA_BIN',
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
        `node:   ${process.version}${meetsNodeRange(process.version) ? '' : ` (outside ${NODE_RANGE})`}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  const refreshing = argv[0] === '--self-update';
  const args = refreshing ? argv.slice(1) : argv;

  if (!meetsNodeRange(process.version)) {
    process.stderr.write(`${nodeRangeMessage(process.version)}\n`);
  }

  let file = runner.file;

  if (refreshing || runner.kind === 'missing') {
    process.stderr.write(refreshing ? `rea: updating ${PACKAGE}…\n` : `rea: installing ${PACKAGE}…\n`);
    const result = await install();
    if (!result.ok) {
      process.stderr.write(`${installFailureMessage(result.manager, vendorRoot())}\n`);
      return 1;
    }
    file = result.bin;
    if (refreshing && args.length === 0) {
      process.stderr.write(`rea: up to date (${result.manager}) at ${result.bin}\n`);
      return 0;
    }
  }

  if (!file) {
    process.stderr.write(`${installFailureMessage('npm', vendorRoot())}\n`);
    return 1;
  }

  const code = await spawnInherit(file, args);
  if (code === null) {
    process.stderr.write(`rea: could not start ${file}\n  rea --self-update   # reinstall it\n`);
    return 1;
  }
  return code;
}

if (isMain(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
