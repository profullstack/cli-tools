#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run this installer as root" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SOURCE_DIR/../.." && pwd)"
USER_NAME=riotcoder
USER_HOME=/home/riotcoder
GROUP_NAME=riotcoder
NODE="$USER_HOME/.local/share/agent-phone/node"
CLI_DIR=/opt/riotcoder-cli

id "$USER_NAME" >/dev/null
[ -x "$NODE" ] || { echo "RiotCoder's private Node runtime is missing; deploy group.call first" >&2; exit 1; }
[ -d "$CLI_DIR/node_modules" ] || { echo "CLI runtime dependencies are missing at $CLI_DIR" >&2; exit 1; }
[ -f "$USER_HOME/.config/cli-tools/mail.json" ] || { echo "RiotCoder's private mail configuration is missing" >&2; exit 1; }

install -d -o "$USER_NAME" -g "$GROUP_NAME" -m 0750 \
  "$USER_HOME/.local/bin" "$USER_HOME/.config/agent-identities/riotcoder" "$USER_HOME/.local/state/agent-mail-poll"
install -o root -g root -m 0755 "$SOURCE_DIR/qc-agent-responder.py" /usr/local/libexec/qc-agent-responder
install -o "$USER_NAME" -g "$GROUP_NAME" -m 0755 "$SOURCE_DIR/agent-mail-trusted.py" "$USER_HOME/.local/bin/agent-mail-trusted"
install -o "$USER_NAME" -g "$GROUP_NAME" -m 0755 "$SOURCE_DIR/agent-mail-claim" "$USER_HOME/.local/bin/agent-mail-claim"
install -o "$USER_NAME" -g "$GROUP_NAME" -m 0644 "$SOURCE_DIR/riotcoder-mail-prompt.md" "$USER_HOME/.config/agent-identities/riotcoder/mail-prompt.md"

cat > "$USER_HOME/.local/bin/mail.tmp" <<EOF
#!/bin/sh
export HOME=$USER_HOME
exec $NODE $CLI_DIR/bin/mail.ts "\$@"
EOF
chown "$USER_NAME:$GROUP_NAME" "$USER_HOME/.local/bin/mail.tmp"
chmod 0750 "$USER_HOME/.local/bin/mail.tmp"
mv "$USER_HOME/.local/bin/mail.tmp" "$USER_HOME/.local/bin/mail"

cat > "$USER_HOME/.local/bin/agent-mail-poll.tmp" <<EOF
#!/bin/sh
export HOME=$USER_HOME
exec $NODE $CLI_DIR/bin/agent-mail-poll.ts "\$@"
EOF
chown "$USER_NAME:$GROUP_NAME" "$USER_HOME/.local/bin/agent-mail-poll.tmp"
chmod 0750 "$USER_HOME/.local/bin/agent-mail-poll.tmp"
mv "$USER_HOME/.local/bin/agent-mail-poll.tmp" "$USER_HOME/.local/bin/agent-mail-poll"

cat > /etc/systemd/system/agent-mail-poll-riotcoder.service <<EOF
[Unit]
Description=RiotCoder trusted email task poller
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=riotcoder
Group=riotcoder
WorkingDirectory=/home/riotcoder
Environment=HOME=/home/riotcoder
Environment=PATH=/home/riotcoder/.local/share/agent-phone:/home/riotcoder/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/riotcoder/.local/bin/agent-mail-poll poll --agent riotcoder
EOF

cat > /etc/systemd/system/agent-mail-poll-riotcoder.timer <<'EOF'
[Unit]
Description=Poll RiotCoder's inbox every five minutes

[Timer]
OnCalendar=*-*-* *:0/5:00
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

chmod 0644 /etc/systemd/system/agent-mail-poll-riotcoder.{service,timer}
systemctl daemon-reload
systemctl enable --now agent-mail-poll-riotcoder.timer >/dev/null
echo "RiotCoder QryptChat and mail task runners installed under UID $(id -u "$USER_NAME")."
