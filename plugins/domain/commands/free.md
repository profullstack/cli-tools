---
description: Check which domains are actually registerable — registry truth, not a DNS guess.
allowed-tools: Bash(domainfree:*), Read, Write
---

## Task

Find out which of a set of domain names can actually be registered.

```bash
domainfree sorrycheck.com sinkstate.com
domainfree --file candidates.txt
domainfree --all example.com          # show TAKEN rows too
```

Only available names go to stdout, one per line, so the output pipes straight
into anything:

```bash
domainfree --file candidates.txt | head -20
domainfree --file candidates.txt | wc -l     # how many you could buy
```

## Naming a new project

Generate candidates first, then filter. The generation is the creative part;
this command is only the filter, and it is fast enough to be used on thousands
of names at a time — roughly 8,500 in 45 seconds at the default concurrency.

```bash
printf '%s\n' proofcheck.com sorrycheck.com qedcheck.com axiomcheck.com \
  | domainfree
```

## Why not just use dig

Because DNS cannot tell registration apart from configuration, and will hand
you names you cannot buy:

- A **parked** domain resolves fine and is taken.
- A domain registered with **no nameservers** returns `NXDOMAIN` — exactly what
  a name nobody owns returns.

Measured over 8,513 generated candidates, `dig NAME | grep "ANSWER: 0"` called
**20 registered domains free** while missing none that were genuinely free.
`oubliette.com` is the one to remember: registered in 1996, paid through 2034,
three nameservers, no `A` record — so `dig` reports `ANSWER: 0` and it reads as
available.

So DNS is a fine cheap prefilter and a bad buy signal. `domainfree` reads RDAP,
which is the registry's own record.

## Reading the result

An answer is only ever `AVAILABLE`, `TAKEN`, or `ERR:<code>`. A rate limit, a
5xx or a timeout is retried once and then reported as `ERR` — **never** as
available, because a name reported free that is not is the one failure that
wastes real time. Exit status is `2` if anything stayed indeterminate, so this
is usable as a gate.

## Before buying

Availability is a moment in time. Re-check immediately before registering, and
remember that if the project is already public under that name, the name is
worth securing sooner rather than later.

For everything about one name — RDAP record, registration and expiry dates,
nameservers, DNS records, reverse PTR — use `/domain:lookup` instead.
