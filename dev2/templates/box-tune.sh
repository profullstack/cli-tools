#!/usr/bin/env bash
# dev2 box settings the fleet kit depends on. Run as root on dev2 by `dev2-site box-tune`; idempotent.
# - sshd: many parallel deploys open many ssh sessions; the default MaxStartups 10:30:100
#   drops connection attempts (exit 255 mid-migration).
set -euo pipefail
f=/etc/ssh/sshd_config.d/00-dev2-fleet.conf
printf '# managed by cli-tools dev2/templates/box-tune.sh\nMaxStartups 100:30:300\nMaxSessions 100\nLoginGraceTime 60\n' > "$f.tmp"
if ! cmp -s "$f.tmp" "$f" 2>/dev/null; then mv "$f.tmp" "$f"; sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd; echo "sshd: $(tr '\n' ' ' < "$f" | sed 's/# managed[^M]*//')"; else rm -f "$f.tmp"; echo "sshd: already tuned"; fi

# - inotify: every container's Envoy/Node watchers take an inotify instance; the kernel
#   default of 128 per uid runs out around 130 containers and Envoy then segfaults with
#   "assert failure: inotify_fd_ >= 0". Persisted, because a reboot drops a plain sysctl -w.
s=/etc/sysctl.d/90-dev2-fleet.conf
printf 'fs.inotify.max_user_instances = 8192\nfs.inotify.max_user_watches = 1048576\nfs.file-max = 2097152\n' > "$s.tmp"
if ! cmp -s "$s.tmp" "$s" 2>/dev/null; then mv "$s.tmp" "$s"; sysctl -q -p "$s"; echo "sysctl: $(tr '\n' ' ' < "$s")"; else rm -f "$s.tmp"; echo "sysctl: already tuned ($(sysctl -n fs.inotify.max_user_instances) instances)"; fi
