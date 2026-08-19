import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  'blog-post': 'Publish to a plain-HTML blog without breaking the feed',
  'cli-tools': 'This dispatcher: list, update and wire up the others',
  domainfree: 'Which of these domains can you actually register',
  domainjson: 'whois-style, JSON-first name lookup',
  'gh-prs': 'Every open PR across the owners you name',
  'gh-prs-fix-all': 'Repair the open scan PRs that are broken because of us',
  'gh-prs-merge': 'Squash-merge the PRs that are genuinely ready',
  tcfeed: 'Find repositories worth scanning, scan them, print a shortlist',
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

/** Is this name resolvable on PATH? */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not here; keep looking.
    }
  }
  return false;
}

/**
 * The pit aliases this repository suggests.
 *
 * Deliberately thin, and deliberately not one per command: a command already on
 * PATH needs no alias to be typed in the pit. These are the abbreviations worth
 * having, and `merge` is the one with a flag baked in because the long form is
 * what everybody types anyway.
 *
 * Keep them thin for a reason — `gh-prs-merge` repairs by default under
 * `--apply`, so baking `--fix` in as well is what once made `/merge --fix`
 * expand to `--apply --fix --fix`.
 */
export const PIT_ALIASES: Record<string, string> = {
  blog: 'blog-post',
  free: 'domainfree',
  merge: 'gh-prs-merge --apply',
  prs: 'gh-prs',
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
