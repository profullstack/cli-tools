---
description: List a product in a software directory over that directory's MCP server — a listing, not a post, and it is public and reviewed by a person.
argument-hint: <directory> <url>
allowed-tools: Bash(myna:*), Read
---

## Task

Submit `$ARGUMENTS`.

```bash
myna directory                                   # what is connected
myna directory saasrow https://example.com --dry-run
myna directory saasrow https://example.com
myna directory listings
```

myna reads the product's page, works out the name, writes the description and
picks the category and vocabulary terms the directory accepts, then sends it
over that directory's MCP server.

## This is not `myna post`, and the difference matters

A post tells people about the product. A **listing is the product**: a name, a
website, a description, a category, reviewed by a human being at the directory
and then indexed by search engines and assistants. They have separate commands,
separate credentials and separate consequences.

Directories are deliberately **not** in `--to all` and never can be. Their
credentials live in a different part of the vault for exactly that reason: a
stray thought must not be submittable as a product.

## Run `--dry-run` first, always

`--dry-run` prints the listing myna would send and exits without sending it. It
is a real preview — the same fields, in the same shape — unlike `--dry-run` on
`myna post`, which only resolves targets.

Do this before every first submission of a URL. The description will be read by
a reviewer and then by everyone; getting the name wrong, or letting a tagline
land in the name field, is publicly visible and needs a human to fix.

Anything wrong is a flag rather than a reason to give up:

| Flag | Does |
| --- | --- |
| `--name` | the product's name, when the page's title is not it |
| `--description` | replaces what the writer produced |
| `--category` | must be one the directory accepts (`myna directory categories <id>`) |
| `--tags a,b` | comma list, or repeat the flag |
| `--platforms`, `--audiences`, `--use-cases` | controlled vocabulary (`myna directory vocabulary <id>`) |
| `--pricing` | one vocabulary term |
| `--no-ai` | describe it from the page's metadata instead of the writer |
| `--dry-run` | build it and stop |
| `--json` | machine output |

## Signing in is a person's job

`myna directory login saasrow` mails a one-time code to an email address and
waits for it to be typed back. **Nothing here can complete that**, and neither
can the MCP tools — there is deliberately no login tool. If a submission fails
with "Not signed in", say so and stop; do not try to work around it.

A custom directory (below) is different: it takes an API key the person already
has, so it can be scripted, but the key still has to come from them.

## Any MCP server, not just the ones myna ships

```bash
myna directory catalog                                  # endpoints myna knows
myna directory add acme https://acme.example/api/mcp    # anything else
myna directory tools acme                               # what it actually offers
myna directory drop acme
```

There is no adapter behind the second one. myna reads the server's tool table,
finds whichever tool creates a listing whatever it is called, and sends fields
under the names *that tool's schema* uses. When a submission is refused and the
reason is not obvious, `myna directory tools <id>` is the first thing to look
at: it shows what the server really accepts, which is usually the answer.

## What a submission does not do

It does not publish. Every directory here reviews first, so a successful
submit means "queued for a person to look at", and the returned status says
`pending`. Do not report a listing as live. `myna directory listings` shows
where each one actually stands.

Submitting the same website twice is refused by the directory, not by myna, and
the error comes back as the directory worded it. Check `myna directory listings`
before assuming a URL is unlisted.

## Over MCP

An agent reaches the same thing with `myna_directories`,
`myna_directory_preview`, `myna_directory_submit` and
`myna_directory_listings`. `myna_directory_preview` is the `--dry-run`
equivalent and should be called first for the same reason.
