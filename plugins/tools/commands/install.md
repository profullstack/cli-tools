---
description: Install the cli-tools command set onto PATH, and wire up the pit aliases.
allowed-tools: Bash(cli-tools:*), Bash(curl:*), Bash(sh:*), Bash(moshcode:*), Read
---

## Task

Put every `cli-tools` command on `PATH` and make it reachable from the moshcode
pit.

If `cli-tools` is not installed yet, one line does the whole thing:

```bash
curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh
```

Or, if moshcode is already on the box:

```bash
moshcode install cli-tools
```

Then wire up the pit aliases:

```bash
cli-tools aliases --install
```

## What lands where

The installer clones to `~/.local/share/cli-tools` (override with
`CLI_TOOLS_HOME`), installs dependencies, and symlinks every command into
`~/.local/bin` (override with `CLI_TOOLS_PREFIX`):

| Command | What it does |
| --- | --- |
| `affiliate` | Work through a list of programs you mean to sign up for |
| `ask-web` | Answer a question from the live web, with its sources |
| `blog-post` | Publish to a plain-HTML blog without breaking the feed |
| `cli-tools` | This dispatcher |
| `domainfree` | Which of these domains you can actually register |
| `domainjson` | whois-style, JSON-first name lookup |
| `generate-names` | Turn a sentence about a product into candidate names |
| `gh-prs` | Every open PR across the owners you name |
| `gh-prs-fix-all` | Repair the open scan PRs that are broken because of us |
| `gh-prs-merge` | Squash-merge the PRs that are genuinely ready |
| `tcfeed` | Find repositories worth scanning, scan them, print a shortlist |
| `tts` | Read text aloud and keep the audio |

Rather than listing them by hand, `cli-tools list` reads `bin/` — a new command
is a new file there and nothing else has to be edited, so that output is right
when this table has gone stale.

Check what took:

```bash
cli-tools list          # * runs from here, ! is shadowed by another copy
```

## Reading `cli-tools list`

Three states, and the middle one is the one worth understanding:

| Mark | Means |
| --- | --- |
| `*` | runs from this checkout |
| `!` | something else on `PATH` answers to that name — the row names the file |
| (blank) | not on `PATH` at all |

**Blank: `~/.local/bin` is not on `PATH`.** The installer warns about this at
the end. Add it to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**`!`: the name is already taken by another checkout.** A symlink pointing at a
different clone is left alone, because taking it over silently would change
which code runs. `cli-tools link --force` takes over a *symlink*; a real file of
that name is refused either way.

Before forcing, **check the flags**. Several of these commands were ported from
older hand-written scripts of the same name, and a port does not always keep the
original's defaults — `gh-prs-merge` is the example that bites, because the
older one repairs by default under `--apply` and this one repairs only when
asked with `--fix`. Taking it over silently changes what a merge run does.

## Aliases are a convenience, not the mechanism

`cli-tools aliases --install` merges these into `~/.moshcode/aliases.json`:

| Alias | Expands to |
| --- | --- |
| `/blog` | `blog-post` |
| `/free` | `domainfree` |
| `/merge` | `gh-prs-merge --apply` |
| `/prs` | `gh-prs` |
| `/whois` | `domainjson` |

An alias you already bound is never overwritten — the collision is reported and
yours is kept. The pit re-reads the file on every lookup, so an open pit picks
them up with no restart. Arguments append rather than substitute, so
`/merge --limit 5` works.

None of these shares a name with a command, deliberately. A shell function beats
`PATH`, so an alias named after the file it wraps silently shadows it and the
two drift apart. Keep them thin for the same reason `/merge` carries only
`--apply`: `gh-prs-merge` already repairs by default under `--apply`, and baking
`--fix` in as well is what once made `/merge --fix` expand to
`--apply --fix --fix`.

The commands are reachable from the pit whether or not you install any of this.
They are real executables on `PATH` because a file works from every caller — an
interactive shell, `zsh -c`, a systemd unit, a CI step — without anything having
been sourced first. The aliases only buy you a shorter word.

## Keeping it current

```bash
cli-tools autoupdate --install     # a systemd user timer; check daily from now on
cli-tools update                   # or do it now, by hand
```

`update` refuses to move a dirty or diverged checkout rather than discarding
work. If it stops, sort the checkout out at `cli-tools where` and retry.

### Auto-update

`cli-tools autoupdate --install` writes a systemd **user** timer that runs
`cli-tools update --auto` once a day (`--hours N` to change it, `--remove` to
take it away, and bare `autoupdate` to see when it last ran).

`update --auto` is the unattended form, and almost all of it is about deciding
*not* to act. The install is symlinks into a working tree, so updating means
moving somebody's real checkout — an unattended pull that discards work is far
worse than a command being a day out of date. It proceeds only when all of
these hold, and names the one in the way otherwise:

- the tree is clean,
- HEAD is the default branch (`origin/HEAD`, else `master`),
- nothing is unpushed,
- and it is genuinely behind.

So on a checkout parked on a feature branch it does nothing and says so. That is
the design, not a failure — the refusals go to stderr, which is the journal when
the timer runs it (`journalctl --user -u cli-tools-update`).

Two things worth knowing. The unit **bakes today's `PATH` in**, because a user
unit otherwise starts with roughly `/usr/bin:/bin` while these commands run
through a `npx --yes tsx` shebang whose node is usually a version manager's shim
under `$HOME` — without it the timer fires on schedule, fails to find node, and
nothing looks wrong. And **user timers stop when you log out** unless lingering
is enabled (`loginctl enable-linger`, which needs root); on a laptop that is
fine, since `Persistent=true` makes it catch up on the next login.

Note that the installed command runs **whatever branch the checkout is on** —
these are symlinks into a working tree, not a copied build. A checkout parked on
an old branch silently runs old code, so `cli-tools where` and a `git branch
--show-current` there are the first two things to check when a command behaves
like a version you do not recognise.
