# dev2-site: Railway -> dev2, and deploy-on-merge afterwards

`dev2/dev2-site` moves one Railway-hosted site at a time onto **dev2**
(`dev2.profullstack.com`, 23.95.228.174), our production box, and leaves the
repo deploying there on every merge. It is the generalisation of the kits that
moved crawlproof.com (`crawlproof.com/ops/selfhost`), nichedb.dev
(`niche-db/ops/selfhost-supabase`) and rssamplifier.com.

Run it from dev1. **dev2 is production: this tool is the only thing that should
write to it.** Everything it writes is derived from Railway plus the templates
here, so re-running a step reproduces the box instead of drifting from it.

```
dev2-site registry               rebuild sites.json from Railway (projects, services, domains, volumes, DB variables)
dev2-site list [--kind pg|none|supabase|turso] [--status on-dev2]
dev2-site show <site>            registry entry + this site's state
dev2-site migrate <site> --yes   the whole move, resumable; each step below is also a subcommand
```

| step | what it does |
| --- | --- |
| `scaffold` | in the app repo: `.github/workflows/deploy-dev2.yml` (+ `.nixpacks/Dockerfile` from nixpacks when the repo has no Dockerfile, the same builder Railway used) on branch `ops/dev2-deploy`, pushed, PR opened |
| `db` | (kind `pg`) database in the shared Supabase cluster on dev2 (one database per app, role `postgres`, like nichedb and rssamplifier); `pg_dump -Fc` inside the Railway Postgres container over `ssh.railway.com`, streamed to dev2, `pg_restore`, extensions pre-created, row counts compared |
| `provision` | `/home/anthony/www/<site>/`: `app.env` rendered from Railway's variables (RAILWAY_* dropped, DATABASE_URL / PG* / REDIS_URL re-pointed), one `<worker>.env` per companion service, `deploy.env`, `docker-compose.app.yml`, `deploy-app.sh`; one deploy key per repo authorised for `anthony`; `DEV2_*` secrets set on the repo |
| `volumes` | Railway volume contents tar-streamed into `volumes/<name>`, bind-mounted at the same path |
| `deploy` | `deploy-app.sh <ref>` as `anthony`: build on the box, `compose up`, health on `127.0.0.1:<port><health_path>` |
| `cert` | acme.sh, Let's Encrypt, **Porkbun DNS-01**, every custom domain (+ www), into `/etc/nginx/ssl/<site>/`; issued before DNS moves so there is no TLS gap |
| `vhost` | nginx server block -> `127.0.0.1:<port>` |
| `verify` | curl each domain `--resolve`d to dev2; `--public` after the flip |
| `refresh-db` | (kind `pg`) re-copies the database seconds before the flip and restarts the app, so writes that landed on Railway during setup are not lost |
| `dns` | Porkbun: ALIAS/CNAME to Railway removed, `A -> 23.95.228.174` for every domain, `_railway-verify` TXT removed; the zone is backed up as JSON first |
| `railway-stop` | `deploymentRemove` + `serviceDisconnect` (or the next push silently redeploys on Railway) |
| `merge` | merges the scaffold PR; CI deploys the default branch to dev2 |
| `retire` | `--yes`: `serviceDelete` for the app, companions and data services. Only after `verify --public` |
| `supabase-stack` | (kind `supabase`, second pass) a self-hosted Supabase stack of its own under `~/www/<site>/supabase` (compose project `<slug>-supabase`, api `8200+n`, db `5500+n`, pooler `6600+n`, subnet `172.31.(100+n).0/24`, `n = port-3200`), public host `supabase.<site>` added to the site's cert/vhost/dns via `sites.d` |
| `supabase-pull` | dumps the cloud project through its session pooler (password from the app's `SUPABASE_DB_PASSWORD`, or `--reset-password` through the management API) into `/root/dumps/<slug>-supabase-<ts>` |
| `supabase-load` | loads it (extensions, schema, data, grants, buckets, absolute storage-URL rewrite over every text/json column, realtime, cron) |
| `supabase-storage` | copies every Storage object through the two Storage APIs (node in a container on dev2; resumable) |
| `supabase-cutover` | re-points the app (`env_overrides`: URLs, keys, db password), provision + deploy + verify, unschedules the cloud cron jobs |

| `firewall` | re-applies the data-port allowlist (5432 + every Supabase stack's db port) for dev1, loopback and all Docker pools |
| `box-tune` | sshd MaxStartups/MaxSessions for parallel deploys |

Image-only Railway services (a stock image plus a start command, no repo) are
supported through `sites.d`: `{"image": "node:24-alpine", "start_command": "..."}`;
the compose file uses `image:`/`command:` and `deploy-app.sh` skips clone and build
(`IMAGE_ONLY=1`). Companion services can be published on their own hostname with
`"companion_ports": {"name": {"host": 3361, "inside": 3000}}` plus a `proxies` entry.

Run at most about six migrations against the box at once: more than that, and
dev2 (or its provider) starts dropping this box's connections outright.

## Layout on the box (every site the same)

```
/home/anthony/www/<site>/
├── app/                     git checkout the deploy builds from
├── app.env                  the app's environment (0600, anthony)
├── <worker>.env             one per companion service
├── deploy.env               SITE REPO BRANCH APP_PORT BUILD_SERVICES HEALTH_PATH
├── docker-compose.app.yml   app (+ companions) (+ redis)
├── deploy-app.sh            what CI calls over ssh; --status, --rollback
├── volumes/<name>/          Railway volumes
└── .deploy-state
```

The box clones over ssh with a **read-only GitHub deploy key** (the same per-repo
key CI uses to reach dev2), under an alias `github.com-<org>__<repo>` in
`/home/anthony/.ssh/config`; https cloning fails for private repos because the
deploy account has no GitHub credential.

Ports are allocated once in `sites.json` from 3200 upwards (3010 nichedb, 3020
rssamplifier, 3100 crawlproof predate the kit). nginx is the only public face.

## Per-site overrides

`sites.d/<site>.json` is merged over the registry entry at load time. One
small file per site, so parallel migrations never edit a shared file:

```json
{ "health_path": "/healthz", "port_var": "8080", "start_command": "bun run start",
  "companion_commands": { "genrewatch-worker": "bun run worker" },
  "env_overrides": { "SITE_URL": "https://example.com" },
  "pg_service": "Postgres-iVtY", "max_body": "256m", "branch": "master" }
```

## Database kinds

- `pg`: Railway Postgres -> shared cluster (above). Done by the kit.
- `none`: nothing to move.
- `supabase`: the app keeps talking to Supabase cloud after the move; the
  database moves in a second pass onto a per-app self-hosted stack (see
  `crawlproof.com/ops/selfhost` for the shape: `setup-supabase.sh`,
  `pull-cloud.sh`, `load-selfhost.sh`, `sync-storage.mjs`). Then
  `env_overrides` + `provision` + `deploy` re-point the app.
- `turso`: the app keeps talking to Turso after the move; the database moves
  in a second pass with a Postgres port of the app's db layer (the pattern is
  rssamplifier.com `packages/db/src/pg.js`: serve the libSQL surface over pg).

## State

`~/.local/state/dev2-fleet/<site>.json` (steps done, database url, PR, dump
path), `deploy-keys/` (private halves; GitHub holds the copies), `dns/` (zone
backups before each flip).

## Traps already met

- Railway's `usage`/`variables` API rate-limits and tokens last an hour; the
  kit refreshes through `railway whoami`.
- A repo that squash-merged a branch makes a new PR from the same branch name
  CONFLICTING and CI silently never runs: rebase or use a fresh branch.
- `git add` with one missing pathspec stages nothing; the kit adds paths one
  by one.
- A duplicate standalone project (`tipoffwatch`) exists beside the live
  megaproject service (`tipoffwatch.com`); the registry keys by custom domain,
  so the duplicate is not a site.
