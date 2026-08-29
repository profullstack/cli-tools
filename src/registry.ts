import { accessSync, constants, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What this repository installs, and how the pit gets at it.
 *
 * The commands are real executables on PATH rather than shell functions,
 * because a file works from every caller — an interactive shell, `zsh -c`, a
 * systemd unit, a CI step — without anything having been sourced first. (The
 * older comment in scripts/install-links.mjs gives a stronger reason that has
 * since stopped being true: current moshcode runs `$SHELL -ic`, which is
 * interactive and does read ~/.zshrc.)
 *
 * The pit aliases below are therefore a convenience on top of PATH — a short
 * word for a longer invocation — never the mechanism that makes a command
 * reachable. None of them may share a name with a command: a shell function
 * beats PATH, so an alias of the same name silently shadows the file and the
 * two drift apart.
 */

export interface Command {
  name: string;
  summary: string;
}

/** One-line summaries, so `cli-tools list` says what each command is for. */
const SUMMARIES: Record<string, string> = {
  affiliate: 'Work through a list of programs you mean to sign up for',
  'ask-web': 'Answer a question from the live web, with its sources',
  'blog-post': 'Publish to a plain-HTML blog without breaking the feed',
  'cli-tools': 'This dispatcher: list, update and wire up the others',
  codeburn: 'See where your AI spend goes, by task, tool, model and project',
  dl: 'Download a video, or just its audio, through yt-dlp',
  domainfree: 'Which of these domains can you actually register',
  domainjson: 'whois-style, JSON-first name lookup',
  favicon: 'Every icon a site links, rendered from one SVG',
  'generate-names': 'Turn a sentence about a product into a thousand candidate names',
  genrewatch: 'What is coming out, and whether it exists at all',
  img: 'Resize, convert and inspect images, with sharp or ImageMagick',
  'gh-prs': 'Every open PR across the owners you name',
  'gh-prs-fix-all': 'Repair the open scan PRs that are broken because of us',
  'gh-prs-merge': 'Squash-merge the PRs that are genuinely ready',
  porkbun: 'Read and change DNS at Porkbun, and un-park a domain',
  shorten: 'Mint a short link on the pit, and follow it from /f/<code>',
  tcfeed: 'Find repositories worth scanning, scan them, print a shortlist',
  tts: 'Read text aloud and keep the audio',
  vid: 'Inspect, thumbnail, clip and shrink video, through ffmpeg',
};

/** The repository root, found from this file rather than from the cwd. */
export function repoRoot(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

/**
 * Every command this repository installs, read from bin/ rather than listed.
 *
 * A hardcoded list is a list that goes stale the moment somebody adds a tool —
 * which is the whole convention here: a new command is a new `bin/*.ts`, and
 * nothing else has to be edited for it to be installed.
 */
export function commands(root: string = repoRoot()): Command[] {
  return readdirSync(join(root, 'bin'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => entry.replace(/\.ts$/, ''))
    .sort()
    .map((name) => ({ name, summary: SUMMARIES[name] ?? '' }));
}

/** Is this name resolvable on PATH? Says nothing about *which* implementation. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return firstOnPath(name, env) !== null;
}

/**
 * Where this name resolves on PATH, or null.
 *
 * The same lookup as `onPath`, returning the path instead of a boolean, because
 * a companion that is installed somewhere unexpected is worth naming — "npm
 * says it installed it and it is not on your PATH" is a different problem from
 * "it is not installed".
 */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return firstOnPath(name, env);
}

/** The first executable of this name on PATH, or null. */
function firstOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable; keep looking.
    }
  }
  return null;
}

export type CommandStatus = 'ours' | 'other' | 'missing';

export interface Resolution {
  status: CommandStatus;
  /** What the name on PATH resolves to, once symlinks are followed. */
  target: string | null;
}

/**
 * Which implementation of a command is actually on PATH.
 *
 * "Is a file of this name on PATH" is the question that produces a misleading
 * answer, and it produced one here: several of these names (gh-prs,
 * gh-prs-merge, tcfeed, domainjson) also exist as the older hand-written
 * scripts they were ported from, so a bare presence check reported every one of
 * them installed while five were a different implementation with different
 * flags. `gh-prs-merge` is the one that matters — the older one repairs by
 * default under --apply and this one does not — so "installed" has to mean
 * "this checkout's copy", not "something answers to that name".
 *
 * The comparison follows symlinks on both sides, because the install *is* a
 * symlink and a repository path may itself sit behind one.
 */
export function resolveCommand(
  name: string,
  binDir: string = join(repoRoot(), 'bin'),
  env: NodeJS.ProcessEnv = process.env,
): Resolution {
  const found = firstOnPath(name, env);
  if (!found) return { status: 'missing', target: null };

  // A broken symlink still tells you where it meant to point, which is the
  // useful thing to print; realpath on it would throw and lose that.
  let target = found;
  try {
    target = realpathSync(found);
  } catch {
    // Leave it as the link path.
  }

  let ours = binDir;
  try {
    ours = realpathSync(binDir);
  } catch {
    // A checkout that has moved; the raw comparison below still works.
  }

  // The separator matters: without it a sibling directory whose name merely
  // starts the same way would read as ours.
  return { status: target.startsWith(ours + sep) ? 'ours' : 'other', target };
}

/**
 * The pit aliases this repository suggests.
 *
 * Deliberately thin, and deliberately not one per command: a command already on
 * PATH needs no alias to be typed in the pit. These are the abbreviations worth
 * having, and `merge` is the one with a flag baked in because the long form is
 * what everybody types anyway.
 *
 * Three of these are named around a collision rather than for elegance. `/ask`
 * and `/say` are the words you would reach for, and both already resolve to
 * something else on a normal box — and because a pit alias beats PATH, binding
 * them would shadow those programs from inside the pit only, which is about the
 * most confusing failure available. `/tts` is worse still: it would shadow our
 * own command. Hence `/web`, `/speak` and `/aff`.
 *
 * Keep them thin for a reason — `gh-prs-merge` repairs by default under
 * `--apply`, so baking `--fix` in as well is what once made `/merge --fix`
 * expand to `--apply --fix --fix`.
 */
export const PIT_ALIASES: Record<string, string> = {
  aff: 'affiliate',
  blog: 'blog-post',
  free: 'domainfree',
  merge: 'gh-prs-merge --apply',
  prs: 'gh-prs',
  speak: 'tts',
  web: 'ask-web',
  whois: 'domainjson',
};

/** Where the moshcode pit keeps its aliases. */
export function aliasesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.MOSHCODE_HOME ?? join(homedir(), '.moshcode'), 'aliases.json');
}

/**
 * Merge our aliases into whatever the pit already has.
 *
 * An existing name always wins. The file is the operator's, not ours: silently
 * repointing a word they bound themselves would be the kind of change nothing
 * surfaces until the wrong command runs.
 */
export function mergeAliases(
  existing: Record<string, string>,
  proposed: Record<string, string> = PIT_ALIASES,
): { merged: Record<string, string>; added: string[]; kept: string[] } {
  const merged = { ...existing };
  const added: string[] = [];
  const kept: string[] = [];

  for (const [name, value] of Object.entries(proposed)) {
    if (Object.hasOwn(existing, name)) {
      if (existing[name] !== value) kept.push(name);
      continue;
    }
    merged[name] = value;
    added.push(name);
  }

  return { merged, added: added.sort(), kept: kept.sort() };
}
