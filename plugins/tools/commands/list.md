---
description: What cli-tools installs, which checkout it runs from, and what is on PATH.
allowed-tools: Bash(cli-tools:*), Read
---

## Task

Report the state of the installed command set.

```bash
cli-tools list          # a * marks each command found on PATH
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

A command with no `*` is not on `PATH` — see `/tools:install`, which covers both
causes.
