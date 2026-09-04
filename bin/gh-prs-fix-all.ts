#!/usr/bin/env node
/**
 * gh-prs-fix-all — look at every open threatcrush-scan pull request, and fix
 * the ones that are broken because of us.
 *
 *   gh-prs-fix-all                 # fix ours, report theirs, leave theirs alone
 *   gh-prs-fix-all --dry-run       # change nothing, just say what stands
 *   gh-prs-fix-all owner/name ...  # only these
 *
 * The name says fix-all and it will not fix all, which is deliberate. Pushing
 * the branch to a fork sets off whatever the upstream repo runs on push, so
 * their test suite goes red against a commit that only added files under
 * .github/. Those failures are reported and never touched. Failures in our own
 * workflow that it does not recognise are printed rather than guessed at: a
 * speculative commit pushed onto a stranger's review is worse than red,
 * because red is at least honest.
 */

import { readFileSync } from 'node:fs';
import { isMain } from '../src/is-main.ts';
import { buildArgs, hasCheckSubcommand } from '../src/fix-all.ts';
import { launch, missingScriptMessage, resolveScript } from '../src/tcfeed-launch.ts';

async function main(argv: readonly string[]): Promise<number> {
  const { repo, script, exists } = resolveScript();

  if (!exists) {
    process.stderr.write(`${missingScriptMessage('gh-prs-fix-all', repo, script)}\n`);
    return 1;
  }

  if (!hasCheckSubcommand(readFileSync(script, 'utf8'))) {
    process.stderr.write(
      [
        `gh-prs-fix-all: ${script} has no \`check\` subcommand.`,
        `  git -C ${repo} pull      # it is on master, this checkout is behind`,
        '  Without this guard the old script would read `check` as a post',
        '  count, fall back to 50, and go scan reddit instead.',
        '',
      ].join('\n'),
    );
    return 1;
  }

  return launch('gh-prs-fix-all', buildArgs(argv));
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
