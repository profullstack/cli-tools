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

Install / update: `scp -r dev2/c0mpute-gateway root@dev2.profullstack.com:/root/ && ssh root@dev2.profullstack.com /root/c0mpute-gateway/install.sh`
