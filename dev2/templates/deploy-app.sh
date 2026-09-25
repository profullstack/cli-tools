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
# HEALTH_PATH. Builds happen on the box because NEXT_PUBLIC_*-style values are
# baked in at build time and live only in app.env here.
#
set -euo pipefail

ROOT=${ROOT:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}
APP_DIR="$ROOT/app"
STATE="$ROOT/.deploy-state"
# shellcheck disable=SC1091
. "$ROOT/deploy.env"
: "${REPO:?deploy.env needs REPO}"
: "${APP_PORT:?deploy.env needs APP_PORT}"
BUILD_SERVICES=${BUILD_SERVICES:-app}
HEALTH_PATH=${HEALTH_PATH:-/}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}

log() { printf '\n===> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() { (cd "$ROOT" && docker compose -f docker-compose.app.yml --env-file "$ROOT/deploy.env" "$@"); }

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

[ -f "$ROOT/app.env" ] || die "missing $ROOT/app.env (the app's secrets)"

CURRENT=""
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
# shellcheck disable=SC2086
compose build $BUILD_SERVICES

log "Starting"
compose up -d --remove-orphans

if health; then
  log "Healthy on 127.0.0.1:$APP_PORT$HEALTH_PATH"
  {
    echo "DEPLOYED_SHA=$SHA"
    echo "PREVIOUS_SHA=$CURRENT"
    echo "DEPLOYED_AT=$(date -u +%FT%TZ)"
  } > "$STATE"
  compose ps
else
  log "UNHEALTHY after ${HEALTH_TIMEOUT}s - last 60 lines:"
  compose logs --tail 60 || true
  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$SHA" ]; then
    log "Restoring $CURRENT"
    git -C "$APP_DIR" checkout -q --detach "$CURRENT"
    # shellcheck disable=SC2086
    compose build $BUILD_SERVICES && compose up -d
    health && log "Restored to $CURRENT" || log "ROLLBACK ALSO UNHEALTHY - site is down"
  fi
  die "deploy of $SHA failed health check"
fi
