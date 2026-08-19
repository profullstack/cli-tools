#!/usr/bin/env -S npx --yes tsx
/**
 * cli-tools — the front door to everything else in this repository.
 *
 * It exists so the whole set has one name. `moshcode install cli-tools` looks
 * for a binary called `cli-tools` to decide whether the tool is present, and
 * the pit passes `/cli-tools …` straight through to it, so a single command
 * covers install status, updates, and reaching any of the others.
 *
 *   cli-tools list                 what is installed, and what is on PATH
 *   cli-tools update               pull and relink
 *   cli-tools link [--force]       symlink the commands into ~/.local/bin
 *   cli-tools unlink               remove the ones we own
 *   cli-tools aliases [--install]  the moshcode pit aliases
 *   cli-tools <command> [args…]    run one of the commands directly
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseArgs, UsageError } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  aliasesPath,
  commands,
  mergeAliases,
  PIT_ALIASES,
  repoRoot,
  resolveCommand,
} from '../src/registry.ts';

const USAGE = `Usage:
  cli-tools list
  cli-tools update
  cli-tools link [--force]
  cli-tools unlink
  cli-tools aliases [--install]
  cli-tools <command> [args…]

Commands:
  list      Every command here, and whether it is on PATH
  update    git pull, reinstall dependencies, relink
  link      Symlink the commands into ~/.local/bin
  unlink    Remove the symlinks we own
  aliases   Print the moshcode pit aliases, or write them with --install
  where     Print the checkout this command is running from

Options:
  --force   link: take over a symlink owned by another checkout
  --install aliases: merge them into ~/.moshcode/aliases.json
  --json    list/aliases: machine-readable
  -h, --help
`;

const SPEC = {
  boolean: ['--force', '--install', '--json', '-h', '--help'],
  string: [],
} as const;

function runLinks(root: string, args: readonly string[]): number {
  const script = join(root, 'scripts', 'install-links.mjs');
  return spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' }).status ?? 1;
}

/** Pull and relink. Dependencies come first so a new one is present before use. */
function update(root: string): number {
  const git = spawnSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
  if (git.status !== 0) {
    process.stderr.write(
      'update: git pull failed. A dirty tree or a diverged branch stops this on purpose —\n' +
        `        nothing here discards your work. Sort it out in ${root} and retry.\n`,
    );
    return git.status ?? 1;
  }

  const pnpm = spawnSync('pnpm', ['install', '--silent'], { cwd: root, stdio: 'inherit' });
  if (pnpm.error) {
    const npm = spawnSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (npm.status !== 0) return npm.status ?? 1;
  } else if (pnpm.status !== 0) {
    return pnpm.status ?? 1;
  }

  return runLinks(root, []);
}

function writeAliases(): number {
  const path = aliasesPath();
  let existing: Record<string, string> = {};

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, string>;
    }
  } catch (error) {
    // A missing file is the first-run case. Anything else means the pit has a
    // file we would be overwriting blind, and its aliases are the operator's.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`aliases: ${path} exists but is not readable JSON — not touching it.\n`);
      return 1;
    }
  }

  const { merged, added, kept } = mergeAliases(existing);

  if (added.length === 0) {
    process.stdout.write(`aliases: nothing to add — ${path} is already up to date.\n`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    // 0600 to match how the pit writes it: an alias list is a working habit.
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`aliases: added ${added.join(', ')} to ${path}\n`);
  }

  for (const name of kept) {
    process.stdout.write(
      `aliases: kept your own "${name}" (${existing[name]}) — ours would have been "${PIT_ALIASES[name]}"\n`,
    );
  }

  process.stdout.write('\nThe pit re-reads the file on every lookup, so an open pit has them now.\n');
  return 0;
}

export async function run(argv: readonly string[]): Promise<number> {
  // The first word is the command, and everything after it belongs to that
  // command — parsed here only for our own verbs, and passed through untouched
  // for the others. Parsing the whole line up front would mean this dispatcher
  // had to know every flag every tool accepts, and would reject the ones it
  // did not.
  const command = argv[0];
  const rest = argv.slice(1);
  const root = repoRoot();

  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  // Anything that is not one of ours is one of the commands: pass it straight
  // through, arguments and streams untouched, so `cli-tools gh-prs --orgs x`
  // behaves exactly as `gh-prs --orgs x` does.
  const known = new Set(['list', 'update', 'link', 'unlink', 'aliases', 'where']);
  if (!known.has(command)) {
    const match = commands(root).find((entry) => entry.name === command);
    if (!match) {
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
    }
    const script = join(root, 'bin', `${match.name}.ts`);
    return spawnSync(script, rest, { stdio: 'inherit' }).status ?? 1;
  }

  let options;
  try {
    options = parseArgs(rest, SPEC);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  switch (command) {
    case 'where':
      process.stdout.write(`${root}\n`);
      return 0;

    case 'list': {
      const binDir = join(root, 'bin');
      const all = commands(root).map((entry) => ({
        ...entry,
        ...resolveCommand(entry.name, binDir),
      }));

      if (options.flags.has('--json')) {
        process.stdout.write(`${JSON.stringify({ root, commands: all }, null, 2)}\n`);
        return 0;
      }

      process.stdout.write(`${root}\n\n`);
      for (const entry of all) {
        const mark = entry.status === 'ours' ? '*' : entry.status === 'other' ? '!' : ' ';
        process.stdout.write(`${mark} ${entry.name.padEnd(16)} ${entry.summary}\n`);
        // Naming the file is the whole point of the ! row: without it you know
        // something else answers to the name but not what, and the next step is
        // a `readlink` you should not have had to think of.
        if (entry.status === 'other') {
          process.stdout.write(`${' '.repeat(19)}↳ on PATH: ${entry.target}\n`);
        }
      }

      const other = all.filter((entry) => entry.status === 'other');
      const missing = all.filter((entry) => entry.status === 'missing');

      process.stdout.write('\n');
      if (other.length === 0 && missing.length === 0) {
        process.stdout.write('All running from this checkout.\n');
        return 0;
      }

      process.stdout.write(
        `${all.length - other.length - missing.length} of ${all.length} running from this checkout.\n`,
      );
      if (missing.length > 0) {
        process.stdout.write(`${missing.length} not on PATH — run \`cli-tools link\`.\n`);
      }
      if (other.length > 0) {
        process.stdout.write(
          `${other.length} shadowed by another implementation (!). \`cli-tools link --force\`\n` +
            'takes over a symlink; a real file of that name is refused either way.\n' +
            'Check the flags first — a port does not always keep the original defaults.\n',
        );
      }
      return 0;
    }

    case 'update':
      return update(root);

    case 'link':
      return runLinks(root, options.flags.has('--force') ? ['--force'] : []);

    case 'unlink':
      return runLinks(root, ['--remove']);

    case 'aliases': {
      if (options.flags.has('--install')) return writeAliases();
      if (options.flags.has('--json')) {
        process.stdout.write(`${JSON.stringify(PIT_ALIASES, null, 2)}\n`);
        return 0;
      }
      process.stdout.write(`Suggested moshcode pit aliases (${aliasesPath()}):\n\n`);
      for (const [name, value] of Object.entries(PIT_ALIASES)) {
        process.stdout.write(`  /${name.padEnd(8)} ${value}\n`);
      }
      process.stdout.write('\nWrite them with `cli-tools aliases --install`.\n');
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
