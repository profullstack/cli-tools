#!/usr/bin/env bash
# Off-box copy of dev2's backups, pulled from another box (dev1) over ssh.
# Source of truth: cli-tools dev2/templates/dev2-backup-pull.sh, installed into the
# local crontab by `dev2-site backup-offbox-install`; do not edit the installed copy.
#
# The dumps are already pulled every 4 hours by ~/.local/bin/pull-dev2-backups.sh
# (dev1 crontab, into ~/backups/dev2). What that job does not carry is the
# Supabase Storage file tree dev2 mirrors daily; this one mirrors it with --delete
# so the copy follows dev2's own mirror. Runs after dev2's 05:20 UTC full job.
set -uo pipefail
SRC=${SRC:-root@23.95.228.174:/var/backups/postgres/storage/}
DEST=${DEST:-$HOME/backups/dev2/storage}
LOG=${LOG:-$HOME/backups/dev2-backup-pull.log}
say() { echo "$(date -u '+%F %T') $*" >> "$LOG"; }
mkdir -p "$DEST"
if rsync -a --delete --partial --timeout=600 -e "ssh -o BatchMode=yes -o ConnectTimeout=30" "$SRC" "$DEST/" 2>>"$LOG"; then
  say "ok   $(du -sh "$DEST" | cut -f1) of storage files in $DEST ($(ls "$DEST" | wc -l) sites)"
else
  say "ALERT rsync from dev2 failed (exit $?)"; logger -t dev2-backup-pull -p daemon.err "rsync from dev2 failed"; exit 1
fi
