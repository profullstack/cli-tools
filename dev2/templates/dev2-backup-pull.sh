#!/usr/bin/env bash
# Off-box copy of dev2's backups, pulled from another box (dev1) over ssh.
# Source of truth: cli-tools dev2/templates/dev2-backup-pull.sh, installed into the
# local crontab by `dev2-site backup-offbox-install`; do not edit the installed copy.
#
# Mirrors /var/backups/postgres (the 4-hourly cluster + per-site Supabase stack dumps
# and the daily storage-file mirror) with --delete, so this copy follows dev2's
# 7-day retention and never grows past it. Runs after dev2's 05:20 UTC full job.
set -uo pipefail
SRC=${SRC:-root@23.95.228.174:/var/backups/postgres/}
DEST=${DEST:-$HOME/backups/dev2-postgres}
LOG=${LOG:-$HOME/backups/dev2-backup-pull.log}
say() { echo "$(date -u '+%F %T') $*" >> "$LOG"; }
mkdir -p "$DEST"
if rsync -a --delete --partial --timeout=600 -e "ssh -o BatchMode=yes -o ConnectTimeout=30" "$SRC" "$DEST/" 2>>"$LOG"; then
  say "ok   $(du -sh "$DEST" | cut -f1) in $DEST, $(find "$DEST" -name '*.dump' | wc -l) dumps, newest $(ls -t "$DEST"/*.dump 2>/dev/null | head -1 | xargs -r basename)"
else
  say "ALERT rsync from dev2 failed (exit $?)"; logger -t dev2-backup-pull -p daemon.err "rsync from dev2 failed"; exit 1
fi
