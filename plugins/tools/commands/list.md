---
description: What cli-tools installs, which checkout it runs from, and what is on PATH.
allowed-tools: Bash(cli-tools:*), Read
---

## Task

Report the state of the installed command set.

```bash
cli-tools list          # * runs from here, ! is shadowed by another copy
cli-tools list --json   # the same, machine-readable
cli-tools where         # the checkout the commands run from
```

## Reading it

The first line is the checkout. That is the answer to most surprises here,
because these commands are **symlinks into a working tree**, not a copied
build: the command on `PATH` runs whatever branch that checkout happens to be
on. A tree parked on a stale branch silently produces stale output, and a flag
added by a merged PR answers `unknown option` until someone pulls.

So when a command behaves like a version you do not recognise, check the
checkout before reading its source:

```bash
cli-tools where
git -C "$(cli-tools where)" branch --show-current
git -C "$(cli-tools where)" log --oneline HEAD..origin/master
```

`cli-tools update` fixes the common case.

## The marks

| Mark | Means |
| --- | --- |
| `*` | runs from this checkout |
| `!` | another implementation on `PATH` answers to that name — the row names it |
| (blank) | not on `PATH` at all |

`!` is the one that matters, and it is why this command does not simply ask
whether a file of each name exists. Several of these were ported from older
hand-written scripts of the same name, so a presence check reports them all
installed while some are a different program. A port does not always keep the
original's defaults: `gh-prs-merge` repairs by default under `--apply` in the
older script and only with `--fix` here, so which one is on `PATH` changes what
a merge run does.

`cli-tools link --force` takes over a `!` row, but check the flags first. A
blank row just needs `cli-tools link`, or `~/.local/bin` on `PATH` — see
`/tools:install`.
