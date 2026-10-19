#!/usr/bin/env bash
# dev2 memory guard. Run once as root:  sudo bash dev2/memory-guard.sh
#
# Why (2026-10-19 12:29 UTC): dev2 ran out of memory. Agent work (Claude sessions,
# bun test, next build, tsc, chrome-devtools-mcp) peaked at 38 GB in user-1001.slice
# plus 23 GB in cron.service, on a 91 GB box whose production needs ~45 GB, with all
# 16 GB of swap full. The kernel OOM killer took a backend of the shared supabase-db
# Postgres; it went through crash recovery and the Moshpit registry (and so every
# <name>.pit.world) was down for ~6 minutes. earlyoom did not help: it killed 170
# tiny processes (ssh-agent, rm, browser tabs), and its --avoid ^postgres never
# matched the container's process name, ".postgres-wrapp".
#
# What this does, idempotent and reversible (see "Undo" at the end):
#  1. caps agent work so it runs out of memory inside its own cgroup, never production:
#       user-1001.slice (anthony: interactive + background Claude work)  MemoryHigh 28G, MemoryMax 32G
#       cron.service    (cron-launched agents and jobs)                   MemoryHigh 14G, MemoryMax 16G
#     MemoryHigh throttles and reclaims first; MemoryMax is the hard wall.
#  2. makes the database containers the kernel's last choice: oom_score_adj -900 on
#     every process of supabase-db and the other *-db / *postgres* containers, now
#     and every 5 minutes (a systemd timer), so restarts and recreates stay covered.
#  3. fixes earlyoom's avoid list to match ".postgres-wrapp" (and postgrest, pgbouncer).
#  4. installs /usr/local/bin/deploy-gate (@profullstack/deploy, pinned and checksummed):
#     every deploy on the box (deploy-app.sh, OpenInstall bin/install.sh) then takes one
#     of 3 slots, so a wave of merges builds three at a time instead of all at once.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0"; exit 1; }

echo "== 1. cgroup caps"
systemctl set-property user-1001.slice MemoryHigh=28G MemoryMax=32G
systemctl set-property cron.service MemoryHigh=14G MemoryMax=16G
for u in user-1001.slice cron.service; do
  printf '  %-16s MemoryHigh=%s MemoryMax=%s\n' "$u" "$(systemctl show -p MemoryHigh --value "$u")" "$(systemctl show -p MemoryMax --value "$u")"
done

echo "== 2. protect database containers from the OOM killer"
cat > /usr/local/bin/protect-db-oom <<'EOF'
#!/usr/bin/env bash
# oom_score_adj -900 on every process of the database containers (cli-tools dev2/memory-guard.sh).
for c in $(docker ps --format '{{.Names}}' | grep -E '(^supabase-db$|-db(-[0-9]+)?$|postgres)'); do
  for pid in $(docker top "$c" -eo pid 2>/dev/null | tail -n +2); do
    [ "$(cat "/proc/$pid/oom_score_adj" 2>/dev/null)" = -900 ] || echo -900 > "/proc/$pid/oom_score_adj" 2>/dev/null || true
  done
done
EOF
chmod 0755 /usr/local/bin/protect-db-oom
cat > /etc/systemd/system/protect-db-oom.service <<'EOF'
[Unit]
Description=Keep database containers last in line for the OOM killer (memory-guard)
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/protect-db-oom
EOF
cat > /etc/systemd/system/protect-db-oom.timer <<'EOF'
[Unit]
Description=Re-apply oom_score_adj -900 to database containers every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now protect-db-oom.timer >/dev/null
/usr/local/bin/protect-db-oom
echo "  supabase-db postmaster oom_score_adj: $(cat "/proc/$(docker top supabase-db -eo pid | sed -n 2p)/oom_score_adj")"

echo "== 3. earlyoom avoid list"
if [ -f /etc/default/earlyoom ] && ! grep -q 'postgres\.\*' /etc/default/earlyoom; then
  cp -a /etc/default/earlyoom /etc/default/earlyoom.bak-memory-guard
  sed -i 's/|postgres|/|\\.?postgres.*|postgrest|pgbouncer|/' /etc/default/earlyoom
  systemctl restart earlyoom
fi
grep EARLYOOM_ARGS /etc/default/earlyoom | sed 's/^/  /'

echo "== 4. deploy gate: three deploys at a time"
GATE_VERSION=0.1.0
GATE_SHA256=c4e3b64144f186f97b5e0f7fe1f20021282bb9547c2b13d55c2c0312d9ef7b52
tmp=$(mktemp -d)
if curl -fsSL "https://registry.npmjs.org/@profullstack/deploy/-/deploy-$GATE_VERSION.tgz" -o "$tmp/d.tgz" \
  && tar -xzf "$tmp/d.tgz" -C "$tmp" package/bin/deploy-gate \
  && echo "$GATE_SHA256  $tmp/package/bin/deploy-gate" | sha256sum -c --quiet -; then
  install -m 0755 -o root -g root "$tmp/package/bin/deploy-gate" /usr/local/bin/deploy-gate
  /usr/local/bin/deploy-gate status | sed 's/^/  /'
else
  echo "  could not fetch or verify @profullstack/deploy $GATE_VERSION; deploys stay ungated for root (anthony's use ~/.local/bin/deploy-gate)"
fi
rm -rf "$tmp"

echo
echo "Done. Check: free -g; systemctl show -p MemoryCurrent,MemoryMax user-1001.slice cron.service"
echo "Undo: systemctl set-property user-1001.slice MemoryHigh=infinity MemoryMax=infinity"
echo "      systemctl set-property cron.service MemoryHigh=infinity MemoryMax=infinity"
echo "      systemctl disable --now protect-db-oom.timer"
echo "      mv /etc/default/earlyoom.bak-memory-guard /etc/default/earlyoom && systemctl restart earlyoom"
echo "      rm /usr/local/bin/deploy-gate   # deploys run ungated again"
