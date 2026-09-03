---
description: Send a post to one network, several, or every connected account — knowing that the default is every connected account.
argument-hint: [target] <text>
allowed-tools: Bash(myna:*), Read
---

## Task

Post `$ARGUMENTS`.

```bash
myna post --to bluesky "shipping today"
myna post --to bluesky,mastodon "goes to both"
myna post --to bluesky:work.bsky.social "just the work one"
echo "from a pipe" | myna post bluesky
```

There is **no confirmation prompt and no `--yes` gate**. The command sends.

## Name the target with `--to`, and do not write a comma list as a positional

Two argument shapes exist and only one of them is safe to generate:

- `--to <spec>` is unambiguous. When it is set, every positional is text.
- A bare positional target is recognised only when the word is *exactly* `all`,
  `*`, a network id or alias, an account id, or a handle.

**`myna post bluesky,mastodon "text"` does not do what it looks like.** A comma
list is not recognised in the positional slot, so the whole thing is treated as
text and it is sent to the default target instead — which is every connected
account. myna's own help and README show that example; it is wrong. Comma lists
work only after `--to`.

The same trap in the other direction: `myna post all "hi" --to bluesky` posts
the text `all hi`, because `--to` makes every positional a word of the post.

So: always `--to`.

## The default target is everything

`settings.defaultTargets` ships as `all`, and `all` means every connected
account across all 26 networks. That is the target whenever one is not resolved
— including `myna post "text"` with no target at all, and including the
comma-list mistake above. A missing `--to` is not a no-op; it is the widest
possible send.

`myna config defaultTargets` shows what this machine is set to. Check it before
posting for someone whose accounts you did not connect.

## What `--dry-run` does, and what it does not

`--dry-run` prints how many accounts would receive it, lists their ids, prints
the text, and exits before anything is sent. It is a **target check**.

It is not a preview of the post. It does not tailor the text per network, does
not check character limits, does not load `--media`, and ignores `--json`. The
per-network rendering — where X bills every URL at 23 characters however long it
is, where a long post becomes a thread, where a title is a real field and where
it is nothing — is shown in the TUI compose screen, and over MCP by
`myna_preview`. If the length matters, that is where to look; do not report a
`--dry-run` as evidence that a post fits.

## Flags

| Flag | Does |
| --- | --- |
| `--to <spec>` | targets: `all`, a network, `network:handle`, a handle, or a comma list |
| `--title <text>` | the title field on the long-form networks; nothing on the rest |
| `--media <path>` | attach a file; the only repeatable flag |
| `--no-thread` | truncate instead of threading, where threading exists |
| `--dry-run` | resolve targets and stop |
| `--json` | machine output |

Beware the parser: only `--json`, `--yes`, `--thread`, `--dry-run` and
`--no-thread` are valueless. Every other flag consumes the next token, so a
stray one swallows a word of the post.

## Reading the result

Exit is `0` only when every target succeeded, `1` if any failed — but a partial
send is normal and the code does not say which one. `--json` gives
`[{account, ok, url, id, error}]`; read the rows and tell the user which
accounts actually received it. In a thread, only the first post's `url` and `id`
come back.

## If the vault has a passphrase

Posting unlocks the vault, and a passphrase vault prompts on the terminal unless
`MYNA_PASSPHRASE` is set. Unattended, that is a hang rather than an error.
