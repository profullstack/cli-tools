---
description: Find remote roles worth applying to, ranked, then queue the ones the user picks.
allowed-tools: Bash(jobhunt:*), Read
---

## Task

Run discovery for a profile, show the shortlist, and queue what the user
chooses. Nothing is sent from here.

```bash
jobhunt discover                          # the active profile's filters (score ≥ minScore, top `limit`)
jobhunt discover --profile architect      # another profile's filters and state
jobhunt discover --min-score 10 --limit 20
jobhunt shortlist                         # the last discovery again, numbered
jobhunt queue add 0 3 --focus "agent evals and observability"
jobhunt queue focus <key> "what {focus} should say for this one"
jobhunt skip 4 --reason onsite            # never show or send it again
```

`$ARGUMENTS` is passed through: `/jobs:discover --profile architect --min-score 10`.
A bare word that is a profile name means `--profile <word>`.

## Reading the shortlist

Each line is `index | score | company | title | location | workplace | pay | flags`.
Relay it as a table. Point out the flags, which the tool does not act on
unless the profile excludes them:

- `ONSITE`, `LOCATION-BOUND` — the description asks for office days or a
  specific place even though the listing says remote.
- `CLEARANCE` — a security clearance is mentioned.
- `NON-JS` — the primary language is Go, Java, Python, Rust or C++ with no
  TypeScript or Node.
- `pay ?` — no pay was stated anywhere the ATS exposes; `pay:CAD` and the
  like mean it is in another currency and was not compared with `pay.min`.

Anything already applied to, from any profile, is left out before ranking.

## Queueing

Ask the user which numbers to queue; never queue on your own judgement. If the
profile's why-us template uses `{focus}`, each job needs a focus — the phrase
that finishes "<company>'s work on ___". Suggest one from the posting and let
the user change it. Things the user rules out go to `jobhunt skip <n> --reason
<why>` so they stop coming back.
