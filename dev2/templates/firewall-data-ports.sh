#!/usr/bin/env bash
# Allowlist for the data ports Docker publishes on dev2 (the shared cluster's 5432
# and every per-site Supabase stack's 55xx): reachable from dev1, loopback and the
# box's own Docker networks only. Docker publishes ports ahead of ufw, so this lives
# in the DOCKER-USER chain. Run as root on dev2 by `dev2-site firewall`; idempotent.
#
# Docker's default address pools are 172.17-172.31.0.0/16 AND 192.168.0.0/16 (in
# /20s). With dozens of compose networks the 172.16/12 range runs out and new
# projects land in 192.168.x, which an allowlist of 172.16.0.0/12 alone drops:
# the app then sees CONNECT_TIMEOUT to dev2.profullstack.com:5432.
set -euo pipefail
PORTS=${PORTS:-5432}
ALLOW=${ALLOW:-67.205.189.229}
SOURCES="$ALLOW 127.0.0.1 172.16.0.0/12 192.168.0.0/16 10.0.0.0/8"
for port in $PORTS; do
  while iptables -D DOCKER-USER -p tcp --dport "$port" -j DROP 2>/dev/null; do :; done
  for src in $SOURCES; do while iptables -D DOCKER-USER -s "$src" -p tcp --dport "$port" -j ACCEPT 2>/dev/null; do :; done; done
  iptables -I DOCKER-USER 1 -p tcp --dport "$port" -j DROP
  for src in $SOURCES; do iptables -I DOCKER-USER 1 -s "$src" -p tcp --dport "$port" -j ACCEPT; done
done
mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4
iptables -L DOCKER-USER -n --line-numbers | head -n 40
