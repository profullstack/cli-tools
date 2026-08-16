#!/usr/bin/env -S npx --yes tsx
/**
 * tcfeed — read the newest posts on a subreddit, find the repositories they
 * link, scan each one, and print a shortlist worth reading.
 *
 *   tcfeed                              # the 50 newest posts
 *   tcfeed 100                          # more of them
 *   tcfeed --forget                     # look at everything again next time
 *   tcfeed pr owner/name [--dry-run]    # install the scan workflow
 *   tcfeed check [--fix]                # how are the open requests doing
 *
 * An executable rather than a shell function, and that is the whole point of
 * it. The moshcode pit runs its aliases with `zsh -c <command>`, and `zsh -c`
 * is a non-interactive shell: it reads neither ~/.zshrc nor ~/.zsh_aliases, so
 * a function defined there is simply not there. `/alias tcfeed "tcfeed"` in the
 * pit answered `command not found` while the identical word worked when typed
 * at a prompt.
 *
 * Nothing should alias to this either. A function beats PATH, so a wrapper of
 * the same name silently shadows this file and the two drift apart.
 *
 *   TCFEED_REPO   where threatcrush is checked out
 */

import { isMain } from '../src/is-main.ts';
import { launch } from '../src/tcfeed-launch.ts';

if (isMain(import.meta.url)) {
  process.exitCode = await launch('tcfeed', process.argv.slice(2));
}
