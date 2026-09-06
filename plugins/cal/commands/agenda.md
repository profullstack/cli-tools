---
description: What is on the calendar today, this week, or between two dates, and the details of one event.
allowed-tools: Bash(cal:*), Read
---

## Task

Read the calendar from the terminal. Times print in this machine's zone.

```bash
cal ls                                   # the next 7 days, every calendar in the default account
cal ls --today
cal ls --tomorrow
cal ls --week -c Work                    # one calendar, by name
cal ls --from 2026-10-01 --to 2026-10-15
cal ls --days 30 --json                  # uids are in the JSON
cal show <uid>                           # title, when, where, notes, uid
cal calendars                            # what the account has
cal ls -a home                           # another account
```

`$ARGUMENTS` is passed through: `/cal:agenda --today -a home`.

## How to answer with it

For "what's on today / this week", run `cal ls --today` or `cal ls --week`
and relay the lines as they are — they are already grouped by day with the
time first. Recurring events arrive as one line per occurrence, because the
server expands them; do not add up occurrences as if they were separate
events. `(cancelled)` at the end of a line is the event's status, not a
change you made.

## Setting up

```bash
cal accounts pull                        # import from the cli-tools-cal team vault
cal login icloud you@icloud.com          # or sign in; says which password it wants
cal login forwardemail --like work       # reuse the `mail` account's address and password
```

Google Calendar cannot be added: its CalDAV takes only OAuth2, and an app
password opens Gmail but not the calendar. `cal providers` lists what can.
