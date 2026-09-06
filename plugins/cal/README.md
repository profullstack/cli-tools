# cal

The calendar from the terminal, over CalDAV.

`/cal:login` signs in to iCloud, Fastmail, Zoho, Yahoo, AOL, GMX,
mailbox.org, Posteo, Forward Email, or any CalDAV server by URL (Nextcloud,
Radicale, Baïkal, Stalwart), saying which kind of password it wants and
finding the calendars before storing anything. `/cal:agenda` reads today,
the week or a range, and one event in full. `/cal:add` puts an event on and
takes one off.

## Install

```bash
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install cal@cli-tools
```

Or install the command directly, without the plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh
cal accounts pull            # accounts from the cli-tools-cal team vault
cal login forwardemail --like work   # or borrow the mail account's password
```

## The thing worth knowing

**No library, three requests.** CalDAV is PROPFIND to find the principal
and its calendars, REPORT to read a window, PUT and DELETE to write. The
server expands recurring events (`<C:expand>`), so a weekly standup shows on
every day it happens without this code implementing RRULE, and a removal is
of the whole series, which the command says before asking.

**The password is the same problem as mail.** iCloud and Fastmail refuse the
account password and want the app password their mail already uses, so
`--like <mail-account>` borrows it. Google is different: an app password
opens Gmail over IMAP, but Google's CalDAV endpoint takes only OAuth2, so
`cal login google` explains rather than fails.

**Nothing here names a person.** Accounts live in
`~/.config/cli-tools/cal.json` (0600) or in the vault as `CAL_<NAME>_EMAIL`
/ `_PROVIDER` / `_PASSWORD`; the environment's `CAL_<NAME>_PASSWORD` wins
over the stored one, and `cal accounts` never prints a password.
