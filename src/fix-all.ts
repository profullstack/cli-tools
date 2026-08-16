/**
 * The parts of `gh-prs-fix-all` that are decisions rather than side effects.
 *
 * They live here, and not in `bin/`, for a reason that cost a real test run to
 * learn: a `bin/` entry point does its work at import time, so a test that
 * imported it to reach one pure function *ran the tool*. The suite went from
 * 60ms to 93 seconds and swept live pull requests with `--fix` implied.
 *
 * Nothing under `bin/` should export anything a test wants. If a function is
 * worth testing, it belongs here.
 */

/**
 * Refuse a checkout that predates the `check` subcommand.
 *
 * tcfeed reads its first argument as a post count and falls back to 50 when it
 * is not a number, so an older script answers `check` by fetching reddit and
 * scanning ten strangers' repositories — a long, rate-limited, entirely wrong
 * thing to do in response to "fix my pull requests".
 */
export function hasCheckSubcommand(source: string): boolean {
  return source.includes("argument === 'check'");
}

/**
 * `check` reports and changes nothing; `--fix` makes it act.
 *
 * `--dry-run`/`-n` are consumed here rather than passed on, because reporting
 * is already what `check` does without `--fix`.
 */
export function buildArgs(argv: readonly string[]): string[] {
  const dryRun = argv.some((argument) => argument === '--dry-run' || argument === '-n');
  const passthrough = argv.filter(
    (argument) => argument !== '--dry-run' && argument !== '-n',
  );
  return ['check', ...passthrough, ...(dryRun ? [] : ['--fix'])];
}
