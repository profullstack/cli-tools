---
description: Everything about one name — RDAP record, dates, nameservers, DNS, reverse PTR — as JSON.
allowed-tools: Bash(domainjson:*), Read
---

## Task

Look one name up in depth. Output is a single JSON object, so it pipes into
`jq` without reshaping.

```bash
domainjson example.com
domainjson --timeout 8000 test.hacker
domainjson -s https://rdap.nic.cz -t domain example.cz
```

```json
{ "name": "...", "rdap": { ... }, "dns": { "records": {}, "hosts": [], "reverse": [], "axfr": [] } }
```

## What you get

- **`rdap`** — the registry's own record: status flags, registration, expiry
  and last-changed dates, nameservers. This is where "is it actually
  registered?" is answered, and it is the reason a name with no DNS is still
  clearly taken.
- **`dns`** — `A`, `AAAA`, `CNAME`, `MX`, `TXT` and `NS` queried one type at a
  time (never `ANY`), plus reverse PTR for every resolved address and an AXFR
  attempt against each nameserver. A refused transfer is reported, never fatal.

Names ending in a [Moshpit](https://pit.moshcode.sh) TLD skip RDAP and are
served from the registry API under a `moshpit` key instead.

## Useful reads

```bash
# When does it expire, and who runs its DNS?
domainjson example.com | jq '.rdap.events, .rdap.nameservers'

# Registered, but is anything actually served?
domainjson example.com | jq '{status: .rdap.status, hosts: .dns.hosts}'
```

## Notes

Errors are JSON too — a tool whose output gets parsed should not change shape
on failure. If every data source fails, the exit status is non-zero and the
object carries an `error` key.

To check many names for availability rather than inspect one, use
`/domain:free`.
