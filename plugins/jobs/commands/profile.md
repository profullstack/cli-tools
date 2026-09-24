---
description: Create, edit, switch and delete applicant profiles — identity, résumé, cover letter, answers, why-us and filters.
allowed-tools: Bash(jobhunt:*), Read
---

## Task

Manage the profiles an application is sent as. A profile bundles who is
applying, which documents, the answers to screening questions, the why-us
paragraph and the search filters, so one person can hunt for two kinds of
role without the answers of one leaking into the other.

```bash
jobhunt profile list                               # * marks the default
jobhunt profile show [name]
jobhunt profile add architect --from ai-engineer   # copy, then change what differs
jobhunt profile add ml firstName=Ada lastName=Lovelace email=ada@example.com resume=~/cv.pdf
jobhunt profile set architect resume=~/cv-architect.pdf cover=~/cover-architect.pdf
jobhunt profile set architect "why=I have designed … {company}'s work on {focus} is …"
jobhunt profile set architect answers.sponsorship=No answers.workAuthorized=Yes
jobhunt profile set architect filters.title.include=architect,principal
jobhunt profile answer architect "salary expectation" "Open to discuss"
jobhunt profile answer architect "^pronouns" "He/him" --select
jobhunt profile use architect                      # the default for bare commands
jobhunt profile rm architect --yes
```

`$ARGUMENTS` is passed through: `/jobs:profile show architect`.

## Doing it conversationally

- **Create:** ask for name, email, phone, links, location ("City, ST,
  Country") and city, the résumé and cover letter paths, and the answers
  (work authorisation, sponsorship, country, how they heard). Offer
  `--from <existing>` when most of it is shared. Résumé and cover paths are
  checked when set — a missing file is refused, so confirm the path first.
- **Edit:** `profile set` with only the keys that change. Say which keys you
  are changing; the history records the keys, not the values.
- **Answers you do not know:** never invent one. Work authorisation,
  sponsorship, relocation and "have you applied before" are the user's to
  answer. Leave a key unset and the run will stop at that question instead.
- **Delete:** confirm first. Removing a profile keeps its state and the
  never-twice list; applications already sent stay sent.

## Keys

Applicant: `firstName lastName preferredName email phone linkedin github
website location city`. Documents: `resume cover`. `why` (a template:
`{company}` and `{focus}` are filled per job). `mailAccount` (the `mail`
account that receives security codes; default is the one with the profile's
email). `answers.<key>`: `country workAuthorized sponsorship bayArea
previouslyApplied llmExperience largeScaleBackend clientFacing heardFrom`.
`filters.<key>`: see /jobs:config. Anything else a form asks: `profile answer`.
