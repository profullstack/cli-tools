#!/usr/bin/env bash
# Load a supabase-pull.sh dump into a site's self-hosted stack on dev2. Run as root on dev2.
#   DUMP=/root/dumps/<site>-supabase  DBC=<slug>-supabase-db  CLOUD_REF=<ref>  NEW_HOST=supabase.<site>
# From crawlproof.com/ops/selfhost/migrate/load-selfhost.sh, made generic: the
# absolute-storage-URL rewrite scans every text/json column instead of a fixed list.
set -euo pipefail
: "${DUMP:?}" "${DBC:?}" "${CLOUD_REF:?}" "${NEW_HOST:?}"
POST_ONLY=${POST_ONLY:-0}
# RESET=1 drops the app schemas (public and any other non-system schema the dump carries) plus
# the auth/storage ROWS before loading, so a fresh dump can replace an earlier load without
# duplicate-key errors. The stack's own auth/storage structure is untouched.
RESET=${RESET:-0}
log() { printf '\n===> %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ -d "$DUMP" ] || die "no dump at $DUMP"
psql_db() { docker exec -i "$DBC" psql -U postgres -h localhost -d postgres -X "$@"; }
psql_admin() { docker exec -i "$DBC" psql -U supabase_admin -h localhost -d postgres -X "$@"; }
strict() { psql_db -v ON_ERROR_STOP=1 "$@"; }
# psql -f /dev/stdin prefixes every message with "psql:/dev/stdin:N: ", so match ERROR after that too.
nerr() { grep -cE '^(psql:[^ ]*:[0-9]+: )?ERROR' "$1" 2>/dev/null || true; }
lerr() { grep -E '^(psql:[^ ]*:[0-9]+: )?ERROR' "$1" 2>/dev/null | sed -E 's/^psql:[^ ]*:[0-9]+: //' | sort | uniq -c | sort -rn | head -15 | sed 's/^/    /' || true; }
docker exec "$DBC" pg_isready -U postgres -h localhost >/dev/null || die "$DBC not ready"

log "Snapshot BEFORE"
strict -At -c "select 'tables='||(select count(*) from information_schema.tables where table_schema='public')||' users='||(select count(*) from auth.users)"

if [ "$POST_ONLY" = 0 ] && [ "$RESET" = 1 ]; then
  log "RESET: dropping app schemas and auth/storage rows from the earlier load"
  while read -r sch <&3; do [ -n "$sch" ] || continue
    psql_admin -v ON_ERROR_STOP=1 -c "drop schema if exists \"$sch\" cascade; create schema \"$sch\"; grant usage on schema \"$sch\" to anon, authenticated, service_role; grant all on schema \"$sch\" to postgres" >/dev/null && echo "    dropped+recreated schema $sch"
  done 3< "$DUMP/schemas.txt"
  psql_admin -v ON_ERROR_STOP=1 -c "truncate auth.users cascade" -c "truncate storage.buckets cascade" >/dev/null && echo "    auth.users / storage.buckets truncated"
  psql_admin -c "select cron.unschedule(jobname) from cron.job" >/dev/null 2>&1 || true
fi

if [ "$POST_ONLY" = 0 ]; then
  log "Extensions the cloud had"
  while read -r e <&3; do [ -n "$e" ] || continue; case $e in plpgsql|pg_graphql|pgsodium|supabase_vault|pg_stat_statements|pgjwt) continue;; esac
    psql_admin -v ON_ERROR_STOP=1 -c "create extension if not exists \"$e\" cascade" >/dev/null 2>&1 && echo "    $e" || echo "    $e: NOT AVAILABLE (dump may fail on objects using it)"; done 3< "$DUMP/extensions.txt"
  log "Schema"
  grep -qE 'CREATE SCHEMA "?(auth|storage)"?' "$DUMP/schema.sql" && die "schema.sql contains auth/storage DDL"
  psql_admin -f /dev/stdin < "$DUMP/schema.sql" > "$DUMP/schema.load.log" 2>&1 || true
  echo "    schema errors: $(nerr "$DUMP/schema.load.log")"; lerr "$DUMP/schema.load.log"
  log "Data (auth before app schemas)"
  a=$(grep -m1 -n 'COPY "auth"' "$DUMP/data.sql" | cut -d: -f1 || echo 0); p=$(grep -m1 -n 'COPY "public"' "$DUMP/data.sql" | cut -d: -f1 || echo 0); a=${a:-0}; p=${p:-0}
  if [ "$a" -gt 0 ] && [ "$p" -gt 0 ] && [ "$a" -gt "$p" ]; then die "data.sql has public before auth"; fi
  psql_admin -f /dev/stdin < "$DUMP/data.sql" > "$DUMP/data.load.log" 2>&1 || true
  echo "    data errors: $(nerr "$DUMP/data.load.log")"; lerr "$DUMP/data.load.log"
  log "Grants for anon/authenticated/service_role"
  psql_admin -f /dev/stdin < "$DUMP/grants.sql" > "$DUMP/grants.load.log" 2>&1 || true
  echo "    grant errors: $(nerr "$DUMP/grants.load.log")"; lerr "$DUMP/grants.load.log"
  log "Ownership: app schemas to postgres (they were created by supabase_admin)"
  psql_admin -At -v ON_ERROR_STOP=1 <<'SQL'
do $$ declare r record; begin
  for r in select nspname from pg_namespace where nspname not in ('pg_catalog','information_schema','pg_toast','auth','storage','realtime','_realtime','supabase_functions','supabase_migrations','graphql','graphql_public','extensions','vault','pgsodium','pgsodium_masks','cron','net','pgbouncer','_analytics','_supavisor') and nspname not like 'pg_%' loop
    execute format('alter schema %I owner to postgres', r.nspname);
    execute (select coalesce(string_agg(format('alter table %I.%I owner to postgres', schemaname, tablename), '; '), 'select 1') from pg_tables where schemaname=r.nspname);
    execute (select coalesce(string_agg(format('alter sequence %I.%I owner to postgres', sequence_schema, sequence_name), '; '), 'select 1') from information_schema.sequences where sequence_schema=r.nspname);
    execute (select coalesce(string_agg(format('alter view %I.%I owner to postgres', schemaname, viewname), '; '), 'select 1') from pg_views where schemaname=r.nspname);
    execute (select coalesce(string_agg(format('alter function %s owner to postgres', p.oid::regprocedure), '; '), 'select 1') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=r.nspname and p.prokind in ('f','p'));
  end loop; end $$;
SQL
fi

log "Buckets"
while IFS=$'\t' read -r id name pub limit mimes <&3; do [ -n "$id" ] || continue; case "$pub" in t|true) ps=true;; *) ps=false;; esac
  strict -c "insert into storage.buckets (id, name, public) values ('$id','$name',$ps) on conflict (id) do update set public=excluded.public" >/dev/null; done 3< "$DUMP/buckets.tsv"

log "Rewriting absolute https://$CLOUD_REF.supabase.co URLs to https://$NEW_HOST in every text/json column"
strict -At <<SQL
do \$\$ declare r record; n bigint; total bigint := 0; begin
  for r in select table_schema s, table_name t, column_name c, data_type d from information_schema.columns
           where table_schema not in ('pg_catalog','information_schema','auth','storage','realtime','_realtime','supabase_functions','supabase_migrations','graphql','graphql_public','extensions','vault','pgsodium','cron','net','_analytics','_supavisor')
             and data_type in ('text','character varying','jsonb','json')
             and (table_schema, table_name) in (select schemaname, tablename from pg_tables) loop
    if r.d in ('jsonb','json') then
      execute format('update %I.%I set %I = replace(%I::text, %L, %L)::%s where %I::text like %L', r.s, r.t, r.c, r.c, 'https://$CLOUD_REF.supabase.co', 'https://$NEW_HOST', r.d, r.c, '%$CLOUD_REF.supabase.co%');
    else
      execute format('update %I.%I set %I = replace(%I, %L, %L) where %I like %L', r.s, r.t, r.c, r.c, 'https://$CLOUD_REF.supabase.co', 'https://$NEW_HOST', r.c, '%$CLOUD_REF.supabase.co%');
    end if;
    get diagnostics n = row_count; if n > 0 then raise notice '% rows in %.%.%', n, r.s, r.t, r.c; total := total + n; end if;
  end loop; raise notice 'rewrote % rows', total; end \$\$;
SQL

log "Realtime publication"; psql_db -f /dev/stdin < "$DUMP/realtime.sql" 2>&1 | sed 's/^/    /' || true
log "pg_cron jobs"; psql_db -f /dev/stdin < "$DUMP/cron-jobs.sql" > "$DUMP/cron.load.log" 2>&1 || true
strict -At -c "select count(*)||' cron jobs active' from cron.job where active" 2>/dev/null || true

log "Snapshot AFTER (vs the cloud's estimates in counts-estimate.tsv)"
strict -At -F$'\t' -c "select n.nspname||'.'||c.relname, c.reltuples::bigint from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='public' order by 1" > "$DUMP/counts-after.tsv" || true
strict -At -c "select 'tables='||(select count(*) from information_schema.tables where table_schema='public')||' users='||(select count(*) from auth.users)||' identities='||(select count(*) from auth.identities)||' size='||pg_size_pretty(pg_database_size(current_database()))"
strict -c "analyze" >/dev/null 2>&1 || true
# PostgREST built its schema cache before these tables existed; without this every
# request answers PGRST205 "Could not find the table ... in the schema cache".
log "Reloading PostgREST's schema cache"
strict -c "notify pgrst, 'reload schema'" >/dev/null
docker restart "${DBC%-db}-rest" >/dev/null 2>&1 || true
log "Loaded."
