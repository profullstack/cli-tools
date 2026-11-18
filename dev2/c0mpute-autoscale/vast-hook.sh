#!/bin/bash
# Hooks for `c0mpute autoscale` on a Vast.ai node.
#   vast-hook.sh              busy_cmd: exit 0 = busy, 1 = idle, else unknown (kept running)
#   vast-hook.sh stop-worker  pre_stop_cmd: stop the c0mpute worker so it bids on nothing
# Follows the instance across replacements: ssh host/port come from the Vast API for
# $C0MPUTE_AUTOSCALE_INSTANCE. Busy = GPU utilization > 10 % or Ollama answered a chat
# in the last 2 minutes.
set -u
key=$(cat "$HOME/.config/c0mpute/autoscale/vast.key")
read -r host port < <(curl -fsS -m 20 -H "Authorization: Bearer $key" \
  "https://console.vast.ai/api/v0/instances/${C0MPUTE_AUTOSCALE_INSTANCE}/" |
  python3 -c 'import json,sys; i=json.load(sys.stdin)["instances"]; print(i["ssh_host"], i["ssh_port"])') || exit 2
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -p "$port" "root@$host")
if [ "${1:-}" = stop-worker ]; then
  exec "${SSH[@]}" 'pkill -u c0mpute -f "c0mpute worker"; sleep 5; exit 0'
fi
exec "${SSH[@]}" bash -s <<'REMOTE'
u=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | head -1)
[ "${u:-0}" -gt 10 ] && exit 0
t=$(tail -n 400 /home/c0mpute/ollama.log | grep 'chat/completions' | tail -1 | awk '{print $2, $4}')
[ -n "$t" ] && [ $(( $(date -u +%s) - $(date -ud "$t" +%s) )) -lt 120 ] && exit 0
exit 1
REMOTE
