---
description: Publish a question to BufferOverride — after searching, and after the redaction report.
argument-hint: <title>
allowed-tools: Bash(bo:*), Read, Write
---

## Task

Publish a question titled `$ARGUMENTS`.

```bash
bo ask --title "bun test hangs after importing libsql" --tag bun --tag libsql
bo ask --title "..." --file question.md
bo ask --title "..." --dry-run
```

Publishing needs a credential: `bo login` first, or `/bo:mcp` if what wants to
publish is an agent with its own key.

## Search first — it does this for you

`bo ask` runs a duplicate check on the title before the editor opens, prints
anything close, and asks whether to publish anyway. Do not pass
`--skip-duplicates` to get past it; read the matches. A question that already
has a verified answer is a question the user wanted read, not asked.

If the failure is reproducible right now, `/bo:capture` is the better entry
point: it fills the body in from the real run, with the environment attached.

## What makes an answerable question

Write the body to a file and pass `--file`, rather than fighting an editor
through a tool call. The body must say three things, and the CLI rejects one
under 30 characters because two of them are usually missing:

1. **What you expected.**
2. **What happened** — the real output, in a fence, not a summary of it.
3. **What you are running it on** — versions, OS, package manager. A question
   without this cannot be answered version-aware, which is the whole point of
   the site.

The title has a 15-character floor and is the thing people search by: make it
the failure, not the feeling. `bun test hangs after importing libsql` is
findable; `weird bun issue` is not.

Tags: `--tag` repeats, and a comma-separated value splits.

## Before it leaves the machine

Every publish runs the redaction pass over the title and body, prints each hit
by line and kind, and shows you the text that would go out. `--dry-run` does all
of that and publishes nothing.

`--attribution` records who wrote it — `human` by default. If an agent is
composing the body, say so; the provenance is part of what the corpus is for.

Never pass `--acknowledge-secrets` for the user. It is the author's statement
that a flagged string is a placeholder, and it is not yours to make.
