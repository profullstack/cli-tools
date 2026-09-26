#!/usr/bin/env bash
# Dump a Supabase CLOUD project so it can be loaded into a self-hosted stack.
# Read-only against the cloud; run as root on dev2 (pg_dump through postgres:17).
#   CLOUD_DB_URL=postgres://postgres.<ref>:<pw>@aws-x-<region>.pooler.supabase.com:5432/postgres  OUT=/root/dumps/<site>-supabase
# From crawlproof.com/ops/selfhost/migrate/pull-cloud.sh, made generic: every
# non-system schema is dumped, not just public.
set -euo pipefail
: "${CLOUD_DB_URL:?}" "${OUT:?}"
PG_IMAGE=${PG_IMAGE:-postgres:17}
log() { printf '\n===> %s\n' "$*" >&2; }
mkdir -p "$OUT"; chmod 700 "$OUT"
pg() { docker run --rm -i --network host "$PG_IMAGE" "$@"; }
psqlc() { pg psql "$CLOUD_DB_URL" -At -X -v ON_ERROR_STOP=1 "$@"; }

log "Schemas"
SYS="'pg_catalog','information_schema','pg_toast','auth','storage','realtime','_realtime','supabase_functions','supabase_migrations','graphql','graphql_public','extensions','vault','pgsodium','pgsodium_masks','cron','net','pgbouncer','_analytics','_supavisor','pgmq','pgtle','repack','topology','tiger','tiger_data'"
psqlc -c "select nspname from pg_namespace where nspname not in ($SYS) and nspname not like 'pg_%' order by 1" > "$OUT/schemas.txt"
tr '\n' ' ' < "$OUT/schemas.txt"; echo
SCHEMA_ARGS=(); while read -r s; do [ -n "$s" ] && SCHEMA_ARGS+=(--schema="$s"); done < "$OUT/schemas.txt"

log "Extensions in use"
psqlc -c "select extname from pg_extension where extname not in ('plpgsql') order by 1" > "$OUT/extensions.txt"

log "Schema DDL (app schemas only; auth/storage structure belongs to the stack's own services)"
pg pg_dump --dbname="$CLOUD_DB_URL" --schema-only --no-owner --no-privileges --quote-all-identifiers "${SCHEMA_ARGS[@]}" > "$OUT/schema.sql"

log "Data (auth + app schemas + storage buckets)"
pg pg_dump --dbname="$CLOUD_DB_URL" --data-only --no-owner --no-privileges --quote-all-identifiers --disable-triggers \
  --schema=auth "${SCHEMA_ARGS[@]}" --schema=storage \
  --exclude-table-data='storage.objects' --exclude-table-data='storage.migrations' --exclude-table-data='storage.s3_multipart_uploads*' --exclude-table-data='storage.prefixes' \
  --exclude-table-data='auth.schema_migrations' --exclude-table-data='auth.audit_log_entries' --exclude-table-data='auth.refresh_tokens' --exclude-table-data='auth.sessions' --exclude-table-data='auth.flow_state' --exclude-table-data='auth.one_time_tokens' --exclude-table-data='auth.scim_*' \
  ${EXCLUDE_TABLE_DATA:-} > "$OUT/data.sql"

log "Grants and RLS policies (the schema dump drops privileges; PostgREST needs them back)"
psqlc -c "select 'grant '||privilege_type||' on '||quote_ident(table_schema)||'.'||quote_ident(table_name)||' to '||quote_ident(grantee)||';' from information_schema.role_table_grants where grantee in ('anon','authenticated','service_role') and table_schema not in ($SYS) order by 1" > "$OUT/grants.sql"
# Functions: "grant execute on function schema.name(argtypes)" -- routine_name alone is a relation to psql, so every
# grant failed before. A function with no PUBLIC execute on the cloud was locked down on purpose: revoke PUBLIC there too.
psqlc -c "select 'revoke execute on function '||p.oid::regprocedure::text||' from public;' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not in ($SYS) and n.nspname not like 'pg_%' and p.prokind in ('f','p') and p.proacl is not null and not exists (select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') order by 1" >> "$OUT/grants.sql" || true
psqlc -c "select 'grant execute on function '||p.oid::regprocedure::text||' to '||quote_ident(r.rolname)||';' from pg_proc p join pg_namespace n on n.oid=p.pronamespace join aclexplode(p.proacl) a on true join pg_roles r on r.oid=a.grantee where n.nspname not in ($SYS) and n.nspname not like 'pg_%' and p.prokind in ('f','p') and a.privilege_type='EXECUTE' and r.rolname in ('anon','authenticated','service_role') order by 1" >> "$OUT/grants.sql" || true
psqlc -c "select 'grant usage, select on all sequences in schema '||quote_ident(nspname)||' to anon, authenticated, service_role;' from pg_namespace where nspname not in ($SYS) and nspname not like 'pg_%'" >> "$OUT/grants.sql"

log "NOT VALID constraints (COPY would enforce them; the load drops them before data and re-adds them NOT VALID after)"
psqlc -c "select format('alter table %s drop constraint %I;', conrelid::regclass, conname) from pg_constraint where not convalidated and contype in ('c','f') and connamespace::regnamespace::text not in ($SYS) order by 1" > "$OUT/notvalid-drop.sql" || : > "$OUT/notvalid-drop.sql"
psqlc -c "select format('alter table %s add constraint %I %s not valid;', conrelid::regclass, conname, pg_get_constraintdef(oid)) from pg_constraint where not convalidated and contype in ('c','f') and connamespace::regnamespace::text not in ($SYS) order by 1" > "$OUT/notvalid-add.sql" || : > "$OUT/notvalid-add.sql"

log "Vault secrets (pg_cron http jobs read them)"
psqlc -F$'\t' -c "select name, decrypted_secret, coalesce(description,'') from vault.decrypted_secrets order by 1" > "$OUT/vault.tsv" 2>/dev/null || : > "$OUT/vault.tsv"
chmod 600 "$OUT/vault.tsv"

log "pg_cron jobs"
psqlc -c "select 'select cron.schedule(' || quote_literal(jobname) || ', ' || quote_literal(schedule) || ', ' || quote_literal(command) || ');' from cron.job where active order by jobid" > "$OUT/cron-jobs.sql" 2>/dev/null || : > "$OUT/cron-jobs.sql"

log "Realtime publication"
psqlc -c "select 'alter publication supabase_realtime add table ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ';' from pg_publication_tables where pubname='supabase_realtime'" > "$OUT/realtime.sql" || : > "$OUT/realtime.sql"

log "Storage inventory + buckets"
psqlc -F$'\t' -c "select b.id, b.public, o.name, coalesce((o.metadata->>'size')::bigint,0), coalesce(o.metadata->>'mimetype','application/octet-stream') from storage.buckets b join storage.objects o on o.bucket_id=b.id order by b.id, o.name" > "$OUT/storage-inventory.tsv"
psqlc -F$'\t' -c "select id, name, public, coalesce(file_size_limit::text,''), coalesce(array_to_string(allowed_mime_types,','),'') from storage.buckets order by id" > "$OUT/buckets.tsv"

log "Row counts (for the load to compare against)"
psqlc -F$'\t' -c "select n.nspname||'.'||c.relname, c.reltuples::bigint from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and (n.nspname in (select nspname from pg_namespace where nspname not in ($SYS) and nspname not like 'pg_%') or (n.nspname='auth' and c.relname in ('users','identities'))) order by 1" > "$OUT/counts-estimate.tsv"

{
  echo "dumped_at=$(date -u +%FT%TZ)"; echo "schema_bytes=$(stat -c%s "$OUT/schema.sql")"; echo "data_bytes=$(stat -c%s "$OUT/data.sql")"
  echo "storage_objects=$(wc -l < "$OUT/storage-inventory.tsv")"; echo "storage_bytes=$(awk -F'\t' '{s+=$4} END{print s+0}' "$OUT/storage-inventory.tsv")"
  echo "cron_jobs=$(grep -c '^select cron.schedule' "$OUT/cron-jobs.sql" || true)"; echo "auth_users=$(grep -c '' <(psqlc -c 'select id from auth.users'))"
  echo "notvalid_constraints=$(grep -c '^alter' "$OUT/notvalid-drop.sql" || true)"; echo "vault_secrets=$(grep -c '' "$OUT/vault.tsv" || true)"
} > "$OUT/MANIFEST"
log "Done: $OUT"; cat "$OUT/MANIFEST"
