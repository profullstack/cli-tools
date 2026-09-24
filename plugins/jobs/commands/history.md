---
description: The audit log — every profile change, filter change, queue edit, skip, run event and application outcome.
allowed-tools: Bash(jobhunt:*), Read
---

## Task

Answer "what happened" from the append-only history.

```bash
jobhunt history                           # the last 50 events, every profile
jobhunt history --since 7d                # 30m, 12h, 7d, 2w, or a date
jobhunt history --profile ai-engineer
jobhunt history --run 20260924-073722-d96b
jobhunt history --type job-outcome        # one type
jobhunt history --type run-,skip          # a trailing - is a prefix: every run event
jobhunt history --limit 200 --json
```

`$ARGUMENTS` is passed through: `/jobs:history --since 7d --type job-outcome`.

## Event types

`profile-add` `profile-set` `profile-rm` `profile-use` `profile-answer` ·
`config-set` `config-unset` · `discover` · `queue-add` `queue-rm` `queue-clear`
`queue-focus` · `skip` · `run-start` `run-stop` `run-restart` `run-resume`
`run-finish` `run-crash` · `job-start` `job-outcome` `job-abandoned`
`awaiting-code` `code-provided`.

`profile-set` records which keys changed, never their values, and
`code-provided` records where a code came from (mail or file), never the code.
