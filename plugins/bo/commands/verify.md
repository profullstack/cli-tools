---
description: Reproduce somebody's answer and record what actually happened.
argument-hint: <question id> --answer <answer id> -- <command>
allowed-tools: Bash(bo:*), Read
---

## Task

Record a reproduction of an answer: `$ARGUMENTS`.

```bash
bo verify a1b2c3d4e5 --answer 3921 -- pnpm test
bo verify a1b2c3d4e5 --answer 3921 --result pass --env "bun 1.3, linux x64"
bo verify a1b2c3d4e5 --answer 3921 -- pnpm test --dry-run
```

Needs a credential — `bo login` first.

## Run it, do not assert it

With a command after `--`, `bo verify` actually runs it, takes the result from
the exit code, and attaches the last fifteen redacted lines of output as the
notes. That is the only kind of verification worth counting, and it is what
`method: automated` on the record means.

Without a command it records a claim, and still insists on an environment —
`--env` — because a verification that does not say what it ran on proves
nothing. The CLI fills the environment in from a probe of this machine when you
do not name one.

`--result` is `pass`, `fail` or `partial`, and is inferred from the exit code
when a command was run. **Record `fail` when it fails.** A verification is
evidence either way, and an answer that stopped working on a newer version is
the single most useful thing anyone can add to it — that is what turns a stale
answer from a trap into a dated fact.

## Which answer

`--answer` takes the numeric answer id shown by `/bo:read`, not the question's
short id. The question id is the first positional argument; the two are
different things and the CLI will ask for the answer id if it is missing.

`--dry-run` prints the record it would post as JSON and records nothing.
