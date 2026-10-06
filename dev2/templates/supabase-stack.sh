#!/usr/bin/env bash
#
# Stand up ONE self-hosted Supabase stack for one site on dev2, beside the
# others. Run as root ON dev2 by `dev2-site supabase-stack <site>`, which passes
# everything below in the environment. Idempotent: re-running keeps the
# generated secrets and data and only rewrites the overlay before restarting.
#
# Derived from crawlproof.com/ops/selfhost/server/setup-supabase.sh. What differs:
# every stack gets its own compose project name, container names, ports and
# subnet, so twenty of them coexist on the box; Postgres is sized small (many
# stacks share the RAM); the system/backup/alarm parts are not here (the box is
# already set up).
#
#   SITE            example.com            SLUG example-com
#   ROOT            /home/anthony/www/example.com
#   STUDIO_DOMAIN   supabase.example.com   SITE_URL https://example.com
#   API_PORT DB_PORT POOLER_PORT            host ports (loopback for API/pooler, public+firewalled for DB)
#   SUBNET GATEWAY                          172.31.N.0/24 and .1
#   SMTP_PASS SMTP_SENDER SMTP_ADMIN        optional (Resend)
#   SUPABASE_REF    self-hosted/v0.8.2
#   DROP_SERVICES   optional services left out of the stack (default: studio meta imgproxy supavisor
#                   realtime functions; dev2-site passes the set minus sites.d keep_services)
#   MODE            full (default: set up / repair the stack) | services (only re-render the overlay
#                   and apply it: drop or restore optional services on a running stack)
#   ALLOW_RECREATE  MODE=services: services (never db) that may be recreated by the apply
#   DRY_RUN=1       MODE=services: show what would change, touch nothing
#
# Lean stacks. The apps on dev2 talk to Supabase through the gateway (auth, rest,
# realtime, storage, functions) or straight to db. Studio (dashboard), meta
# (postgres-meta, studio's backend, /pg/), imgproxy (storage image transforms,
# /storage/v1/render/) and supavisor (pooler, loopback only) cost ~300 MiB per stack
# and nothing used them (measured 2026-10-01), so they are dropped unless the site's
# sites.d lists them in "keep_services". Dropping a service is a `!reset null` in the
# overlay; depends_on and profiles are not part of compose's config hash, so the
# remaining containers are not recreated. storage's ENABLE_IMAGE_TRANSFORMATION/
# IMGPROXY_URL are left alone on purpose (changing them recreates storage); without
# imgproxy a /render/ request fails instead of transforming.
#
# realtime (~250 MiB, most of it in swap) and functions (the edge runtime) are optional
# too: of 21 stacks only 5 apps open /realtime/v1 websockets and only saasrow calls
# /functions/v1 (gateway logs 2026-09-25..10-01 + each repo's code). Nothing in the
# base compose depends on either; the gateway answers 503 on their routes once they
# are gone and keeps serving auth/rest/storage.
set -euo pipefail

: "${SITE:?}" "${SLUG:?}" "${ROOT:?}" "${STUDIO_DOMAIN:?}" "${SITE_URL:?}" "${API_PORT:?}" "${DB_PORT:?}" "${POOLER_PORT:?}" "${SUBNET:?}" "${GATEWAY:?}"
OPTIONAL_SERVICES="studio meta imgproxy supavisor realtime functions"
DROP_SERVICES=${DROP_SERVICES-$OPTIONAL_SERVICES}
MODE=${MODE:-full}
for d in $DROP_SERVICES; do case " $OPTIONAL_SERVICES " in *" $d "*) ;; *) printf 'ERROR: %s is not optional (only: %s)\n' "$d" "$OPTIONAL_SERVICES" >&2; exit 1;; esac; done
SUPABASE_REF=${SUPABASE_REF:-self-hosted/v0.8.2}
PROJECT=supabase
DIR="$ROOT/$PROJECT"
DB_DOMAIN=${DB_DOMAIN:-dev2.profullstack.com}
PG_UID=100; PG_GID=101
ALLOW_IPS=${ALLOW_IPS:-67.205.189.229}

log() { printf '\n===> %s\n' "$*" >&2; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
dropped() { case " $DROP_SERVICES " in *" $1 "*) return 0;; esac; return 1; }
# <name>.bak-NNN.<ext> beside the original (a dotfile without an extension: .env.bak-NNN)
backup_ext() { local f=$1 d b stem ext n=1; [ -e "$f" ] || return 0; d=$(dirname "$f"); b=$(basename "$f")
  case "$b" in .*.*|[!.]*.*) stem=${b%.*}; ext=.${b##*.};; *) stem=$b; ext=;; esac
  while [ -e "$d/$stem.bak-$(printf %03d $n)$ext" ]; do n=$((n+1)); done; cp -a "$f" "$d/$stem.bak-$(printf %03d $n)$ext"; echo "$d/$stem.bak-$(printf %03d $n)$ext"; }
backup() { local f=$1 n=1; [ -e "$f" ] || return 0; while [ -e "$f.bak-$(printf %03d $n)" ]; do n=$((n+1)); done; cp -a "$f" "$f.bak-$(printf %03d $n)"; }
set_env() { local k=$1 v=$2; if grep -q "^$k=" "$DIR/.env"; then awk -v k="$k" -v v="$v" 'BEGIN{FS="="} $1==k {print k "=" v; next} {print}' "$DIR/.env" > "$DIR/.env.tmp" && mv "$DIR/.env.tmp" "$DIR/.env"; else printf '%s=%s\n' "$k" "$v" >> "$DIR/.env"; fi; }
get_env() { grep "^$1=" "$DIR/.env" | head -n1 | cut -d= -f2-; }
# Files the overlay names in env_file must exist, empty is fine. auth.env holds a
# site's GOTRUE_* extras (e.g. GOTRUE_SMS_PROVIDER=twilio + its credentials for
# phone sign-in), which the base compose file only ships commented out.
ensure_env_files() {
  [ -f "$DIR/volumes/functions/secrets.env" ] || { install -d "$DIR/volumes/functions"; (umask 077; : > "$DIR/volumes/functions/secrets.env"); }
  [ -f "$DIR/volumes/auth/auth.env" ] || { install -d "$DIR/volumes/auth"; (umask 077; : > "$DIR/volumes/auth/auth.env"); }
}
compose() { (cd "$DIR" && docker compose "$@"); }
DBC="$SLUG-supabase-db"
sql_admin() { docker exec -i "$DBC" psql -U supabase_admin -h localhost -d postgres -v ON_ERROR_STOP=1 -X -q -At "$@"; }

# Lines the lean profile owns, one per line and tagged "# lean:" so a re-apply can strip them.
reset_line() { echo "  $1: !reset null   # lean: not used here; list it in sites.d keep_services to restore"; }
lean_lines() {
  case $1 in
    api-gw)  dropped studio && echo "    depends_on: !reset {}   # lean: the base waits for a healthy studio" ;;
    storage) dropped imgproxy && echo "    depends_on: !override {db: {condition: service_healthy}, rest: {condition: service_started}}   # lean: no imgproxy" ;;
  esac
  return 0
}

# The overlay for a new stack: own project name, container names, ports, subnet; optional services dropped.
render_overlay() {
  echo "# $SITE: managed by cli-tools dev2/templates/supabase-stack.sh"
  echo "name: $SLUG-supabase"
  echo "services:"
  for svc in studio api-gw auth rest realtime storage imgproxy meta functions db supavisor; do
    if dropped "$svc"; then reset_line "$svc"; continue; fi
    echo "  $svc:"
    lean_lines "$svc"
    echo "    container_name: $SLUG-supabase-$svc"
    case $svc in
      realtime) echo "    networks:"; echo "      default:"; echo "        aliases: [realtime-dev.supabase-realtime, realtime]" ;;
      api-gw)   echo "    networks:"; echo "      default:"; echo "        aliases: [envoy, kong]"; echo "    ports: !override"; echo "      - \"127.0.0.1:${API_PORT}:8000/tcp\"" ;;
      supavisor) echo "    ports: !override"; echo "      - \"127.0.0.1:${POOLER_PORT}:6543\"" ;;
      storage)  echo "    environment:"; echo "      FILE_SIZE_LIMIT: 5368709120" ;;   # the base file pins 50 MiB; buckets declare up to GiBs
      auth)     echo "    env_file:"; echo "      - ./volumes/auth/auth.env" ;;   # per-site GOTRUE_* extras the base file leaves commented (SMS provider, hooks); environment: still wins
      functions) echo "    env_file:"; echo "      - .env"; echo "      - ./volumes/functions/secrets.env" ;;   # cloud function secrets (supabase-functions)
      db) echo "    shm_size: 512m"; echo "    ports: !override"; echo "      - \"${DB_PORT}:5432\""; echo "    volumes:"
          echo "      - ./volumes/$SLUG/$SLUG.conf:/etc/postgresql-custom/conf.d/zz-$SLUG.conf:ro,z"
          echo "      - ./volumes/$SLUG/pg_hba.conf:/etc/$SLUG/pg_hba.conf:ro,z"
          echo "      - ./volumes/$SLUG/tls:/etc/$SLUG/tls:ro,z" ;;
    esac
  done
  echo "networks:"
  echo "  default:"
  echo "    ipam:"
  echo "      config:"
  echo "        - subnet: $SUBNET"
  echo "          gateway: $GATEWAY"
}

# The live overlay with the service set applied and NOTHING else changed: a dropped
# service's block becomes `!reset null`, a restored one gets the template's block, every
# other block is kept byte for byte (stacks predate later template additions, and
# re-rendering them would recreate their containers), apart from the "# lean:" lines.
lean_overlay() {
  local live=$1 tmpd svc
  tmpd=$(mktemp -d)
  awk -v d="$tmpd" '
    BEGIN { out = d "/00-head"; insvc = 0 }
    /^services:/ { print > out; insvc = 1; next }
    insvc && /^  [a-z][a-z0-9_-]*:/ { n = $1; sub(/:.*/, "", n); out = d "/svc-" n; print n >> (d "/order"); print > out; next }
    insvc && /^[^ #]/ { insvc = 0; out = d "/zz-tail" }
    { print > out }' "$live"
  DROP_SERVICES='' render_overlay > "$tmpd/full"
  cat "$tmpd/00-head"
  while read -r svc; do
    if dropped "$svc"; then reset_line "$svc"; continue; fi
    if head -n1 "$tmpd/svc-$svc" | grep -q '!reset'; then   # restored: the template's block
      awk -v s="  $svc:" '$0 == s { on = 1; print; next } on && /^(  [a-z]|[a-z])/ { exit } on' "$tmpd/full" > "$tmpd/blk"
    else
      grep -v '# lean:' "$tmpd/svc-$svc" > "$tmpd/blk" || true
    fi
    head -n1 "$tmpd/blk"; lean_lines "$svc"; tail -n +2 "$tmpd/blk"
  done < "$tmpd/order"
  [ -f "$tmpd/zz-tail" ] && cat "$tmpd/zz-tail"
  rm -rf "$tmpd"
}

# ------------------------------------------- MODE=services: apply the overlay only
# Apply the service set to a RUNNING stack's own overlay without touching anything
# else (.env, postgres config, roles, firewall). Gate: every remaining service's
# new config hash must equal its running container's, so `up` only removes the
# dropped services (or creates restored ones). db is never recreated here.
if [ "$MODE" = services ]; then
  [ -f "$DIR/.env" ] && [ -f "$DIR/docker-compose.$SLUG.yml" ] || die "no stack at $DIR; run the full supabase-stack first"
  cd "$DIR"; ensure_env_files
  new="$DIR/.docker-compose.$SLUG.yml.new"; (umask 027; lean_overlay "$DIR/docker-compose.$SLUG.yml" > "$new")
  # every file COMPOSE_FILE lists, with this overlay swapped for the new one
  fargs=(); IFS=: read -ra cfs <<< "$(get_env COMPOSE_FILE)"; [ ${#cfs[@]} -gt 0 ] || die "no COMPOSE_FILE in $DIR/.env"
  for f in "${cfs[@]}"; do [ "$f" = "docker-compose.$SLUG.yml" ] && f=$new; fargs+=(-f "$f"); done
  hashes=$(docker compose "${fargs[@]}" config --hash '*') || { rm -f "$new"; die "the new overlay does not render"; }
  services=$(docker compose "${fargs[@]}" config --services)
  log "Plan for $SLUG-supabase (dropping: ${DROP_SERVICES:-none})"
  bad=; recreate=
  while read -r svc h; do
    [ -n "$svc" ] || continue
    cid=$(docker ps -aq --filter "label=com.docker.compose.project=$SLUG-supabase" --filter "label=com.docker.compose.service=$svc" | head -n1)
    if [ -z "$cid" ]; then echo "  create   $svc"; continue; fi
    cur=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$cid")
    if [ "$cur" = "$h" ]; then echo "  keep     $svc (config unchanged)"
    elif [ "$svc" = db ]; then echo "  RECREATE db  <- refused"; bad=1
    else case " ${ALLOW_RECREATE:-} " in *" $svc "*) echo "  recreate $svc (allowed)"; recreate="$recreate $svc";; *) echo "  RECREATE $svc  <- refused (ALLOW_RECREATE)"; bad=1;; esac; fi
  done <<< "$hashes"
  for c in $(docker ps -a --filter "label=com.docker.compose.project=$SLUG-supabase" --format '{{.Label "com.docker.compose.service"}}' | sort -u); do
    grep -qx "$c" <<< "$services" || echo "  remove   $c"
  done
  if [ -n "$bad" ]; then rm -f "$new"; die "applying would recreate a service whose config changed; nothing was changed (fix the drift first, or ALLOW_RECREATE for non-db services)"; fi
  if [ "${DRY_RUN:-0}" = 1 ]; then rm -f "$new"; log "Dry run: nothing changed"; exit 0; fi
  before=$(docker ps -q --filter "label=com.docker.compose.project=$SLUG-supabase" --filter "label=com.docker.compose.service=db")
  log "Backups"; backup_ext "$DIR/.env"; backup_ext "$DIR/docker-compose.$SLUG.yml"
  mv -f "$new" "$DIR/docker-compose.$SLUG.yml"; chmod 640 "$DIR/docker-compose.$SLUG.yml"
  log "docker compose up -d --remove-orphans"
  out=$(compose up -d --remove-orphans --pull never --no-build 2>&1) || { printf '%s\n' "$out" | tail -n 20 >&2; die "docker compose up failed; previous overlay is the newest .bak beside it"; }
  printf '%s\n' "$out" | tail -n 20
  after=$(docker ps -q --filter "label=com.docker.compose.project=$SLUG-supabase" --filter "label=com.docker.compose.service=db")
  [ "$before" = "$after" ] || warn "db container changed ($before -> $after)"
  # the PostgREST root answers 403 to anon (no OpenAPI for it); the service role gets 200
  sk=$(get_env SERVICE_ROLE_KEY)
  for i in $(seq 1 30); do code=$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $sk" -H "Authorization: Bearer $sk" "http://127.0.0.1:$API_PORT/rest/v1/" || true); [ "$code" = 200 ] && break; sleep 2; done
  echo "gateway http://127.0.0.1:$API_PORT/rest/v1/ (service role) -> $code"
  echo "gateway http://127.0.0.1:$API_PORT/auth/v1/health -> $(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $(get_env ANON_KEY)" "http://127.0.0.1:$API_PORT/auth/v1/health" || true)"
  docker ps -a --filter "label=com.docker.compose.project=$SLUG-supabase" --format '  {{.Names}} {{.Status}}' | sort
  [ "$code" = 200 ] || die "gateway does not answer 200 after the apply"
  log "Done: $SLUG-supabase services applied"
  exit 0
fi

# ------------------------------------------------------------ 1. the files
[ -d "$ROOT" ] || install -d -m 2750 -o root -g root "$ROOT"  # never re-chown an existing site root (CI deploys as the deploy user)
if [ -f "$DIR/.env" ] && [ -f "$DIR/docker-compose.yml" ]; then
  log "Supabase project already at $DIR; keeping its secrets"
else
  log "Supabase $SUPABASE_REF into $DIR"
  tmp=$(mktemp -d)
  curl -fsSL "https://raw.githubusercontent.com/supabase/supabase/$SUPABASE_REF/docker/setup.sh" -o "$tmp/setup.sh"
  slog="$ROOT/$PROJECT-setup.log"; (umask 077 && : > "$slog")
  if ! (cd "$ROOT" && bash "$tmp/setup.sh" --ref "$SUPABASE_REF" -p "$PROJECT" -y --skip-deps) >> "$slog" 2>&1; then
    grep -E '^(===>|ERROR|WARNING)' "$slog" | tail -n 20 >&2
    die "Supabase setup.sh failed; log (contains secrets): $slog"
  fi
  rm -rf "$tmp"
fi
chown root:root "$DIR"; chmod 2750 "$DIR"

log "Configuring .env"
backup "$DIR/.env"
set_env SUPABASE_PUBLIC_URL "https://$STUDIO_DOMAIN"
set_env API_EXTERNAL_URL "https://$STUDIO_DOMAIN"
set_env SITE_URL "$SITE_URL"
set_env ADDITIONAL_REDIRECT_URLS "${SITE_URL}/**,https://www.${SITE}/**,http://localhost:3000/**"
set_env POOLER_TENANT_ID "$SLUG"
set_env STUDIO_DEFAULT_ORGANIZATION "Profullstack"
set_env STUDIO_DEFAULT_PROJECT "$SITE"
set_env API_GW_HTTP_PORT "$API_PORT"
set_env KONG_HTTP_PORT "$API_PORT"
set_env POSTGRES_PORT 5432
set_env POOLER_PROXY_PORT_TRANSACTION "$POOLER_PORT"
set_env DISABLE_SIGNUP false
set_env ENABLE_EMAIL_SIGNUP true
set_env ENABLE_EMAIL_AUTOCONFIRM false
# Upstream .env.example ships phone signup ON with SMS autoconfirm ON. With no
# SMS provider, POST /auth/v1/signup {phone,password} then returns a live session
# for any made-up number, skipping email confirmation entirely; with a provider,
# autoconfirm still skips the OTP. So: autoconfirm always off, and phone signup
# only on for a site whose auth.env configures a way to send the SMS.
set_env ENABLE_PHONE_AUTOCONFIRM false
if grep -qE '^GOTRUE_(SMS_PROVIDER|HOOK_SEND_SMS_ENABLED)=' "$DIR/volumes/auth/auth.env" 2>/dev/null; then
  set_env ENABLE_PHONE_SIGNUP true
else
  set_env ENABLE_PHONE_SIGNUP false
fi
if [ -n "${SMTP_PASS:-}" ]; then
  set_env SMTP_HOST smtp.resend.com; set_env SMTP_PORT 465; set_env SMTP_USER resend; set_env SMTP_PASS "$SMTP_PASS"
  set_env SMTP_SENDER_NAME "${SMTP_SENDER:-$SITE}"; set_env SMTP_ADMIN_EMAIL "${SMTP_ADMIN:-noreply@$SITE}"
else
  warn "SMTP_PASS not set; GoTrue cannot send mail until it is"
fi
set_env COMPOSE_FILE "docker-compose.yml:docker-compose.$SLUG.yml"
set_env COMPOSE_PROJECT_NAME "$SLUG-supabase"
chmod 600 "$DIR/.env"

# ------------------------------------------------------------- 2. postgres
V="$DIR/volumes/$SLUG"; mkdir -p "$V/tls"
if [ ! -s "$V/tls/server.key" ]; then
  log "Self-signed TLS for $DB_DOMAIN"
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -subj "/CN=$DB_DOMAIN" -addext "subjectAltName=DNS:$DB_DOMAIN" -keyout "$V/tls/server.key" -out "$V/tls/server.crt" 2>/dev/null
fi
cat > "$V/pg_hba.conf" <<HBA
# $SITE: managed by cli-tools dev2/templates/supabase-stack.sh
local   all  supabase_admin                          trust
local   all  all                                     peer map=supabase_map
host    all  all            127.0.0.1/32             trust
host    all  all            ::1/128                  trust
hostssl all  postgres       ${GATEWAY}/32            scram-sha-256
host    all  all            ${GATEWAY}/32            reject
host    all  all            ${SUBNET}                scram-sha-256
hostssl all  postgres       0.0.0.0/0                scram-sha-256
hostssl all  postgres       ::/0                     scram-sha-256
host    all  all            0.0.0.0/0                reject
host    all  all            ::/0                     reject
HBA
cat > "$V/$SLUG.conf" <<CONF
# $SITE: managed by cli-tools dev2/templates/supabase-stack.sh. One of many stacks on
# this box, so sized small; raise per site if it earns it.
hba_file = '/etc/$SLUG/pg_hba.conf'
ssl = on
ssl_cert_file = '/etc/$SLUG/tls/server.crt'
ssl_key_file = '/etc/$SLUG/tls/server.key'
max_connections = 120
shared_buffers = ${PG_SHARED_BUFFERS:-512MB}
effective_cache_size = ${PG_EFFECTIVE_CACHE:-2GB}
maintenance_work_mem = 256MB
work_mem = 16MB
wal_buffers = 16MB
max_wal_size = 2GB
checkpoint_completion_target = 0.9
random_page_cost = 1.1
effective_io_concurrency = 200
max_worker_processes = 8
max_parallel_workers = 4
max_parallel_workers_per_gather = 2
cron.database_name = 'postgres'
CONF
chmod 755 "$V" "$V/tls"; chmod 644 "$V/pg_hba.conf" "$V/$SLUG.conf" "$V/tls/server.crt"; chmod 600 "$V/tls/server.key"
chown "$PG_UID:$PG_GID" "$V/tls/server.key" "$V/tls/server.crt"

log "Overlay docker-compose.$SLUG.yml (own project name, container names, ports, subnet; dropped: ${DROP_SERVICES:-none})"
render_overlay > "$DIR/docker-compose.$SLUG.yml"

ensure_env_files

# ---------------------------------------------------------------- 3. start
log "Starting $SLUG-supabase"
compose up -d --remove-orphans --wait 2>/dev/null || compose up -d --remove-orphans
compose restart db >/dev/null
for i in $(seq 1 90); do docker exec "$DBC" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$DBC" pg_isready -U postgres -h localhost >/dev/null || die "$DBC never became ready"

log "Repairing the v0.8.x bootstrap gaps (role passwords, auth/storage owners, graphql_public, _realtime, _supabase)"
pw=$(get_env POSTGRES_PASSWORD)
sql_admin <<SQL
do \$\$ declare r text; begin
  foreach r in array array['postgres','authenticator','supabase_auth_admin','supabase_storage_admin','supabase_admin','supabase_replication_admin','supabase_read_only_user','supabase_etl_admin','pgbouncer'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('alter role %I with password %L', r, '$pw'); end if;
  end loop; end \$\$;
SQL
sql_admin -c "select 1 from pg_database where datname='_supabase'" | grep -q 1 || sql_admin -c "create database _supabase with owner postgres"
docker exec -i "$DBC" psql -U supabase_admin -h localhost -d _supabase -v ON_ERROR_STOP=1 -X <<'SQL'
create schema if not exists _supavisor authorization postgres;
create schema if not exists _analytics authorization postgres;
grant all on database _supabase to postgres, supabase_admin;
SQL
sql_admin <<'SQL'
create schema if not exists graphql_public;
create schema if not exists _realtime;
alter schema _realtime owner to supabase_admin;
grant all on schema _realtime to supabase_admin, postgres;
grant usage on schema graphql_public to anon, authenticated, service_role, authenticator;
do $$ declare r record; begin
  execute 'alter schema auth owner to supabase_auth_admin';
  for r in select 'alter function '||p.oid::regprocedure||' owner to supabase_auth_admin' as cmd from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' loop execute r.cmd; end loop;
  for r in select 'alter table auth.'||quote_ident(tablename)||' owner to supabase_auth_admin' as cmd from pg_tables where schemaname='auth' loop execute r.cmd; end loop;
  execute 'alter schema storage owner to supabase_storage_admin';
  for r in select 'alter function '||p.oid::regprocedure||' owner to supabase_storage_admin' as cmd from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='storage' loop execute r.cmd; end loop;
  for r in select 'alter table storage.'||quote_ident(tablename)||' owner to supabase_storage_admin' as cmd from pg_tables where schemaname='storage' loop execute r.cmd; end loop;
  execute 'grant anon, authenticated, service_role to authenticator';
  execute 'grant anon, authenticated, service_role to postgres';
  execute 'grant service_role to supabase_storage_admin';
end $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
SQL
compose restart auth rest storage $(dropped realtime || echo realtime) $(dropped supavisor || echo supavisor) >/dev/null 2>&1 || true

log "Extensions"
sql_admin <<'SQL'
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
SQL
for e in ${EXTENSIONS:-}; do sql_admin -c "create extension if not exists \"$e\" cascade" 2>/dev/null || warn "extension $e not available in this image"; done

log "Firewall: $DB_PORT reachable from $ALLOW_IPS, loopback and the docker networks only"
while iptables -D DOCKER-USER -p tcp --dport "$DB_PORT" -j DROP 2>/dev/null; do :; done
for ip in $ALLOW_IPS 127.0.0.1 172.16.0.0/12 192.168.0.0/16 10.0.0.0/8; do while iptables -D DOCKER-USER -s "$ip" -p tcp --dport "$DB_PORT" -j ACCEPT 2>/dev/null; do :; done; done
iptables -I DOCKER-USER 1 -p tcp --dport "$DB_PORT" -j DROP
iptables -I DOCKER-USER 1 -s 172.16.0.0/12 -p tcp --dport "$DB_PORT" -j ACCEPT
iptables -I DOCKER-USER 1 -s 192.168.0.0/16 -p tcp --dport "$DB_PORT" -j ACCEPT
iptables -I DOCKER-USER 1 -s 10.0.0.0/8 -p tcp --dport "$DB_PORT" -j ACCEPT
iptables -I DOCKER-USER 1 -s 127.0.0.1 -p tcp --dport "$DB_PORT" -j ACCEPT
for ip in $ALLOW_IPS; do iptables -I DOCKER-USER 1 -s "$ip" -p tcp --dport "$DB_PORT" -j ACCEPT; done
mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4

log "Checks"
sql_admin -c "select 'ssl='||current_setting('ssl')||' shared_buffers='||current_setting('shared_buffers')||' hba='||current_setting('hba_file')||' version='||current_setting('server_version')"
[ "$(sql_admin -c "select has_schema_privilege('anon','public','usage')")" = t ] || die "anon lost USAGE on public"
for i in $(seq 1 30); do code=$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $(get_env ANON_KEY)" "http://127.0.0.1:$API_PORT/rest/v1/" || true); [ "$code" = 200 ] && break; sleep 3; done
echo "gateway http://127.0.0.1:$API_PORT/rest/v1/ -> $code"
(umask 077; cat > "$DIR/$SLUG-connection.env" <<ENV
# $SITE self-hosted Supabase (written by supabase-stack.sh). Keep secret.
SELFHOST_SUPABASE_URL=https://${STUDIO_DOMAIN}
SELFHOST_ANON_KEY=$(get_env ANON_KEY)
SELFHOST_SERVICE_ROLE_KEY=$(get_env SERVICE_ROLE_KEY)
SELFHOST_JWT_SECRET=$(get_env JWT_SECRET)
SELFHOST_POSTGRES_PASSWORD=${pw}
SELFHOST_DATABASE_URL=postgres://postgres:${pw}@${DB_DOMAIN}:${DB_PORT}/postgres?sslmode=require
SELFHOST_DB_PORT=${DB_PORT}
SELFHOST_API_PORT=${API_PORT}
SELFHOST_POOLER_PORT=$(dropped supavisor && echo none || echo "${POOLER_PORT}")
SELFHOST_DASHBOARD_USERNAME=$(get_env DASHBOARD_USERNAME)
SELFHOST_DASHBOARD_PASSWORD=$(get_env DASHBOARD_PASSWORD)
ENV
)
log "Done: $SLUG-supabase up; connection in $DIR/$SLUG-connection.env"
