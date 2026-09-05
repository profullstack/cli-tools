---
description: List, search and read mail in any configured account, and mark, file or delete it.
allowed-tools: Bash(mail:*), Read
---

## Task

Work the inbox from the terminal. The uid in the first column is what every
other verb takes.

```bash
mail ls                                  # newest 25 in the default account
mail ls -a all --unread                  # unread across every account
mail ls -a personal --limit 50
mail search from:substack is:unread      # header keys narrow, bare words match text
mail search -a all "pottery" since:2026-09-01
mail read 4213                           # headers, then the text; marks it read
mail read 4213 --keep-unread --json
mail mark 4213 --flag
mail archive 4213
mail rm 4213                             # to Trash; --purge --yes to expunge
```

`$ARGUMENTS` is passed through: `/mail:inbox -a all --unread`.

## Which account

`-a` takes the account's name, its address, or `all` for `ls` and `search`.
With no `-a`, the default account applies (`mail accounts default <name>`),
or `MAIL_ACCOUNT` from the environment. `mail accounts` shows what is
configured and where each password comes from, never the password itself.

## Setting up

```bash
mail accounts pull                       # import from the cli-tools-mail team vault
mail accounts add work you@example.com   # or by hand; prompts for the password
mail accounts add home you@gmail.com     # gmail is inferred; needs an App Password
```

Gmail refuses the account password over IMAP — it wants an App Password from
https://myaccount.google.com/apppasswords, which needs 2-step verification on.
Forward Email wants the alias password generated in its dashboard. Neither is
the password you log in to the website with.

## Reading marks it read

IMAP fetches here use PEEK, so nothing is marked by the fetch itself; `mail
read` then sets `\Seen` the way a client would, so that `--unread` stops
listing it. `--keep-unread` skips that. `--raw` prints the message as
received, for headers and DKIM spelunking.
