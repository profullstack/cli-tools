# cli-tools

Local command-line tools, in TypeScript, on PATH.

Ported from the bash and JavaScript originals in
[`profullstack/scripts`](https://github.com/profullstack/scripts). The point of
the port is not the language — it is the two things bash was making expensive:

- **Typed, validated responses.** Every `gh` call used to go through `jq -r` into
  a string compare. `jq -r '.mergeable'` on a response that never had the field
  prints the four characters `null`, which is not `MERGEABLE`, so a perfectly
  mergeable PR read as ineligible *for a reason nobody wrote*. Now an
  unrecognised field is named in an error instead of silently becoming a string.
- **Tests.** The originals had none. Verifying a change meant running it against
  live pull requests, which is a poor place to discover you were wrong.

## Commands

| Command | What it does |
| --- | --- |
| `gh-prs` | List every open PR across the owners you name |
| `gh-prs-merge` | Sweep open PRs and squash-merge the ones genuinely ready |
| `gh-prs-fix-all` | Fix the open threatcrush-scan PRs that are broken because of us |
| `tcfeed` | Find repositories worth scanning, scan them, print a shortlist |
| `domainjson` | whois-style, JSON-first name lookup |

## Install

```bash
pnpm install
pnpm link            # symlink bin/*.ts into ~/.local/bin
```

The names already exist in `~/.local/bin` pointing at `~/scripts/bin`, so a
plain run reports them as not-ours and changes nothing. To migrate:

```bash
node scripts/install-links.mjs --dry-run --force   # see what would move
node scripts/install-links.mjs --force             # take them over
```

`--force` takes over a *symlink*. A real file of the same name is still
refused — clobbering someone's actual binary to install a convenience is not a
trade a script gets to make on its own.

To go back:

```bash
pnpm unlink                                   # remove the ones we own
ln -sf ~/scripts/bin/gh-prs-merge ~/.local/bin/gh-prs-merge   # and so on
```

## Aliases must be real executables

These install as files on PATH rather than shell aliases or functions, and that
is load-bearing.

The moshcode pit runs its aliases with `zsh -c <command>`, and `zsh -c` is a
non-interactive shell: it reads neither `~/.zshrc` nor `~/.zsh_aliases`. A
function defined there is simply not there, so `/alias tcfeed "tcfeed"` in the
pit answered `command not found` while the identical word worked when typed at a
prompt. A file on PATH works from an interactive shell, from `zsh -c`, and from
the pit, because none of them have to have sourced anything first.

Nothing should alias *to* these either. A function beats PATH, so a wrapper of
the same name silently shadows the file and the two drift apart.

```
/alias prs        "gh-prs --orgs profullstack"
/alias merge      "gh-prs-merge --orgs profullstack --apply --fix"
/alias merge-dry  "gh-prs-merge --orgs profullstack"
/alias fixprs     "gh-prs-fix-all"
/alias feed       "tcfeed"
/alias whoisj     "domainjson"
```

## `gh-prs-merge --fix`

A skip is not always a verdict on the PR. Two PRs were once skipped as
`mergeStateStatus=UNSTABLE` purely because a check had not reported yet; nothing
was wrong with either, and both merged unchanged minutes later.

`--fix` repairs a repairable skip **once**, then judges the PR again against the
identical rules. It requires `--apply`, because every repair writes.

| Blocker | Repair |
| --- | --- |
| checks still running | Wait for them to settle, up to `--fix-wait` (default 600s) |
| `mergeStateStatus=BEHIND` | Ask GitHub to merge the base branch in |
| `mergeable=CONFLICTING` | Same request; succeeds when the base merely moved |

What it will not do is as much of the design:

- **A conflict GitHub declines to merge is left alone**, and the message it gave
  is printed as `FIXME`. Resolving one means choosing between two authors'
  intent, and a batch tool that guesses produces a merge nobody wrote and nobody
  reviewed.
- **A check that ran and failed is a result, not an obstacle.** Retrying until it
  passes is how a flaky suite becomes a green one that means nothing.
- **No `--admin`.** Branch protections stay enforced.

## Nothing under `bin/` does work at import time

Every entry point guards its side effects with `isMain(import.meta.url)`, and
anything worth testing lives in `src/`.

This is not decorative. A test that imported `bin/gh-prs-fix-all.ts` to reach one
pure function *ran the tool*: the suite went from 60ms to 93 seconds and swept
live pull requests with `--fix` implied. The guard and the `src/` split are both
that lesson.

The `realpath` in `isMain` matters too — these install as symlinks, so
`process.argv[1]` is the link while `import.meta.url` is its target. Comparing
them raw reports "imported" for every installed command, disabling all of them at
once.

## Development

```bash
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

Tests stub the subprocess layer rather than the network, so `gh` is never
invoked. The suite runs in well under a second; if it starts taking longer,
something is reaching the network that should not be.

## Differences from the originals

Deliberate, and small:

- `gh-prs` prints `No open PRs found.` instead of a bare header row.
- `gh-prs-merge` adds `fixed=` to its summary line.
- `domainjson` output is unchanged in structure; DNS answers arrive in
  round-robin order, so array ordering varies between runs of either version.
