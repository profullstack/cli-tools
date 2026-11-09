# dev2 c0mpute gateway self-healing

dev2's `c0mpute-worker.service` (user anthony, `~/.c0mpute/bin/c0mpute worker start`,
config `~/.config/c0mpute/config.toml`) is the gateway on `:7777`. nginx serves it as
`gateway.c0mpute.com`, and the Moshpit c0mpute edge (`moshpit-c0mpute-edge.service`,
profullstack/moshpit-proxy) serves every Moshpit name on c0mpute through it.

Layers, each with a Fibonacci schedule:

| layer | what heals | how |
|---|---|---|
| `c0mpute-worker` drop-in | the worker exits or is killed | `Restart=always`, no start limit, back-off 2 s .. 60 s |
| `c0mpute-gateway-watchdog.timer` | the worker runs but `/healthz` is dead, or someone stopped it | probes 1 1 2 3 5 s, then (re)starts the unit and waits 3 5 8 13 21 s |
| the edge (moshpit-proxy #33) | a gateway blip | retries 0.5 0.5 1 1.5 s, then the last good copy (`x-c0mpute-stale: 1`), then a 503 page |
| edge perms drop-in | a root `git pull` with umask 027 | `chmod -R a+rX` before every start |

**Do not run the gateway worker in a session shell.** It dies with the session. After a
config edit: `ssh root@dev2.profullstack.com systemctl restart c0mpute-worker`. To stop it on
purpose for longer than a minute, stop the timer too:
`systemctl stop c0mpute-gateway-watchdog.timer c0mpute-worker`.

## nginx: `gateway.c0mpute.com`

`nginx-gateway.c0mpute.com.conf` is the vhost (TLS on `127.0.0.1:8444` behind the
proxy-protocol listener). Everything goes to the local worker on `:7777` **except
`/git/`**, which goes to vienna (`http://dev.chovy.com:7777`, node AmaKBdpB, 2900 GiB
hosting budget). dev2's disk is full, so its own node's automatic hosting budget is 0
and it refused every `git push` with 507; a gateway has to hold a pushed repo before the
network copies it. Pushes are owner-signed and every file is hash-checked by the client,
so the plain-HTTP hop to vienna does not weaken them. `/git/` allows 1100 MB bodies (the
repo size limit plus headroom). If vienna goes away, point that block at another node
with room (seed1's :7777 is firewalled from outside).

Install / update: `scp -r dev2/c0mpute-gateway root@dev2.profullstack.com:/root/ && ssh root@dev2.profullstack.com /root/c0mpute-gateway/install.sh`
