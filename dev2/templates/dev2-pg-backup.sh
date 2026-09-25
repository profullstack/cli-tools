#!/usr/bin/env bash
#
# Backups for the self-hosted cluster on dev2, the per-site Supabase stacks and
# their storage files. Source of truth: cli-tools dev2/templates/dev2-pg-backup.sh,
# installed by `dev2-site backup-install`; do not edit on the box.
#
#   dev2-pg-backup.sh frequent   every 4 hours (cron)
#   dev2-pg-backup.sh full       once a day (cron)
#
# WHY TWO MODES. "Back up every database every four hours" is the right
# instinct but not literally affordable: nichedb is ~165 GB and rssamplifier
# will be ~40-50 GB, and six full dumps a day of those would outgrow the disk
# in days. The split keeps the 4-hour recovery point for everything that
# cannot be re-derived, and takes the bulk catalogues once a day.
#
# The excluded tables are all re-importable from public sources. Critically,
# `sources` in nichedb is NOT excluded: it holds the adapter config and the
# import cursors, which is what makes re-running an importer cheap rather than
# a restart from zero. Scoping agreed with the session that owns those
# databases; do not widen the exclusions without asking it.
#
# RETENTION is 7 days for both classes. That is cheap for the frequent dumps
# (~700 MB a run) and expensive for the daily fulls, because seven copies of
# the bulk databases is hundreds of GB. The script therefore warns when the
# backup directory passes BACKUP_WARN_GB, rather than letting backups cause
# the disk outage they exist to protect against.
#
# Every dump is checked with `pg_restore --list` before it counts as good. A
# pg_dump can exit 0 and still be truncated if the disk fills, and a backup
# that cannot be read is worse than none because it buys false confidence.
set -uo pipefail

MODE=${1:-frequent}
OUT=${OUT:-/var/backups/postgres}
LOG=${LOG:-/var/log/dev2-pg-backup.log}
# Both classes roll on age, not count: "7 days of history" should mean the
# same thing whichever dump you reach for.
KEEP_FREQUENT_DAYS=${KEEP_FREQUENT_DAYS:-7}
KEEP_FULL_DAYS=${KEEP_FULL_DAYS:-7}
# Backups that quietly eat the disk would cause the outage they exist to
# prevent. Flag it well before the disk alarm would.
BACKUP_WARN_GB=${BACKUP_WARN_GB:-450}
# A database with no policy that is bigger than this gets flagged rather than
# silently dumped in full every four hours.
UNPOLICIED_WARN_GB=${UNPOLICIED_WARN_GB:-5}

mkdir -p "$OUT"
stamp=$(date -u +%Y%m%d-%H%M%S)
say() { echo "$(date -u '+%F %T') [$MODE] $*" >> "$LOG"; }
alert() { logger -t dev2-pg-backup -p daemon.err "$*"; say "ALERT $*"; }

psql_q() { docker exec -i supabase-db psql -U postgres -h localhost -d postgres -X -At -c "$1" 2>/dev/null; }

# Tables excluded from the FREQUENT dump of each database. Everything here is
# re-derivable from public dumps or re-crawlable; everything not here is not.
exclusions_for() {
  case "$1" in
    nichedb)      echo "public.items" ;;
    rssamplifier) echo "public.feed_items public.item_extracts public.feed_keywords" ;;
    *)            echo "" ;;
  esac
}

# Databases big enough that a full copy belongs in the daily job, not the
# 4-hourly one.
is_bulk() { [ -n "$(exclusions_for "$1")" ]; }

dbs=$(psql_q "select datname from pg_database where not datistemplate and datallowconn order by datname")
[ -n "$dbs" ] || { alert "cannot list databases — postgres unreachable"; exit 1; }

rc=0
for db in $dbs; do
  size_gb=$(psql_q "select (pg_database_size('$db')/1024/1024/1024)::int")
  excl=$(exclusions_for "$db")

  if [ "$MODE" = full ]; then
    # The daily job only exists to capture the bulk tables the frequent job
    # skips. Databases with no exclusions are already complete every 4 hours.
    is_bulk "$db" || continue
    f="$OUT/${db}-full-${stamp}.dump"
    args=()
  else
    f="$OUT/${db}-${stamp}.dump"
    args=()
    for t in $excl; do args+=(--exclude-table="$t"); done
    # An unknown database that is large would quietly cost a full dump six
    # times a day. Back it up, but say so.
    if [ -z "$excl" ] && [ "${size_gb:-0}" -ge "$UNPOLICIED_WARN_GB" ]; then
      alert "$db is ${size_gb}GB with no exclusion policy — it is being dumped in full every 4h; add a policy to exclusions_for()"
    fi
  fi

  if docker exec -i supabase-db pg_dump -U postgres -h localhost -Fc "${args[@]}" -d "$db" > "$f" 2>>"$LOG"; then
    sz=$(du -h "$f" | cut -f1)
    if docker exec -i supabase-db pg_restore --list < "$f" >/dev/null 2>&1; then
      say "ok   $db $sz${excl:+ (excluding:$excl)}"
    else
      alert "$db dump is unreadable by pg_restore"
      rc=1
    fi
  else
    alert "pg_dump failed for $db"
    rm -f "$f"
    rc=1
  fi
done

# Per-site self-hosted Supabase stacks (<slug>-supabase-db). Their cloud projects are
# deleted, so these dumps are the only copy of auth, storage metadata and app data.
# Whole `postgres` database as supabase_admin (the superuser in the docker image);
# small stacks every 4h, anything over UNPOLICIED_WARN_GB daily only.
stack_names=""
for c in $(docker ps --format '{{.Names}}' | grep -E -- '-supabase-db$' | sort); do
  slug=${c%-supabase-db}; name="${slug}-supabase"; stack_names="$stack_names $name"
  size_gb=$(docker exec -i "$c" psql -U supabase_admin -h localhost -d postgres -X -At -c "select (pg_database_size('postgres')/1024/1024/1024)::int" 2>/dev/null)
  if [ "$MODE" = full ]; then
    [ "${size_gb:-0}" -ge "$UNPOLICIED_WARN_GB" ] || continue
    f="$OUT/${name}-full-${stamp}.dump"
  else
    if [ "${size_gb:-0}" -ge "$UNPOLICIED_WARN_GB" ]; then say "skip $name (${size_gb}GB, daily full only)"; continue; fi
    f="$OUT/${name}-${stamp}.dump"
  fi
  if docker exec -i "$c" pg_dump -U supabase_admin -h localhost -Fc -d postgres > "$f" 2>>"$LOG"; then
    if docker exec -i "$c" pg_restore --list < "$f" >/dev/null 2>&1; then
      say "ok   $name $(du -h "$f" | cut -f1)"
    else
      alert "$name dump is unreadable by pg_restore"; rc=1
    fi
  else
    alert "pg_dump failed for $name"; rm -f "$f"; rc=1
  fi
done

# Storage object files (Supabase Storage keeps them on disk under each stack's
# volumes/storage, the shared cluster's included). Mirrored once a day, never
# deleting on the mirror side, so a deleted object survives until the mirror is
# rebuilt by hand.
if [ "$MODE" = full ]; then
  for d in /home/anthony/www/*/supabase/volumes/storage; do
    [ -d "$d" ] || continue
    site=$(basename "$(dirname "$(dirname "$(dirname "$d")")")")
    mkdir -p "$OUT/storage/$site"
    if rsync -a "$d/" "$OUT/storage/$site/" 2>>"$LOG"; then
      say "ok   storage $site $(du -sh "$OUT/storage/$site" | cut -f1)"
    else
      alert "rsync failed for $site storage"; rc=1
    fi
  done
fi

# Retention: both classes roll on age, 7 days each by default.
find "$OUT" -name '*-[0-9]*.dump' ! -name '*-full-*' -mtime +"$KEEP_FREQUENT_DAYS" -delete 2>/dev/null

# Fulls also roll on age, but never delete the newest one for a database. If
# the daily job were broken for a fortnight, pure age-based expiry would
# cheerfully leave that database with no complete backup at all — exactly when
# you most need one.
for db in $dbs $stack_names; do
  newest=$(ls -1t "$OUT/${db}-full-"*.dump 2>/dev/null | head -1)
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    [ "$old" = "$newest" ] && continue
    rm -f "$old"
  done < <(find "$OUT" -name "${db}-full-*.dump" -mtime +"$KEEP_FULL_DAYS" 2>/dev/null)
done

total=$(du -sh "$OUT" 2>/dev/null | cut -f1)
total_gb=$(du -s --block-size=1G "$OUT" 2>/dev/null | cut -f1)
avail=$(df -h --output=avail / | tail -1 | tr -d ' ')
say "retained $(ls -1 "$OUT"/*.dump 2>/dev/null | wc -l) dumps, $total total, $avail free on /"
if [ "${total_gb:-0}" -ge "$BACKUP_WARN_GB" ]; then
  alert "backups are using ${total_gb}GB (warn at ${BACKUP_WARN_GB}GB). Seven days of full dumps of the bulk databases is the likely cause — shorten KEEP_FULL_DAYS or move them off-box."
fi

# Backups are useless if they are all on the machine that fails. Say so every
# run so it is never quietly forgotten.
say "NOTE same-box only — does not survive losing dev2; off-box copy still missing"
exit $rc
