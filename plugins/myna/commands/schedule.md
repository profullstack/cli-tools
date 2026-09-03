---
description: Queue a post for later, and run the sender that actually delivers it.
argument-hint: "<when>" "<text>"
allowed-tools: Bash(myna:*), Read
---

## Task

Queue a post: `$ARGUMENTS`.

```bash
myna schedule "in 2h" "the release notes are up" --to bluesky
myna schedule "tomorrow 9am" "shipping today" --to bluesky,mastodon
```

The when comes first, as a positional, and the text follows; `--at "<when>"` can
supply it instead. Targets are `--to`, with the same warning as a live post: a
comma list works only there, and without `--to` this queues to the default
target, which ships as every connected account.

`schedule` has no confirmation and **ignores `--dry-run`** — passing it queues
the post anyway. To check targets first, run the same text through
`myna post --to <spec> --dry-run`, which stops before sending.

## Times it understands

Written the way a person says it:

| Form | Example |
| --- | --- |
| relative | `in 2h`, `in 30 minutes`, `2h` |
| named day | `today`, `tonight`, `tomorrow 9am` |
| dated | `2026-09-10`, `2026-09-10 17:00`, full ISO |
| bare time | `17:00` — the next time it comes round |

A day with no time means 09:00, `tonight` means 19:00. Anything it cannot parse
throws rather than guessing.

## The part that is easy to get wrong

**A queued post is not a sent post, and nothing sends it on its own.** Delivery
happens while the TUI is open, or while the scheduler runs:

```bash
myna run                 # foreground, checks every 30s
myna run --interval 60   # seconds
myna run --once=true     # one pass, then exit
```

`myna run` blocks forever — it is a daemon, so background it rather than waiting
on it. And note `--once=true`: the flag parser treats almost nothing as a bare
boolean, so `myna run --once` fails with `--once needs a value`.

On a box where neither the TUI nor `myna run` is up, a queue simply fills and
nothing goes out. Say which of the two will deliver it, or say that nothing
will.

## Until it fires, it is reversible

`/myna:queue` lists what is pending with its id and cancels it. That is the last
cheap moment: after delivery it is a public post, and most of these networks
cannot take one back.
