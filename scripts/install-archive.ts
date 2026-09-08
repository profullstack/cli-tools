#!/usr/bin/env node
/**
 * Install an `archive` companion: download the vendor's release, unpack it
 * under `vendor/`, link the binaries it contains into the prefix.
 *
 *   node scripts/install-archive.ts adb            # install if it is missing
 *   node scripts/install-archive.ts adb --force    # reinstall, and take the name
 *
 * Why this exists at all. The other companion kinds hand the work to somebody
 * else's installer -- npm, `go install`, a project's own `curl | sh`. An
 * `archive` companion has no such thing: Google publishes platform-tools as a
 * zip on dl.google.com and nothing more. So the fetching, unpacking and
 * linking is ours to do, and it is one script rather than a shell line built
 * up inside `companions.ts` so that it can be read, and so the careful parts
 * below are somewhere a person will find them.
 *
 * The careful parts, all of them about not being destructive on a machine that
 * was working before this ran:
 *
 *   An `adb` already on PATH from somewhere else -- apt's, or the one inside an
 *   Android Studio SDK -- is left alone. Ours would shadow it or not depending
 *   on the order of PATH, which is the worst of both. `--force` is the way to
 *   say you meant it, and it says out loud what it is now shadowing.
 *
 *   A real file in the prefix is never overwritten, `--force` or not. That is
 *   the same trade `install-links.mjs` refuses to make: clobbering someone's
 *   actual binary to install a convenience.
 *
 *   The unpacked tree lands beside the old one and is swapped in at the end,
 *   so a failed download leaves the working install where it was.
 *
 * There is no checksum to verify, and that is worth stating plainly rather than
 * quietly skipping: Google publishes `platform-tools-latest-<os>.zip` with no
 * checksum file beside it, and the sums in the SDK repository manifest are for
 * the versioned artefacts, not this alias. So the guarantee here is TLS to
 * dl.google.com, and the sha256 of what actually landed is printed -- which is
 * what lets two boxes be compared, or one be recorded, after the fact.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { archiveUrl, findCompanion, type Companion } from '../src/companions.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const prefix = process.env.CLI_TOOLS_PREFIX ?? join(homedir(), '.local', 'bin');

function die(message: string): never {
  process.stderr.write(`install-archive: ${message}\n`);
  process.exit(1);
}

/** Where the command of this name lives, if anywhere. */
function onPath(name: string): string | null {
  // `command -v` is a shell builtin, so this needs a shell -- but as an
  // argument to `sh -c`, never concatenated into one. Node 22 deprecates
  // `shell: true` with args for exactly that reason.
  const found = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
  const line = (found.stdout ?? '').trim().split('\n')[0]?.trim();
  return found.status === 0 && line ? line : null;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A link of ours is one already pointing into this checkout's `vendor/`. */
function isOurLink(path: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return resolve(dirname(path), readlinkSync(path)).startsWith(join(repoRoot, 'vendor'));
  } catch {
    return false;
  }
}

async function download(url: string, to: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) die(`${url} answered ${response.status} ${response.statusText}`);
  const body = Buffer.from(await response.arrayBuffer());
  writeFileSync(to, body);
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Unpack, with whatever the box has.
 *
 * Node cannot read a zip, so this shells out. `unzip` is the one Debian and
 * macOS both have; `bsdtar` is the fallback because a minimal container often
 * has it and nothing else, and it reads zips as happily as tarballs.
 */
function extract(archive: string, into: string): void {
  mkdirSync(into, { recursive: true });
  const zipped = /\.zip$/i.test(archive);
  const attempts: Array<{ command: string; args: string[] }> = zipped
    ? [
        { command: 'unzip', args: ['-q', archive, '-d', into] },
        { command: 'bsdtar', args: ['-xf', archive, '-C', into] },
      ]
    : [{ command: 'tar', args: ['-xzf', archive, '-C', into] }];

  const tried: string[] = [];
  for (const { command, args } of attempts) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (!result.error && result.status === 0) return;
    tried.push(
      result.error
        ? `${command} is not installed`
        : `${command} exited ${result.status}: ${(result.stderr ?? '').trim().split('\n').at(-1) ?? ''}`,
    );
  }
  die(`could not unpack ${archive} — ${tried.join('; ')}`);
}

/** The version string a freshly linked binary reports, for the closing line. */
function version(binary: string): string {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return '';
  return ((result.stdout ?? '') + (result.stderr ?? '')).trim().split('\n')[0]?.trim() ?? '';
}

function link(from: string, to: string): void {
  if (existsSync(to) || isSymlink(to)) {
    if (!isSymlink(to)) {
      // Someone's real binary. Never taken over, and not a reason to fail the
      // rest: the download worked and the file is in `vendor/` either way.
      process.stderr.write(`  SKIP  ${to} — is a real file, left alone\n`);
      return;
    }
    unlinkSync(to);
  }
  symlinkSync(from, to);
  process.stdout.write(`  ${to} -> ${from}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const name = args.find((arg) => !arg.startsWith('-'));
  if (!name) die('usage: install-archive.ts <companion> [--force]');

  const companion: Companion | null = findCompanion(name);
  if (!companion) die(`no companion called ${name}`);
  if (companion.install.kind !== 'archive') {
    die(`${companion.name} is ${companion.install.kind === 'npm' ? 'an npm' : `a ${companion.install.kind}`} companion, not an archive one`);
  }

  const url = archiveUrl(companion);
  if (!url) {
    // Not an error in the abstract, but an error for this box, and saying so
    // beats a zero exit that installs nothing. On Windows the answer is
    // Android Studio's SDK Manager, which the summary points at.
    die(`no ${companion.name} build for ${process.platform} — see ${companion.home}`);
  }

  const { dir, bins } = companion.install;
  const vendor = join(repoRoot, 'vendor');
  const destination = join(vendor, dir);

  const existing = onPath(companion.name);
  if (existing && !force && !isOurLink(existing)) {
    process.stdout.write(`${companion.name} already on PATH at ${existing} — left alone.\n`);
    return;
  }
  if (existing && !force && isOurLink(existing) && existsSync(destination)) {
    process.stdout.write(`${companion.name} already installed at ${destination}.\n`);
    return;
  }
  if (existing && force && !isOurLink(existing)) {
    // --force said to install anyway. Whether ours then wins is a question
    // about the order of PATH, which this cannot answer and should not
    // pretend to, so it names the other one rather than claiming a takeover.
    process.stdout.write(
      `${companion.name} is also at ${existing}; ours is used only where ${prefix} comes first on PATH.\n`,
    );
  }

  // Staged inside `vendor/` rather than in $TMPDIR, because the last step is a
  // rename and a rename does not cross filesystems: /tmp is a tmpfs on most of
  // these boxes while the checkout is on disk, which would make the swap fail
  // exactly where it matters. `vendor/` is gitignored, so the staging
  // directory is invisible to git even if a crash leaves one behind.
  mkdirSync(vendor, { recursive: true });
  const staging = mkdtempSync(join(vendor, '.staging-'));
  try {
    const archive = join(staging, url.split('/').at(-1) || 'archive.zip');
    process.stdout.write(`Downloading ${url}\n`);
    const sha256 = await download(url, archive);
    extract(archive, join(staging, 'unpacked'));

    const unpacked = join(staging, 'unpacked', dir);
    if (!existsSync(unpacked)) die(`${archive} did not contain a ${dir}/ directory`);

    // Beside the old one first, so a half-written tree never replaces a
    // working install: the swap below is the only moment either is missing.
    const incoming = `${destination}.incoming`;
    rmSync(incoming, { recursive: true, force: true });
    renameSync(unpacked, incoming);
    rmSync(destination, { recursive: true, force: true });
    renameSync(incoming, destination);

    mkdirSync(prefix, { recursive: true });
    for (const bin of bins) {
      const binary = join(destination, bin);
      if (!existsSync(binary)) {
        process.stderr.write(`  SKIP  ${bin} — not in the archive\n`);
        continue;
      }
      chmodSync(binary, 0o755);
      link(binary, join(prefix, bin));
    }

    const reported = version(join(destination, bins[0] ?? companion.name));
    process.stdout.write(`${companion.name}: ${reported || 'installed'}\n`);
    process.stdout.write(`  sha256 ${sha256}\n`);

    if (!process.env.PATH?.split(':').includes(prefix)) {
      process.stderr.write(`  WARN: ${prefix} is not on PATH. Add it:\n    export PATH="${prefix}:$PATH"\n`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

await main();
