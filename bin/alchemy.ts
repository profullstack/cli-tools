#!/usr/bin/env node
/**
 * alchemy — Alchemy's CLI: onchain data, apps, agent wallets and x402.
 *
 * A launcher for the `@alchemy/cli` package, not a reimplementation of it.
 * Everything you type is handed through untouched, so upstream's docs
 * (https://www.alchemy.com/docs/alchemy-cli) are the docs:
 *
 *   alchemy auth                              link your account, pick an app
 *   alchemy evm data balance vitalik.eth      a balance, ENS names welcome
 *   alchemy evm gas                           current gas
 *   alchemy evm tx <hash>                     one transaction
 *   alchemy app list                          your Alchemy apps
 *   alchemy --json --no-interactive …         for scripts and agents
 *   alchemy --help                            all of it
 *
 * What this adds is that it is a command rather than a global install to
 * remember: installed on first use into a prefix of ours, refreshed when you
 * ask. src/alchemy.ts says why it never follows PATH back into itself.
 *
 * Ours, and therefore NOT passed through:
 *   --self-update   reinstall the latest release
 *   --self-where    say which copy would run, and from where
 */

import { isMain } from '../src/is-main.ts';
import { spawnInherit } from '../src/codeburn.ts';
import {
  PACKAGE,
  install,
  installFailureMessage,
  resolveRunner,
  vendorBin,
  vendorRoot,
} from '../src/alchemy.ts';

const DESCRIBE: Record<string, string> = {
  env: 'ALCHEMY_BIN',
  vendor: 'installed by cli-tools',
  path: 'already on PATH',
  missing: 'not installed yet',
};

/** Install, and say what happened. Shared by first run and every refresh. */
async function refresh(reason: string): Promise<string | null> {
  const spec = process.env.ALCHEMY_SPEC || `${PACKAGE}@latest`;
  process.stderr.write(`alchemy: ${reason} ${spec}\n`);

  const result = await install(spec);
  if (!result.ok) {
    process.stderr.write(`${installFailureMessage(vendorRoot())}\n`);
    if (result.note) process.stderr.write(`  ${result.note}\n`);
    return null;
  }

  process.stderr.write(
    `alchemy: installed ${result.version ?? ''} with ${result.manager}\n`.replace('  ', ' '),
  );
  return vendorBin();
}

async function main(argv: string[]): Promise<number> {
  const runner = resolveRunner();

  if (argv[0] === '--self-where') {
    process.stdout.write(
      [`${runner.file ?? '(none)'}  ${DESCRIBE[runner.kind]}`, `prefix: ${vendorRoot()}`, ''].join(
        '\n',
      ),
    );
    return 0;
  }

  const refreshing = argv[0] === '--self-update';
  const args = refreshing ? argv.slice(1) : argv;

  let file = runner.file;

  if (refreshing || runner.kind === 'missing') {
    file = await refresh(refreshing ? 'updating' : 'first run, installing');
    if (file === null) return 1;

    // A bare --self-update is a maintenance run, not a launch.
    if (refreshing && args.length === 0) return 0;
  }

  if (file === null) {
    process.stderr.write(`${installFailureMessage(vendorRoot())}\n`);
    return 1;
  }

  const code = await spawnInherit(file, args);
  if (code === null) {
    process.stderr.write(
      `alchemy: could not start ${file}\n  alchemy --self-update   # reinstall it\n`,
    );
    return 1;
  }
  return code;
}

if (isMain(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
