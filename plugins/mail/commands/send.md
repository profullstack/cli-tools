---
description: Reply to a message in its thread, or send a new one, over SMTP with Resend as the fallback; or file it as a draft.
allowed-tools: Bash(mail:*), Read
---

## Task

Send mail from a configured account, or answer a message so that it lands in
the other side's thread.

```bash
mail reply 4213 --body "Thanks — sending the invoice today."
mail reply 4213 --all --file answer.md            # everyone on the original
cat answer.md | mail reply 4213 --draft           # into Drafts, not sent
mail send --to a@example.org --subject "Hello" --body "Short and sweet."
mail send --to a@x,b@x --cc c@x --subject S --file body.txt --attach deck.pdf
mail send -a personal --to a@x --subject S --body B --via smtp
```

`$ARGUMENTS` is passed through: `/mail:send reply 4213 --body "…"`.

## Before sending anything on someone's behalf

Show the text and the recipients and get a yes first, or use `--draft` and let
them send it from Drafts. A reply quotes the original underneath by default
(`--no-quote` to omit), carries `In-Reply-To` and `References` so it threads,
and answers the Reply-To address when the original set one. `--all` copies
the original's To and Cc, minus the account itself.

## How it goes out

SMTP with the account's password, and if the *pipe* fails — a refused login,
a dead host — Resend carries it, when a `RESEND_API_KEY` is stored
(`cli-tools config pull`) and the domain is verified there. A refused
*message* (bad recipient, unverified domain) is never retried on the other
path: it would fail the same way, and a late acceptance would mean two copies.

A webmail address (gmail.com and friends) cannot be verified at Resend, so a
Gmail account sends over SMTP only; without an App Password it cannot send at
all, and the error says so.

`--via smtp` or `--via resend` pins one transport and refuses rather than
swapping. A message sent through Resend is appended to the account's Sent
folder over IMAP, because Resend never files one; SMTP servers file their own.
