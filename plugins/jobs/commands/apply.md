---
description: Apply to the queued jobs through a browser — dry run first, then for real once the user has seen the queue.
allowed-tools: Bash(jobhunt:*), Read, Write
---

## Task

Fill (and, only when the user says so, submit) the queued applications.

```bash
jobhunt queue                             # ALWAYS show this to the user first
jobhunt apply --dry-run                   # fill every form, submit nothing
jobhunt apply --dry-run <key>             # one job
jobhunt apply --yes                       # submit the queue, in the foreground
jobhunt apply --profile architect --yes
jobhunt run start --detach                # the same in the background; see /jobs:run
```

`$ARGUMENTS` is passed through: `/jobs:apply --dry-run --profile architect`.

## The rules

1. **Show the queue before any live apply**, with company, title and focus,
   and get an explicit yes for that list. A dry run needs no approval.
2. **Dry run first** when a profile or a company is new. `prepared` means
   every required field had an answer and the résumé showed as attached.
3. **Never tick a consent, arbitration, certification or "I agree" box**, and
   never answer a question the profile does not answer. The tool stops at
   those with `needs-human-review` and names the fields; relay them. The user
   either finishes that one by hand (then `jobhunt skip <key> --reason manual`)
   or adds an answer: `jobhunt profile answer <profile> "<label regex>" <value>`
   (`--select` for a dropdown), then dry-runs again.
4. **Never apply twice.** `submitted` and `unverified` go on the never-twice
   list for every profile. `unverified` means submit was clicked and no error
   appeared but no thank-you text either — treat it as sent. Ashby employers
   often send no confirmation email, so a missing email proves nothing.

## Security codes

Greenhouse emails a code before it accepts an application. A line like

```json
{"key":"…","company":"Acme","status":"awaiting-code","codeFile":"…/codes/<key>.txt"}
```

means the run is waiting (up to 5 minutes). When the profile's email has a
`mail` account configured, the code is read from the inbox automatically —
`jobhunt config` says which. Otherwise find the newest "Security code for your
application to <company>" email from no-reply@us.greenhouse-mail.io and write
just the code to that `codeFile`. Never print the code back to the user or
put it anywhere else.

## Outcomes

`prepared` (dry run) · `submitted` · `unverified` · `needs-human-review` (with
the unanswered fields) · `failed` (with the reason). `jobhunt status` sums
them up; `jobhunt run show` lists one run job by job.
