---
description: Clean a mailing list before sending to it; drop bad, role, disposable, duplicate and placeholder addresses, keeping the input's format.
allowed-tools: Bash(email-cleaner:*), Read, Write
---

## Task

Clean a list of email addresses (a file, or pasted text) and hand back the
ones worth sending to, in the same shape they came in.

```bash
email-cleaner list.txt > clean.txt
email-cleaner users.csv --invalid rejected.csv --report > clean.csv
email-cleaner --no-dns < pasted.txt       # quick pass, no network
email-cleaner users.csv --format json     # valid, invalid with reasons, stats
```

Input can be addresses separated by newlines, commas or semicolons, plain or
`Name <addr>`, or a CSV with an `email` column. Output keeps the separator,
the display names and every other CSV column.

## Defaults

Removed unless allowed: role addresses (`--allow-role`), disposable domains
(`--allow-disposable`), duplicates including Gmail dot and `+tag` variants
(`--allow-duplicates`), placeholders like `test@test.com`
(`--allow-unlikely`), and domains that take mail but have no website
(`--allow-no-website`). Syntax errors, domains that do not exist and domains
that take no mail are always removed.

Provider typos (`gmial.com`) are rejected with a "did you mean" hint. Only add
`--fix-typos` when the person owns the list and wants the addresses rewritten.

## Reading the result

Run with `--report` and summarize the "Results" chart for the person: how many
kept, and the main reasons for the rest. A DNS timeout never rejects an
address, so a slow network makes the list longer, not shorter. The list is
personal data: do not paste it anywhere else.
