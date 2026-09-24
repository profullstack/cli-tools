---
description: Show the effective settings, and set the search filters — workplace, countries, title, pay, score, boosts, source list.
allowed-tools: Bash(jobhunt:*), Read
---

## Task

Show or change what a profile searches for.

```bash
jobhunt config                                     # file used, profile, state, browser, codes, filters
jobhunt config --profile architect
jobhunt config set workplace=remote,hybrid         # remote | hybrid | onsite | any
jobhunt config set countries=US,CA                 # ISO codes, or EMEA / APAC / EUROPE / LATAM; any
jobhunt config set title.include+=staff            # += adds to a list, -= removes
jobhunt config set title.exclude-=manager
jobhunt config set pay.min=180k pay.currency=USD
jobhunt config set pay.require=true                # drop postings that state no pay
jobhunt config set minScore=9 limit=25
jobhunt config set exclude=ONSITE,CLEARANCE        # flags that drop a posting outright
jobhunt config set boost.rust.terms=rust,tokio boost.rust.weight=3
jobhunt config set source=https://raw.githubusercontent.com/<owner>/<repo>/main/README.md
jobhunt config unset pay.min                       # back to the default
```

`$ARGUMENTS` is passed through: `/jobs:config set pay.min=180k`. Turn a
request like "only hybrid or remote, $180k and up, no clearance" into the
`set` line, say what you are about to change, then run it and show the result.

## What each ATS can actually be filtered on

| filter    | Ashby               | Greenhouse                 | Lever                  | Workable        |
|-----------|---------------------|----------------------------|------------------------|-----------------|
| workplace | workplaceType       | location text              | workplaceType          | remote only     |
| countries | address + text      | location text              | country + text         | country + text  |
| pay       | compensation tiers  | pay ranges, else the text  | salaryRange, else text | none            |

A posting with no stated pay passes by default and is flagged `pay:unknown`;
`pay.require=true` drops it. Pay in another currency is shown but not compared.
A location that names no place ("Remote") passes any country filter.
`title.include` terms match anywhere in the title; `title.exclude` terms match
whole words. Terms are case-insensitive regular expressions.

The applicant's details, documents and answers are set with /jobs:profile.
