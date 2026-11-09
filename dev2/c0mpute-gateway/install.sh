#!/usr/bin/env bash
# Install dev2's c0mpute gateway self-healing. Run as root on dev2 from this directory,
# or from a workstation: ssh root@dev2.profullstack.com 'bash -s' < install.sh won't
# carry the files, so: scp -r dev2/c0mpute-gateway root@dev2:/root/ && ssh root@dev2 /root/c0mpute-gateway/install.sh
set -euo pipefail
cd "$(dirname "$0")"
install -m 0755 c0mpute-gateway-watchdog /usr/local/sbin/c0mpute-gateway-watchdog
install -m 0644 c0mpute-gateway-watchdog.service c0mpute-gateway-watchdog.timer /etc/systemd/system/
install -d /etc/systemd/system/c0mpute-worker.service.d /etc/systemd/system/moshpit-c0mpute-edge.service.d
install -m 0644 c0mpute-worker.service.d-resilient.conf /etc/systemd/system/c0mpute-worker.service.d/resilient.conf
install -m 0644 moshpit-c0mpute-edge.service.d-perms.conf /etc/systemd/system/moshpit-c0mpute-edge.service.d/perms.conf
install -m 0644 nginx-gateway.c0mpute.com.conf /etc/nginx/sites-available/gateway.c0mpute.com
ln -sf /etc/nginx/sites-available/gateway.c0mpute.com /etc/nginx/sites-enabled/gateway.c0mpute.com
nginx -t && systemctl reload nginx
systemctl daemon-reload
systemctl enable --now c0mpute-gateway-watchdog.timer
systemctl show c0mpute-worker -p Restart -p StartLimitIntervalUSec
systemctl list-timers c0mpute-gateway-watchdog.timer --no-pager | head -3
