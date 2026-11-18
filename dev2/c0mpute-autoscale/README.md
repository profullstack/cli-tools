# c0mpute-autoscale on dev2

Stops our rented Vast.ai GPU node while nobody needs it and starts it again when the
network has a job for its model. It is the general `c0mpute autoscale` feature
(c0mpute repo, `node/crates/c0mpute-cli/src/autoscale.rs`, docs at c0mpute.com/docs#autoscale);
this directory is only our own configuration of it.

**Our 3060 is `dry_run = true`** (Anthony 2026-11-18: keep it up 24/7). The unit only logs what
it would do (`[dry-run] ... would: Stop(...)`), so the idle hours it would have saved are on
record. Set `dry_run = false` to let it act; the policy below then applies.

| | |
|---|---|
| where | dev2, systemd **user** unit `c0mpute-autoscale.service` as anthony (never root) |
| node | Vast instance `61205210` "c0mpute-gpu-3060 profullstack", RTX 3060 12 GB, c0mpute node `sdNT3kCN`, serves `eriktonon/qwen3.8-uncensored:9b` |
| log | `journalctl --user -u c0mpute-autoscale` and `~/www/vast-autoscale/state.log` (every transition with its reason) |
| state | `~/.local/share/c0mpute/autoscale-state.json`; `c0mpute autoscale status` |
| dashboard | c0mpute.com/dashboard/nodes (reported with the fleet `C0MPUTE_API_KEY`) |

## Policy

- **Stop** after 20 min with no job won or finished by the node, nothing in flight,
  no auction for the 9B on the mesh in the last 2 min, `vast-hook.sh` saying idle
  (GPU < 10 % and no Ollama chat answer in 2 min), and at least 15 min since it
  started. Before the stop, `vast-hook.sh stop-worker` stops the worker so it bids on
  nothing, then the in-flight check runs once more.
- **Start** at once when an auction for the 9B is waiting with no taker, or was
  published in the last 2 min (any buyer: Infernet's bridge, c0mpute.com chat, agents).
- **Never** acts without the network signal (aggregator unreachable = hold).
- **Replacement**: a start that is not serving the 9B within 8 min (a stopped Vast
  instance can lose its GPU to another renter) rents the cheapest verified on-demand
  RTX 3060 / 3070 / 4060 Ti, >= 12 GB, reliability >= 0.98, at most **$0.12/h**
  (pre-approved; nothing above it is ever rented), boots it with `vast-onstart.sh`
  (the original `/root/onstart.sh` + `/root/c0mpute/start-gpu.sh`, plus the node identity
  from `$C0MPUTE_IDENTITY_KEY_B64` so it keeps node id `sdNT3kCN`), and destroys the dead
  instance only after the replacement serves the model. If the replacement does not
  come up in 16 min it is destroyed and the node goes to `error` (needs a person:
  `c0mpute autoscale reset vast-3060`).

## Money

Vast bills the disk while an instance is stopped: $0.0333/h of the $0.0867/h. A stopped
hour saves $0.0533; the most it can save is ~$1.28/day (~$38/month), and only for hours
the 9B is not in demand.

## Install / change

```
./install.sh            # copies config + hooks, enables the user unit
c0mpute autoscale once --dry-run
c0mpute autoscale status
```
