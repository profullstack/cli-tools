---
description: Read a timeline, the history of what was actually sent, and the engagement it earned.
argument-hint: [network]
allowed-tools: Bash(myna:*), Read
---

## Task

Read back: `$ARGUMENTS`.

```bash
myna feed                    # a home timeline
myna feed mastodon           # from that network
myna feed --limit 50 --json
myna history                 # what was sent, and what failed
myna history --limit 100 --json
myna stats                   # engagement totals, per network, top posts
myna stats refresh           # re-fetch it from each network first
```

These are reads. They post nothing, and they are the right first move before
writing anything — including before answering "did that go out?".

## `feed` reads one account, not all of them

It resolves the target the same way a post does, then picks the **first**
account that can read a timeline, and throws `None of those accounts can read a
timeline.` when none can. So a bare `myna feed` is one account's home timeline —
usually not the one you meant. Name the network or the `network:handle`.

Not every network in the set is readable; the long-form and chat targets are
write-mostly. An empty result for one of those is the shape of the network, not
a fault. `--limit` defaults to 20.

## History is where delivery is recorded

The queue says what is pending. `history` says what each target did with it —
newest first, `--limit` 50 by default. A send that fans out to six accounts can
land on five, and the sixth failure is a row here.

`myna post` exits `1` if any target failed, which tells you *that* something
failed and never *which*. So when reporting on a send, read the rows and name
the accounts, rather than summarising a multi-target post as sent.

## Engagement

`myna stats` reads what was already collected; `myna stats refresh` (or
`--refresh=1`) hits each network's stats API first, `--limit` 25 by default.
`--json` gives `{totals, networks, top}`.

The fuller performance view — volume over time, delivery rate, per-network
breakdown, the hours posts actually go out — is a screen in the TUI. `myna` with
no arguments opens it. That is a thing to hand the user rather than to drive
from a tool call.
