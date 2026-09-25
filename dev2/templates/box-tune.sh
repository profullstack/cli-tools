#!/usr/bin/env bash
# dev2 box settings the fleet kit depends on. Run as root on dev2 by `dev2-site box-tune`; idempotent.
# - sshd: many parallel deploys open many ssh sessions; the default MaxStartups 10:30:100
#   drops connection attempts (exit 255 mid-migration).
set -euo pipefail
f=/etc/ssh/sshd_config.d/00-dev2-fleet.conf
printf '# managed by cli-tools dev2/templates/box-tune.sh\nMaxStartups 100:30:300\nMaxSessions 100\nLoginGraceTime 60\n' > "$f.tmp"
if ! cmp -s "$f.tmp" "$f" 2>/dev/null; then mv "$f.tmp" "$f"; sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd; echo "sshd: $(tr '\n' ' ' < "$f" | sed 's/# managed[^M]*//')"; else rm -f "$f.tmp"; echo "sshd: already tuned"; fi
