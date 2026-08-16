#!/usr/bin/env node
/**
 * Symlink every bin/*.ts into ~/.local/bin, without the .ts suffix.
 *
 * Real executables on PATH, deliberately, and not shell aliases or functions.
 * The moshcode pit runs its aliases with `zsh -c <command>`, and `zsh -c` is a
 * non-interactive shell: it reads neither ~/.zshrc nor ~/.zsh_aliases. A
 * function defined there is simply not there, so `/alias tcfeed "tcfeed"`
 * answered `command not found` while the identical word worked when typed at a
 * prompt. A file on PATH works from an interactive shell, from `zsh -c`, and
 * from the pit, because none of them have to have sourced anything first.
 *
 *   node scripts/install-links.mjs            # link
 *   node scripts/install-links.mjs --dry-run  # say what it would do
 *   node scripts/install-links.mjs --force    # take over links owned elsewhere
 *   node scripts/install-links.mjs --remove   # unlink the ones we own
 *
 * These names already exist in ~/.local/bin pointing at ~/scripts/bin, so a
 * plain run reports them as not-ours and changes nothing. --force takes over a
 * *symlink*; a real file of that name is still refused, because clobbering
 * someone's actual binary to install a convenience is not a trade this gets to
 * make on its own.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const binDir = join(repoRoot, 'bin');
const target = process.env.CLI_TOOLS_PREFIX ?? join(homedir(), '.local', 'bin');

const dryRun = process.argv.includes('--dry-run');
const remove = process.argv.includes('--remove');
const force = process.argv.includes('--force');

const commands = readdirSync(binDir)
  .filter((entry) => entry.endsWith('.ts'))
  .map((entry) => ({ name: entry.replace(/\.ts$/, ''), source: join(binDir, entry) }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (commands.length === 0) {
  console.error('install-links: no bin/*.ts found');
  process.exit(1);
}

if (!dryRun) mkdirSync(target, { recursive: true });

let changed = 0;
let skipped = 0;

for (const { name, source } of commands) {
  const link = join(target, name);
  const existing = existsSync(link) || isBrokenLink(link);

  // Only ever touch a symlink that points into this repository. A real file of
  // the same name is someone else's, and clobbering it to install a
  // convenience is not a trade this script gets to make.
  const ours = existing && isLinkInto(link, binDir);

  if (remove) {
    if (!existing) continue;
    if (!ours) {
      console.warn(`SKIP  ${link} — not a link into ${binDir}`);
      skipped += 1;
      continue;
    }
    console.log(`${dryRun ? 'WOULD-UNLINK' : 'UNLINK'} ${link}`);
    if (!dryRun) unlinkSync(link);
    changed += 1;
    continue;
  }

  if (existing && !ours) {
    // A real file is never taken over, --force or not.
    if (!force || !isSymlink(link)) {
      console.warn(
        `SKIP  ${link} — ${isSymlink(link) ? 'points elsewhere; use --force' : 'is a real file'}`,
      );
      skipped += 1;
      continue;
    }
    console.log(`TAKEOVER ${link} — was -> ${readlinkSync(link)}`);
  }

  if (existing && readlinkSync(link) === source) {
    continue;
  }

  console.log(`${dryRun ? 'WOULD-LINK' : 'LINK'} ${link} -> ${source}`);
  if (!dryRun) {
    if (existing) unlinkSync(link);
    // The shebang only runs if the target is executable.
    chmodSync(source, 0o755);
    symlinkSync(source, link);
  }
  changed += 1;
}

console.log(
  `\n${remove ? 'Unlinked' : 'Linked'} ${changed} command(s) in ${target}` +
    (skipped ? `, skipped ${skipped}` : ''),
);

if (!remove && !process.env.PATH?.split(':').includes(target)) {
  console.warn(`\nWARN: ${target} is not on PATH. Add it:\n  export PATH="${target}:$PATH"`);
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isBrokenLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isLinkInto(path, directory) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return resolve(dirname(path), readlinkSync(path)).startsWith(directory);
  } catch {
    return false;
  }
}
