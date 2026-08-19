# domain

Two commands for working with domain names, both reading the registry rather
than guessing from DNS.

| Command | Does |
| --- | --- |
| `/domain:free` | Filter a list of names down to the ones you can actually register. |
| `/domain:lookup` | Everything about one name — RDAP record, dates, nameservers, DNS, reverse PTR — as JSON. |

## Install

```sh
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install domain@cli-tools
```

Both commands shell out to tools from this repo, so they need it installed and
linked:

```sh
pnpm install && pnpm link:bin
```

## Why RDAP and not dig

DNS cannot distinguish registration from configuration. A parked domain
resolves and is taken; a domain registered with no nameservers returns
`NXDOMAIN`, exactly like a name nobody owns.

Over 8,513 generated candidates, `dig NAME | grep "ANSWER: 0"` reported 20
registered domains as free and missed none that were genuinely free.
`oubliette.com` is the clearest case — registered in 1996, paid through 2034,
three nameservers, no `A` record.

Good enough as a cheap prefilter. Wrong as a buy signal.
