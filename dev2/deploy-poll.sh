#!/usr/bin/env bash
#
# Deploy-on-merge for dev2 sites whose repo is PRIVATE, without GitHub Actions.
#
# Private profullstack repos cannot run Actions while the org bill is unpaid, and
# the generated `Deploy to dev2` workflow is an Action: it only ssh-es in and runs
# `~/www/<site>/deploy-app.sh <sha>`. This does the same from the box itself.
# Every run, for each /home/anthony/www/<site>/deploy.env whose REPO is a private
# repo, it reads the tip of the default branch with `git ls-remote` (the site's
# own deploy key, the same one deploy-app.sh clones with) and, when that is not
# what .deploy-state says is deployed, runs deploy-app.sh on it in the background.
# deploy-app.sh queues itself through deploy-gate, so a burst of merges still
# builds three at a time.
#
#   deploy-poll.sh            one pass (cron: every 2 minutes)
#   deploy-poll.sh --dry-run  print what it would deploy
#   deploy-poll.sh --status   one line per polled site
#
# A sha whose deploy failed is not retried until a newer commit lands, so a
# broken main costs one build, not one every two minutes. Logs:
# ~/.local/state/deploy-poll/<site>.log; the run log is poll.log beside them.
#
# Public repos are left to their Actions workflow, which still runs free; polling
# them as well would build every merge twice.
#
set -uo pipefail

WWW=${WWW:-/home/anthony/www}
STATE_DIR=${STATE_DIR:-$HOME/.local/state/deploy-poll}
OWNERS=${DEPLOY_POLL_OWNERS:-profullstack}
mkdir -p "$STATE_DIR"

mode=run
case "${1:-}" in
  --dry-run) mode=dry ;;
  --status) mode=status ;;
  "") ;;
  *) echo "usage: deploy-poll.sh [--dry-run|--status]" >&2; exit 2 ;;
esac

# One pass at a time; a slow ls-remote must not stack cron runs.
exec 9>"$STATE_DIR/.poll.lock"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATE_DIR/poll.log"; }

# owner/name of every private repo, refreshed hourly. A failed refresh keeps the
# last good list rather than polling nothing.
private_list() {
  local cache="$STATE_DIR/private-repos.txt" tmp owner
  if [ ! -s "$cache" ] || [ -n "$(find "$cache" -mmin +60 2>/dev/null)" ]; then
    tmp=$(mktemp "$STATE_DIR/.private.XXXXXX")
    for owner in ${OWNERS//,/ }; do
      gh repo list "$owner" --visibility private --no-archived --limit 1000 \
        --json nameWithOwner -q '.[].nameWithOwner' >> "$tmp" 2>/dev/null || { rm -f "$tmp"; tmp=; break; }
    done
    if [ -n "$tmp" ] && [ -s "$tmp" ]; then sort -u "$tmp" > "$cache"; fi
    [ -n "$tmp" ] && rm -f "$tmp"
  fi
  cat "$cache" 2>/dev/null
}

# git@github.com-alias:owner/name.git | https://github.com/owner/name.git -> owner/name
slug_of() { sed -E 's#^(git@[^:]+:|https://github\.com/)##; s#\.git$##' <<<"$1"; }

private=$(private_list)
[ -n "$private" ] || { log "no private repo list (gh failed and no cache); nothing polled"; exit 1; }

for env in "$WWW"/*/deploy.env; do
  site=$(basename "$(dirname "$env")")
  repo=$(sed -nE 's/^REPO=["'\'']?([^"'\'']*)["'\'']?$/\1/p' "$env" | tail -1)
  [ -n "$repo" ] || continue
  slug=$(slug_of "$repo")
  grep -qxiF "$slug" <<<"$private" || continue

  # Only sites that have been deployed once; a half-provisioned one is dev2-site's job.
  state="$WWW/$site/.deploy-state"
  [ -f "$state" ] || continue
  deployed=$(sed -n 's/^DEPLOYED_SHA=//p' "$state" | tail -1)

  tip=$(GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15" \
        timeout 45 git ls-remote "$repo" HEAD 2>/dev/null | awk '{print $1; exit}')
  failed=$(cat "$STATE_DIR/$site.failed" 2>/dev/null || true)

  if [ "$mode" = status ]; then
    s=current; [ -z "$tip" ] && s=unreachable
    [ -n "$tip" ] && [ "$tip" != "$deployed" ] && s=behind
    [ -n "$tip" ] && [ "$tip" = "$failed" ] && s="failed (waiting for a new commit)"
    printf '%-36s %-8.8s %-8.8s %s\n' "$site" "$deployed" "$tip" "$s"
    continue
  fi

  if [ -z "$tip" ]; then log "$site: ls-remote $slug failed"; continue; fi
  [ "$tip" = "$deployed" ] && continue
  [ "$tip" = "$failed" ] && continue

  if [ "$mode" = dry ]; then echo "would deploy $site $slug ${deployed:0:8} -> ${tip:0:8}"; continue; fi

  # Detached, one per site: a second pass while this builds sees the lock and skips.
  log "$site: deploying ${tip:0:8} (was ${deployed:0:8})"
  (
    exec 9>&-  # release the pass lock; the next pass must not wait out this build
    exec 8>"$STATE_DIR/$site.lock"
    flock -n 8 || exit 0
    {
      echo "===== $(date -u +%FT%TZ) deploy $tip"
      if "$WWW/$site/deploy-app.sh" "$tip"; then
        rm -f "$STATE_DIR/$site.failed"
        echo "===== ok"
        log "$site: ${tip:0:8} deployed"
      else
        echo "$tip" > "$STATE_DIR/$site.failed"
        echo "===== FAILED"
        log "$site: ${tip:0:8} FAILED, see $site.log"
      fi
    } >> "$STATE_DIR/$site.log" 2>&1
  ) </dev/null >/dev/null 2>&1 &
done
