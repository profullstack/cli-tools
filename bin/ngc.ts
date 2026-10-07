#!/usr/bin/env node
/**
 * ngc — NVIDIA's NGC CLI: the catalog, registry, models and containers.
 *
 * A launcher for NVIDIA's own binary, not a reimplementation of it. Everything
 * you type is handed through untouched, so upstream's docs
 * (https://docs.ngc.nvidia.com/cli/) are the docs:
 *
 *   ngc user who                              who the key belongs to
 *   ngc config current                        org, team and key source in use
 *   ngc registry model list 'nvidia/*'        models in the catalog
 *   ngc registry image list nvidia/*          container images
 *   ngc registry model download-version …     fetch a model
 *   ngc --format_type json …                  for scripts and agents
 *   ngc --help                                all of it
 *
 * What this adds: installed on first use from NVIDIA's zip, checked against
 * both of NVIDIA's published checksums, refreshed when you ask, and signed in
 * from the credential store when upstream has no key of its own.
 *
 * Ours, and therefore NOT passed through:
 *   --self-update   reinstall the latest release
 *   --self-where    say which copy would run, from where, and where its key comes from
 */

import { isMain } from '../src/is-main.ts';
import { spawnInherit } from '../src/codeburn.ts';
import { resolveCredentials } from '../src/credentials.ts';
import {
  childEnv,
  install,
  installFailureMessage,
  installedVersion,
  resolveRunner,
  vendorBin,
  vendorRoot,
} from '../src/ngc.ts';

const DESCRIBE: Record<string, string> = {
  env: 'NGC_BIN',
  vendor: 'installed by cli-tools',
  manual: 'installed by hand',
  path: 'already on PATH',
  missing: 'not installed yet',
};

const AUTH: Record<string, string> = {
  env: 'NGC_CLI_API_KEY in the environment',
  config: '~/.ngc/config (ngc config set)',
  credentials: 'NGC_API_KEY from cli-tools credentials',
  none: 'none: cli-tools config pull, or ngc config set',
};

/** Install, and say what happened. Shared by first run and every refresh. */
async function refresh(reason: string): Promise<string | null> {
  process.stderr.write(`ngc: ${reason} the NGC CLI\n`);
  const result = await install();
  if (!result.ok) {
    if (result.note) process.stderr.write(`${result.note}\n`);
    process.stderr.write(`${installFailureMessage(vendorRoot())}\n`);
    return null;
  }
  process.stderr.write(`ngc: installed ${result.version} (SHA256 and md5 tree verified)\n`);
  return vendorBin();
}

async function main(argv: string[]): Promise<number> {
  const runner = resolveRunner();
  const auth = childEnv(process.env, resolveCredentials(process.env));

  if (argv[0] === '--self-where') {
    const version = runner.kind === 'vendor' ? installedVersion() : null;
    process.stdout.write(
      [
        `${runner.file ?? '(none)'}  ${DESCRIBE[runner.kind]}${version ? ` ${version}` : ''}`,
        `prefix: ${vendorRoot()}`,
        `key: ${AUTH[auth.source]}`,
        '',
      ].join('\n'),
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

  // The child inherits process.env; the key goes in there and nowhere else.
  Object.assign(process.env, auth.add);
  const code = await spawnInherit(file, args);
  if (code === null) {
    process.stderr.write(`ngc: could not start ${file}\n  ngc --self-update   # reinstall it\n`);
    return 1;
  }
  return code;
}

if (isMain(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
