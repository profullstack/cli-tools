---
description: How the job hunt stands — applied, skipped, queued, the latest run and recent outcomes.
allowed-tools: Bash(jobhunt:*), Read
---

## Task

Summarise where things stand for a profile.

```bash
jobhunt status                            # the active profile
jobhunt status --profile architect
jobhunt status --json
jobhunt run show                          # the newest run, job by job
```

`$ARGUMENTS` is passed through: `/jobs:status --profile architect`.

## Reading it

- **applied** counts every posting ever handled, from any profile — the
  never-twice list — split by outcome (`submitted`, `unverified`,
  `skipped`, `manual`) and by profile. Rows from before profiles existed are
  counted under "(before profiles)".
- **queue** is what the next run would apply to, minus anything handled since.
- **run** is the newest run for the profile; a run whose process died shows as
  `crashed` and can be resumed (/jobs:run).
- **recent results** are the last outcomes, dry runs marked.

For anything `needs-human-review`, `jobhunt run show` names the unanswered
fields. For what changed and when, use /jobs:history.
