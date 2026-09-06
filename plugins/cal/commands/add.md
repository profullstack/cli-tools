---
description: Put an event on the calendar, or take one off.
allowed-tools: Bash(cal:*), Read
---

## Task

Add an event, or remove one by uid.

```bash
cal add "Dentist" --at "tomorrow 9:30"                     # one hour, first calendar
cal add "Standup" --at "2026-09-07 09:00" --for 30m -c Work
cal add "Offsite" --at 2026-09-10 --all-day --for 2d --where "Lake house"
cal add "Call Sam" --at "fri 2pm" --end "fri 2:45pm" --notes "re: invoice" --link https://…
cal rm <uid>                                                # asks first; --yes skips it
```

`$ARGUMENTS` is passed through: `/cal:add "Dentist" --at "tomorrow 9:30"`.

## Before adding on someone's behalf

Say back the title, the day and the time you are about to send, in their
words, and get a yes. `--at` takes `2026-09-06 14:00`, `tomorrow 9:30`,
`friday 2pm`, `14:00` (today), or a bare day, which makes the event all-day.
A weekday name means the next one, never today. The default length is one
hour; `--for 30m`, `--for 1h30m`, `--for 2d`, or `--end`.

The event goes to the first calendar unless `-c` names one — check
`cal calendars` when the account has several, because "first" is the
server's order, not the user's favourite.

## Removing

`cal rm` looks the uid up first and shows the title and time before asking,
so a wrong uid is caught before anything happens. A recurring event is
removed whole — every occurrence — and the command says so first. There is
no undo; when in doubt, show it (`cal show <uid>`) and ask.
