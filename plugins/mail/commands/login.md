---
description: Sign in to a mail provider — Gmail, Yahoo, iCloud, Fastmail, Zoho, Proton, Forward Email and more — with the right kind of password, verified before it is stored.
allowed-tools: Bash(mail:*), Read
---

## Task

Add a mailbox to `mail`. Name the provider, or just the address when its
domain gives the provider away (a known webmail domain, or a custom domain
whose MX records point at a known host).

```bash
mail providers                                   # everything built in, and what each wants
mail login gmail you@gmail.com                   # says "app password", checks IMAP + SMTP, stores it
mail login you@yahoo.com                         # provider read off the address
mail login you@yourdomain.com                    # provider read off the domain's MX records
mail login forwardemail you@yourdomain.com --as work --default
mail login proton you@proton.me                  # through Proton Mail Bridge on localhost; its certificate is pinned, never ignored
mail login custom you@example.org --imap-host imap.example.org --smtp-host smtp.example.org --starttls
```

`$ARGUMENTS` is passed through: `/mail:login gmail you@gmail.com --as home`.

## What happens

1. The provider's password rule is printed first. Gmail, Yahoo, AOL, iCloud,
   Fastmail, Yandex and (with two-factor on) Zoho refuse the account password
   over IMAP and want a generated app password; the message says where to make
   one. Forward Email wants the per-alias password; Proton wants the password
   its Bridge shows. The rest take the account password.
2. The password is read without echo (or from stdin when piped).
3. IMAP and SMTP logins are both tried. A failed IMAP login stores nothing and
   names the likely cause. A failed SMTP login stores the account with a
   warning, because reading still works.
4. The account lands in `~/.config/cli-tools/mail.json` (0600) under the
   provider's name, or `--as NAME`. The first account becomes the default;
   `--default` makes a later one the default.

## Not reachable with a password

Outlook.com / Hotmail / Live and Microsoft 365 take only OAuth2 since
Microsoft removed basic authentication; app passwords no longer count. Tuta
and HEY have no IMAP or SMTP at all. `mail login outlook` says so instead of
failing a login.

## When asked to set someone up

Run `mail providers` and read the row for their host before asking for
anything: the answer to "which password" is there, and it is the question
that stalls every first login. Never ask for a password in chat — have them
run `mail login` themselves, or pipe it from a file they control.
