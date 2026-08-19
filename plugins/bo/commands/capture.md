---
description: Run a failing command, capture it with its environment, redact the secrets, and find the answer that already exists.
argument-hint: <command to run>
allowed-tools: Bash(bo:*), Read
---

## Task

Run `$ARGUMENTS` under `bo`, so that whatever it prints is captured with the
environment that produced it and matched against BufferOverride before anyone
writes a question about it.

```bash
bo run -- pnpm test
bo run --dry-run -- pnpm build     # everything except publishing
```

Everything after `--` is the user's command, verbatim. The split happens before
any flag is parsed, so a `--watch` or a `-v` inside it is passed through rather
than interpreted.

## What it does, in order

1. Runs the command and keeps stdout, stderr, the exit code, the signal and how
   long it took.
2. Probes the environment: OS, architecture, runtime and the dependency
   versions it can detect.
3. Redacts what it recognises as a secret — by pattern, and by the *value* of
   variables in your own environment — and reports every hit by line.
4. Builds an error signature and searches BufferOverride with it.
5. Shows you all of that, and stops.

Nothing is uploaded before that point. A match is printed as
`#a1b2c3d4e5 <title>` with its status, verification count and the version range
it is valid for — read one with `/bo:read`.

## Exit codes pass through

`bo run --` wraps a command rather than replacing it, so the wrapped command's
exit code is what `bo` exits with. That is what makes it safe to put in front of
something already in CI: CI sees the same code it saw before.

A command that succeeds has nothing to report — `bo` says `exit 0 — nothing to
report` and stops. `--force` captures a successful run anyway.

## In a script, in CI, or in an agent loop

- `--json` puts the whole capture on stdout — command, exit code, environment,
  signature, redaction findings, output and matches — and prints nothing else,
  so it pipes into `jq`. The wrapped command's own output is captured rather
  than echoed under `--json`, so it cannot splice itself into the middle of the
  document.
- Outside a TTY nothing is published at all unless `--ask` is passed. A capture
  posted by a job nobody watched is exactly the noise the site exists not to
  accumulate.
- `--quiet` suppresses the child's output while still capturing it.

## Safety

Redaction is best effort and cannot be complete — no pattern list catches a
custom-format secret. The server re-scans on ingest and any question can be
purged, but neither is a substitute for looking at the redaction report before
publishing. `--dry-run` does the whole run, capture, redaction and search and
publishes nothing; make it the default habit and drop it deliberately.

Do not pass `--acknowledge-secrets` on the user's behalf. It exists for the
author to say "that one is a placeholder", which is a claim only they can make.
