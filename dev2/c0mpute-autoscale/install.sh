#!/bin/bash
# Install `c0mpute autoscale` for our rented GPU nodes on dev2, as anthony (never root).
# Secrets are NOT in this repo: put them beside the config first (all 0600):
#   ~/.config/c0mpute/autoscale/vast.key                 logicsrc profullstack/vast--prod VAST_API_KEY
#   ~/.config/c0mpute/autoscale/sdNT3kCN-identity.key    node identity (backup: ~/backups/vast-node-sdNT3kCN/)
#   ~/.config/c0mpute/autoscale/env                      C0MPUTE_API_KEY=... (fleet key, for the dashboard)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dir=$HOME/.config/c0mpute/autoscale
install -d -m 700 "$dir" "$HOME/www/vast-autoscale"
install -m 600 "$here/autoscale.toml" "$HOME/.config/c0mpute/autoscale.toml"
install -m 700 "$here/vast-hook.sh" "$dir/vast-hook.sh"
install -m 644 "$here/vast-onstart.sh" "$dir/vast-onstart.sh"
for f in vast.key sdNT3kCN-identity.key env; do
  [ -s "$dir/$f" ] || { echo "missing $dir/$f (see the header of this script)" >&2; exit 1; }
  chmod 600 "$dir/$f"
done
install -D -m 644 "$here/c0mpute-autoscale.service" "$HOME/.config/systemd/user/c0mpute-autoscale.service"
systemctl --user daemon-reload
systemctl --user enable --now c0mpute-autoscale.service
systemctl --user --no-pager status c0mpute-autoscale.service | head -5
