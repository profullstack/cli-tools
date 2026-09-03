---
description: Read the queue of scheduled posts, and cancel one before it goes out.
argument-hint: [cancel <id>]
allowed-tools: Bash(myna:*), Read
---

## Task

Show what is pending, and cancel it if that is what was asked: `$ARGUMENTS`.

```bash
myna queue                 # id, when, status, targets, text
myna queue --json          # the raw queued posts
myna cancel <id>           # remove one before it fires
```

Both read `~/.config/myna/queue.json`, which is plaintext — neither needs the
vault, so neither prompts for a passphrase.

## Cancel is the only real undo

`myna cancel <id>` removes a pending post immediately, with **no confirmation**,
and throws `No queued post "<id>"` if the id is wrong. Read the queue first and
cancel by an id you have actually seen.

After delivery there is `myna delete <account> <post id>`, and it is a much
weaker thing: it needs a network that implements deletion, takes an exact
account id, runs with no confirmation and no dry-run, and cannot un-notify
anyone who already saw the post. Treat cancellation as the real undo and
deletion as damage control.

## Reading it honestly

The queue is what is *pending*. Leaving it is not proof of delivery — a network
can reject a post at send time — and that outcome is recorded in the history,
not here. `/myna:feed` reads it.

Entries whose time has already passed mean nothing is delivering them: neither
the TUI nor `myna run` has been up. Report that rather than listing them as
scheduled.
