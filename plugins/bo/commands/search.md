---
description: Search BufferOverride for a failure by its error text. No account needed.
argument-hint: <error text>
allowed-tools: Bash(bo:*)
---

## Task

Find out whether `$ARGUMENTS` has already been answered.

```bash
bo search "worker exited before finishing"
bo search "ERR_PNPM_EXOTIC_SUBDEP" --json
bo search "libsql" -n 25            # up to 50; default 10
```

Search reads, so it needs no credential — this works before `bo login` has ever
been run.

## Search with the error, not with a description of it

The corpus is indexed on what failures actually print. A distinctive fragment of
the real message beats a paraphrase of the symptom: quote the line, drop the
parts that are specific to this machine (paths, pids, timestamps, ids), and
search that.

If the failure is in front of you rather than in a log, `/bo:capture` is better
than this: it derives the signature from the real output and searches with it,
so there is nothing to guess at.

## Reading the result

Each hit is a line: the short id, the title, and then its status — `canonical`,
how many independent reproductions it carries, and the version range the answer
declares itself valid for. That range is the part worth checking. An answer
verified twice against `bun 1.1 - 1.3` says nothing reliable about `bun 1.5`,
and BufferOverride marks such an answer stale rather than pretending otherwise.

Read a hit with `/bo:read <id>`.

Exit status is `1` when nothing matched, so this is usable as a gate. No match
means nobody has asked it yet — `/bo:ask` is what publishes it.
