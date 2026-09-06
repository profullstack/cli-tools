---
description: Sign in to a calendar provider — iCloud, Fastmail, Zoho, Yahoo, Forward Email, Nextcloud and more — with the right kind of password, verified before it is stored.
allowed-tools: Bash(cal:*), Read
---

## Task

Add a calendar account. Name the provider, or the address when its domain
gives the provider away.

```bash
cal providers                                   # everything built in, and what each wants
cal login icloud you@icloud.com                 # says "app password", finds the calendars, stores it
cal login you@fastmail.com                      # provider read off the address
cal login forwardemail --like work              # reuse the `mail` account's address and password
cal login zoho you@yourco.com --url https://calendar.zoho.eu/caldav/
cal login custom you@x.org --url https://cloud.x.org/remote.php/dav   # Nextcloud, Radicale, Baïkal …
```

`$ARGUMENTS` is passed through: `/cal:login icloud you@icloud.com --as home`.

## What happens

1. The provider's password rule is printed first. iCloud, Fastmail, Yahoo,
   AOL and (with two-factor on) Zoho want a generated app password — for
   iCloud and Fastmail the same one their mail takes. Forward Email wants the
   per-alias password. The rest take the account password.
2. The password is read without echo, or borrowed from a `mail` account with
   `--like`, since most providers use one password for both.
3. The calendars are discovered. A failed login stores nothing and names the
   likely cause.
4. The account lands in `~/.config/cli-tools/cal.json` (0600) under the
   provider's name, or `--as NAME`. The first account becomes the default.

## Not reachable with a password

Google Calendar takes only OAuth2 at its CalDAV endpoint, so a Gmail app
password opens the mailbox but not the calendar. Outlook.com and Microsoft
365 have no CalDAV. Proton Calendar has no CalDAV on any plan. `cal login
google` says so instead of failing a login.
