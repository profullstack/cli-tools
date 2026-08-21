---
description: Answer a question from the live web, with the pages the answer came from.
allowed-tools: Bash(ask-web:*), Read
---

## Task

Answer a question that needs the current web rather than training data.

```bash
ask-web "what is the latest Node LTS" --recency month
ask-web "…" --domains nodejs.org,github.com    # only these hosts
ask-web "…" --model sonar-pro                  # search wider
ask-web "…" --bare                             # prose only, for piping
ask-web "…" --json                             # answer and sources as JSON
```

Models, cheapest first: `sonar`, `sonar-pro`, `sonar-reasoning`,
`sonar-reasoning-pro`, `sonar-deep-research`. The reasoning ones think before
answering and are worth it only for a question with steps in it.

## Read the sources, not just the answer

The `[n]` markers in the answer are numbered to match the list printed under it,
and that pairing is the reason to use this rather than a search engine: it is
what makes the answer checkable.

So check it. Before repeating a claim from here as fact — a version number, a
date, a price, anything a decision rests on — open the source behind the marker
that supports it. A grounded answer is still a summary of pages that may
themselves be wrong, out of date, or SEO filler; the citation tells you which
page to blame, not that the page was right.

`warning: cites [n] with no matching source` on stderr means the answer
referenced something the search did not return. Treat that answer as unverified.

## Restrict the search when you can

`--domains nodejs.org` on a question about Node changes the answer quality more
than a bigger model does — most of what a general search returns for a technical
question is content farms restating the docs. Prefer the primary source and say
where you looked.

`--recency` is the other one worth reaching for: anything about "the latest" or
"currently" should carry `--recency month` or `--recency week`, or the search is
free to answer from a page written two years ago.

## Piping

The answer and its sources go to stdout; counts and warnings go to stderr. So
`ask-web "…" --bare | pbcopy` copies prose and nothing else, and `--json` gives
you `{text, sources, model, danglingCitations}` for a script.

Needs a Perplexity key: `cli-tools config set perplexity`, or
`cli-tools config pull` from the team vault. Every call spends money — a small
amount, but not zero, so do not loop this over a list without deciding to.
