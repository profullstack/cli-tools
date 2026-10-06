#!/usr/bin/env bash
#
# Deploy one site under /home/anthony/www/<site> on dev2. GitHub Actions calls
# this over ssh on every merge; you run it by hand to roll forward or back.
#
#   deploy-app.sh <git-sha|ref>       build that revision and switch to it
#   deploy-app.sh --rollback          go back to the previously deployed sha
#   deploy-app.sh --status            what is deployed and healthy right now
#
# Everything site-specific comes from deploy.env beside this script (written by
# cli-tools/dev2/dev2-site provision): REPO, APP_PORT, BUILD_SERVICES,
# HEALTH_PATH, and VAULT. Builds happen on the box because NEXT_PUBLIC_*-style
# values are baked in at build time.
#
# Secrets: when deploy.env names a logicsrc team vault (VAULT=<project>--<env>,
# VAULT_TEAM defaults to profullstack), every deploy pulls it and writes it into
# app.env before building, so a secret is set by `logicsrc teams push` and the
# next deploy, never by editing this box. See sync_env_from_vault below.
#
set -euo pipefail

ROOT=${ROOT:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}
APP_DIR="$ROOT/app"
STATE="$ROOT/.deploy-state"
# shellcheck disable=SC1091
. "$ROOT/deploy.env"
: "${APP_PORT:?deploy.env needs APP_PORT}"
[ "${IMAGE_ONLY:-0}" = 1 ] || : "${REPO:?deploy.env needs REPO}"
BUILD_SERVICES=${BUILD_SERVICES:-app}
HEALTH_PATH=${HEALTH_PATH:-/}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}

log() { printf '\n===> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() { (cd "$ROOT" && docker compose -f docker-compose.app.yml --env-file "$ROOT/deploy.env" "$@"); }

# app.env from the logicsrc vault named by VAULT. The vault wins for every key it
# holds with a non-empty value; keys only app.env has (a DATABASE_URL minted on
# this box) stay; an empty vault value never blanks a live one (a vault cannot
# delete a key, so old keys get blanked there instead), and a key named in
# VAULT_SKIP (space-separated; dev2-site writes the site's env_remove) is never
# taken from the vault. The file before the
# merge is kept as app.env.prev, and only key NAMES are printed.
#
# Auth is whatever logicsrc on this box has: LOGICSRC_API_KEY when set (or the
# file ~/.config/logicsrc/deploy-api-key), else the account logged in here.
# A vault that cannot be read leaves app.env as it is and says so: the deploy
# goes on with the last good secrets rather than failing.
sync_env_from_vault() {
  [ -n "${VAULT:-}" ] || return 0
  local bin team project env tmp
  bin=$(command -v logicsrc || echo "$HOME/.local/bin/logicsrc")
  [ -x "$bin" ] || { log "VAULT=$VAULT but no logicsrc CLI on this box: app.env unchanged"; return 0; }
  team=${VAULT_TEAM:-profullstack}
  project=${VAULT%--*}; env=${VAULT##*--}
  [ -n "$project" ] && [ "$project" != "$VAULT" ] || { log "VAULT must be <project>--<env>, got '$VAULT': app.env unchanged"; return 0; }
  if [ -z "${LOGICSRC_API_KEY:-}" ] && [ -r "$HOME/.config/logicsrc/deploy-api-key" ]; then
    LOGICSRC_API_KEY=$(cat "$HOME/.config/logicsrc/deploy-api-key"); export LOGICSRC_API_KEY
  fi
  tmp=$(umask 077; mktemp "$ROOT/.vault-env.XXXXXX")
  if ! (cd "$ROOT" && "$bin" teams pull "$team" "$project" "$env" --env "$tmp" --format json >/dev/null 2>&1) || [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    log "Could not pull vault $team/$VAULT: app.env unchanged"
    return 0
  fi
  [ -f "$ROOT/app.env" ] || : > "$ROOT/app.env"
  local merged
  merged=$(umask 077; mktemp "$ROOT/.app-env.XXXXXX")
  # awk: first file is the vault, second app.env. Rewrite app.env in place order,
  # then append the vault keys it did not have.
  awk -v changes="$merged.changes" -v skip=" ${VAULT_SKIP:-} " '
    function key(l) { sub(/^[ \t]*export[ \t]+/, "", l); return substr(l, 1, index(l, "=") - 1) }
    function val(l) { v = substr(l, index(l, "=") + 1); gsub(/^[ \t]+|[ \t]+$/, "", v); return v }
    NR == FNR {
      if ($0 ~ /^[ \t]*#/ || index($0, "=") == 0) next
      k = key($0); v = val($0)
      if (index(skip, " " k " ")) next
      if (v == "" || v == "\"\"" || v == "\x27\x27") next
      vault[k] = $0; order[++n] = k; next
    }
    {
      if ($0 !~ /^[ \t]*#/ && index($0, "=") > 0) {
        k = key($0); seen[k] = 1
        if (k in vault) {
          if (vault[k] != $0) print "changed " k > changes
          print vault[k]; next
        }
      }
      print
    }
    END {
      for (i = 1; i <= n; i++) if (!(order[i] in seen)) { print vault[order[i]]; print "added " order[i] > changes }
    }
  ' "$tmp" "$ROOT/app.env" > "$merged"
  rm -f "$tmp"
  if [ -s "$merged.changes" ]; then
    (umask 077; cp "$ROOT/app.env" "$ROOT/app.env.prev"); chmod 600 "$ROOT/app.env.prev"
    chmod 600 "$merged"
    mv "$merged" "$ROOT/app.env"
    log "app.env from vault $VAULT: $(tr '\n' ' ' < "$merged.changes")"
  else
    rm -f "$merged"
    log "app.env already matches vault $VAULT"
  fi
  rm -f "$merged.changes"
}

# Rollback state. snapshot() records the image each running service container was
# started from (and pins it as <name>:rollback so a prune cannot take it); once the
# running stack is touched, any failure (the ERR trap, or a failed health check)
# re-tags those images and brings the old stack back up without building.
SNAP=()
CURRENT=""
snapshot() {
  local svc cid id ref
  for svc in $BUILD_SERVICES; do
    cid=$(compose ps -q "$svc" 2>/dev/null | head -n1) || true
    [ -n "$cid" ] || continue
    id=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null) || continue
    ref=$(docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null) || continue
    case $ref in *@*) continue ;; *:*) ;; *) ref="$ref:latest" ;; esac
    docker tag "$id" "${ref%:*}:rollback" >/dev/null 2>&1 || true
    SNAP+=("$id $ref")
  done
}

restore() {
  trap - ERR
  set +e
  if [ "${#SNAP[@]}" -eq 0 ]; then log "Nothing to roll back to (no running containers before this deploy)"; return 1; fi
  log "Rolling back to the previous image(s)"
  local p
  for p in "${SNAP[@]}"; do docker tag "${p%% *}" "${p#* }"; done
  [ -z "$CURRENT" ] || git -C "$APP_DIR" checkout -q --detach "$CURRENT"
  compose up -d --no-build --remove-orphans
  if health; then log "Restored the previous deploy"; return 0; fi
  log "ROLLBACK ALSO UNHEALTHY - site is down"
  return 1
}

on_err() {
  local rc=$? line=$1
  # errtrace runs this inside compose()'s subshell and $(...) too; leave the
  # rollback to the top-level shell, which sees the same failure next.
  [ "$BASH_SUBSHELL" = 0 ] || exit "$rc"
  trap - ERR
  log "Failed (exit $rc, line $line) after the running stack was touched"
  compose logs --tail 60 || true
  restore || true
  exit 1
}

health() {
  local i
  for i in $(seq 1 "$((HEALTH_TIMEOUT / 5))"); do
    # Any HTTP answer counts: a 3xx redirect or a 401 from the app is alive.
    if curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" | grep -Eq '^[1-4]'; then return 0; fi
    sleep 5
  done
  return 1
}

case "${1:-}" in
  --status)
    compose ps
    curl -sS -m 5 -o /dev/null -w 'app http %{http_code} in %{time_total}s\n' "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" || echo "app not answering"
    [ -f "$STATE" ] && cat "$STATE"
    exit 0
    ;;
  --rollback)
    [ -f "$STATE" ] || die "no deploy state to roll back to"
    # shellcheck disable=SC1090
    . "$STATE"
    [ -n "${PREVIOUS_SHA:-}" ] || die "no PREVIOUS_SHA recorded"
    log "Rolling back to $PREVIOUS_SHA"
    exec "$0" "$PREVIOUS_SHA"
    ;;
esac

TARGET=${1:?usage: deploy-app.sh <git-sha|ref> | --rollback | --status}

sync_env_from_vault
[ -f "$ROOT/app.env" ] || die "missing $ROOT/app.env (the app's secrets)"

if [ "${IMAGE_ONLY:-0}" = 1 ]; then
  # A stock image with Railway's start command: nothing to clone or build.
  log "Pulling image and starting"
  snapshot
  compose pull -q || true
  set -E; trap 'on_err $LINENO' ERR
  compose up -d --remove-orphans
  if health; then
    log "Healthy on 127.0.0.1:$APP_PORT$HEALTH_PATH"
    { echo "DEPLOYED_SHA=image"; echo "PREVIOUS_SHA="; echo "DEPLOYED_AT=$(date -u +%FT%TZ)"; } > "$STATE"
    compose ps; exit 0
  fi
  trap - ERR
  compose logs --tail 60 || true
  restore || true
  die "image-only deploy failed health check"
fi

[ -d "$APP_DIR/.git" ] && CURRENT=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "")

if [ ! -d "$APP_DIR/.git" ]; then
  log "First deploy: cloning $REPO"
  git clone --filter=blob:none "$REPO" "$APP_DIR"
fi

log "Fetching $TARGET"
git -C "$APP_DIR" fetch --all --tags --prune -q

# Resolve to a sha first: `checkout --detach <missing ref>` gives a useless
# error, and a bare branch name only resolves as origin/<name>.
SHA=$(git -C "$APP_DIR" rev-parse --verify --quiet "origin/$TARGET^{commit}" \
   || git -C "$APP_DIR" rev-parse --verify --quiet "$TARGET^{commit}" \
   || true)
[ -n "$SHA" ] || die "cannot resolve '$TARGET' to a commit"
git -C "$APP_DIR" checkout -q --detach "$SHA"
# The deploy account's umask leaves files 0640; an image that runs as a non-root
# user (node, bun) then dies with EACCES reading its own source. Railway's git
# uploads were world-readable, so match that.
chmod -R u+rwX,go+rX "$APP_DIR" 2>/dev/null || true
log "At $SHA"

log "Building $BUILD_SERVICES"
# Public build-time variables (NEXT_PUBLIC_*, VITE_*, ...) come from app.env through the
# compose build args; export just those so ${K} interpolates. app.env is a compose env
# file, not shell (unquoted values may contain spaces), so parse it line by line.
while IFS= read -r line || [ -n "$line" ]; do
  case $line in ''|'#'*) continue ;; esac
  key=${line%%=*}; val=${line#*=}
  case $key in
    NEXT_PUBLIC_*|VITE_*|PUBLIC_*|NUXT_PUBLIC_*|EXPO_PUBLIC_*|REACT_APP_*|SVELTEKIT_PUBLIC_*)
      case $val in \"*\") val=${val#\"}; val=${val%\"} ;; esac
      export "$key=$val" ;;
  esac
done < "$ROOT/app.env"
# A failed build exits here (set -e) before anything running is touched: `compose
# build` only moves the :latest tags when it succeeds.
# shellcheck disable=SC2086
compose build $BUILD_SERVICES || die "build of $SHA failed; the running stack was not touched"

# If the compose network's subnet changed (the kit moved sites to explicit
# 10.200.x.0/24 subnets), `up -d` recreates the network in place and Docker's
# embedded DNS then answers SERVFAIL for service aliases like `redis` while
# container names still resolve. A clean down/up avoids that.
WANT_SUBNET=$(grep -oE 'subnet: [0-9./]+' "$ROOT/docker-compose.app.yml" | awk '{print $2}' | head -n1 || true)
APP_CID=$(compose ps -q app 2>/dev/null | head -n1 || true)
RECREATE=0
if [ -n "$WANT_SUBNET" ] && [ -n "$APP_CID" ]; then
  NET=$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$APP_CID" 2>/dev/null | head -n1 || true)
  HAVE_SUBNET=$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)
  if [ -n "$HAVE_SUBNET" ] && [ "$HAVE_SUBNET" != "$WANT_SUBNET" ]; then
    log "Network subnet changes ($HAVE_SUBNET -> $WANT_SUBNET): recreating the stack"
    RECREATE=1
  fi
fi

# From here on the running stack is touched: any failure rolls back to the images
# it was running.
snapshot
set -E; trap 'on_err $LINENO' ERR
[ "$RECREATE" = 0 ] || compose down --remove-orphans

log "Starting"
compose up -d --remove-orphans

# Docker's embedded DNS can keep stale alias state after a network was recreated in
# place: container names resolve, service names (`redis`) answer SERVFAIL, and the app
# hangs at boot with a green health check. Prove every sibling service resolves from
# inside the app; if not, recreate the stack once.
APP_CID=$(compose ps -q app 2>/dev/null | head -n1)
if [ -n "$APP_CID" ]; then
  for svc in $(awk '/^services:/{f=1;next} /^[a-z]/{f=0} f && /^  [a-z][a-z0-9_-]*:$/{gsub(/[ :]/,""); print}' "$ROOT/docker-compose.app.yml" | grep -vx app); do
    if docker exec "$APP_CID" sh -c 'command -v getent >/dev/null' 2>/dev/null; then
      if ! docker exec "$APP_CID" sh -c "getent hosts $svc" >/dev/null 2>&1; then
        log "Service '$svc' does not resolve inside the app container (stale embedded DNS): recreating the stack"
        compose down --remove-orphans
        compose up -d --remove-orphans
        break
      fi
    fi
  done
fi

if health; then
  trap - ERR
  log "Healthy on 127.0.0.1:$APP_PORT$HEALTH_PATH"
  {
    echo "DEPLOYED_SHA=$SHA"
    echo "PREVIOUS_SHA=$CURRENT"
    echo "DEPLOYED_AT=$(date -u +%FT%TZ)"
  } > "$STATE"
  compose ps
else
  trap - ERR
  log "UNHEALTHY after ${HEALTH_TIMEOUT}s - last 60 lines:"
  compose logs --tail 60 || true
  restore || true
  die "deploy of $SHA failed health check"
fi
