# cli-tools

Command-line tools for working across a lot of repositories at once, in
TypeScript, installed as executables on `PATH`.

| Command | What it does |
| --- | --- |
| [`gh-prs`](#gh-prs) | List every open PR across the owners you name |
| [`gh-prs-merge`](#gh-prs-merge) | Squash-merge the PRs that are genuinely ready |
| [`gh-prs-fix-all`](#gh-prs-fix-all) | Fix the open threatcrush-scan PRs that are broken because of us |
| [`tcfeed`](#tcfeed) | Find repositories worth scanning, scan them, print a shortlist |
| [`domainjson`](#domainjson) | whois-style, JSON-first name lookup |

## Requirements

- **Node 20+**
- **[`gh`](https://cli.github.com/)**, authenticated (`gh auth status`) — every
  `gh-prs*` command shells out to it
- **`dig`** at `/usr/bin/dig` — `domainjson` only
- **[OpenRDAP](https://github.com/openrdap/rdap)** (`rdap` on `PATH`, or
  `~/go/bin/rdap`) — `domainjson` only, and it degrades to DNS-only without it

## Install

```sh
git clone git@github.com:profullstack/cli-tools.git ~/src/profullstack/cli-tools
cd ~/src/profullstack/cli-tools
pnpm install
pnpm link:bin
```

`link:bin` symlinks every `bin/*.ts` into `~/.local/bin` without the extension,
so `gh-prs-merge` is a real command. (Not named `link` — that is a pnpm builtin,
and `pnpm link` would run pnpm's own command instead of this one.) Make sure the
directory is on `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### Migrating from `profullstack/scripts`

These names already exist in `~/.local/bin` pointing at `~/scripts/bin`, so a
plain `pnpm link:bin` reports them as not-ours and changes nothing. To take them
over:

```sh
node scripts/install-links.mjs --dry-run --force   # see exactly what would move
node scripts/install-links.mjs --force             # do it
```

`--force` replaces a *symlink*. A real file of the same name is still refused —
clobbering someone's actual binary to install a convenience is not a trade a
script gets to make on its own.

To go back:

```sh
pnpm unlink:bin                                               # remove ours
ln -sf ~/scripts/bin/gh-prs-merge ~/.local/bin/gh-prs-merge   # and so on
```

## Usage

### `gh-prs`

Lists open pull requests across any number of organizations and personal
accounts, newest first, as an aligned table. In a capable terminal the PR number
and URL become clickable.

```sh
gh-prs --orgs profullstack,moshcoder,h4kr,infernetprotocol
gh-prs --users ralyodio
gh-prs --orgs profullstack --users ralyodio --limit 50
gh-prs --orgs profullstack --no-links          # plain text, for piping
```

### `gh-prs-merge`

Walks the same scopes and squash-merges every PR that qualifies, oldest first.
**Dry run by default** — nothing changes until you pass `--apply`.

```sh
gh-prs-merge --orgs profullstack                      # report only
gh-prs-merge --orgs profullstack --apply              # merge what qualifies
gh-prs-merge --orgs profullstack --apply --fix        # repair, then merge
gh-prs-merge --orgs profullstack --apply --fix --fix-wait 900
```

A PR is merged only when all of these hold:

- it is open, and not a draft (or was successfully marked ready)
- `mergeable` is `MERGEABLE` and `mergeStateStatus` is `CLEAN`
- at least one CI check exists, unless `--allow-no-checks`
- every check is `pass` or `skipping`
- the head commit has not changed when the merge is submitted

That last one is the safety property. Between reading the checks and submitting
the merge, someone can push; `--match-head-commit` means the merge lands on the
commit that was actually verified or not at all. There is deliberately no
`--admin`, so branch protections stay enforced.

#### `--fix`

A skip is not always a verdict on the PR. Two were once skipped as
`mergeStateStatus=UNSTABLE` purely because a check had not reported yet —
nothing was wrong with either, and both merged unchanged minutes later.

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

### `gh-prs-fix-all`

Looks at every open threatcrush-scan pull request and fixes the ones broken
because of us. Reports the rest and leaves them alone.

```sh
gh-prs-fix-all                 # fix ours, report theirs
gh-prs-fix-all --dry-run       # change nothing, just say what stands
gh-prs-fix-all owner/name ...  # only these
```

The name says fix-all and it will not fix all, deliberately. Pushing to a fork
sets off whatever the upstream repo runs on push, so their suite goes red
against a commit that only added files under `.github/`. Those are reported,
never touched.

### `tcfeed`

```sh
tcfeed                              # the 50 newest posts
tcfeed 100                          # more of them
tcfeed --forget                     # look at everything again next time
tcfeed pr owner/name [--dry-run]    # install the scan workflow
tcfeed check [--fix]                # how are the open requests doing
```

The scanner itself lives in the threatcrush checkout, so this is a launcher.
Point it elsewhere with `TCFEED_REPO`; every other `TCFEED_*` variable is read
by the script it launches and works unchanged.

### `domainjson`

One JSON object on stdout: `{ name, rdap | moshpit, dns }`.

```sh
domainjson example.com
domainjson --name example.com
domainjson --registry https://pit.moshcode.sh --timeout 4000 example.hacker
domainjson -s https://rdap.example example.com     # OpenRDAP flags pass through
```

Names ending in a Moshpit TLD are served from the registry API; everything else
goes through OpenRDAP. Either way `dig` adds records, hosts, reverse lookups and
per-nameserver AXFR attempts. Errors are JSON too — a tool whose output gets
parsed should not change shape when it fails.

## Aliases

Pit aliases live in `~/.moshcode/aliases.json`:

```
/alias set prs        "gh-prs --orgs profullstack"
/alias set merge      "gh-prs-merge --orgs profullstack --apply --fix"
/alias set merge-dry  "gh-prs-merge --orgs profullstack"
/alias set fixprs     "gh-prs-fix-all"
/alias set feed       "tcfeed"
/alias set whoisj     "domainjson"

/alias                # list
/alias get merge      # show one
/alias rm merge       # forget one
```

Arguments append rather than substitute, so `/merge --limit 5` works.

### Why these are files on `PATH`

The older tools carry a comment saying it is because the moshcode pit runs
aliases with `zsh -c`, a non-interactive shell that reads neither `~/.zshrc` nor
`~/.zsh_aliases`. **That is no longer true** — current moshcode runs
`$SHELL -ic`, which is interactive and does source them:

```console
$ zsh -ic 'gh-prs-all --help'   # works — the pit's actual path
$ zsh -c  'gh-prs-all --help'   # zsh:1: command not found
```

The reason to stay on `PATH` is the weaker but sufficient one: a file works from
every caller — an interactive shell, `zsh -c`, a systemd unit, a CI step —
without anything having been sourced first.

Nothing should alias *to* these either. A function beats `PATH`, so a wrapper of
the same name silently shadows the file and the two drift apart.

## Development

```sh
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```

Tests stub the subprocess layer rather than the network, so `gh` is never
invoked. The suite runs in well under a second; if it starts taking longer,
something is reaching the network that should not be.

**Nothing under `bin/` does work at import time.** Every entry point guards its
side effects with `isMain(import.meta.url)`, and anything worth testing lives in
`src/`. That is not decorative: a test that imported `bin/gh-prs-fix-all.ts` to
reach one pure function *ran the tool*, taking the suite from 60ms to 93 seconds
and sweeping live pull requests with `--fix` implied.

`isMain` resolves the realpath first, because these install as symlinks —
`process.argv[1]` is the link while `import.meta.url` is its target, and
comparing them raw reports "imported" for every installed command at once.

## Why TypeScript

Ported from the bash and JavaScript originals in
[`profullstack/scripts`](https://github.com/profullstack/scripts). The point was
not the language. It was the two things bash was making expensive:

- **Typed, validated responses.** Every `gh` call went through `jq -r` into a
  string compare. `jq -r '.mergeable'` on a response that never had the field
  prints the four characters `null`, which is not `MERGEABLE` — so a perfectly
  mergeable PR read as ineligible *for a reason nobody wrote*, indistinguishable
  from a real verdict. An unrecognised field is now named in an error.
- **Tests.** The originals had none, so verifying a change meant running it
  against live pull requests.

## Differences from the originals

- `gh-prs` prints `No open PRs found.` instead of a bare header row.
- `gh-prs-merge` adds `fixed=` to its summary line.
- `domainjson` is unchanged in structure. DNS answers arrive round-robin, so
  array ordering varies between runs of either version.
