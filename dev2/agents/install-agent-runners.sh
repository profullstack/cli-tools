#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run this installer as root" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS=(cha0spunk coinpay knox nora quill riotcoder rootkey)
MAIL_GROUP=fleet-agent-mail
CLI_DIR=/opt/riotcoder-cli
NODE_DIR=/home/riotcoder/.local/share/agent-phone
CLAIM_DIR=/var/lib/fleet-agent-mail/claims

id riotcoder >/dev/null
[ -x "$NODE_DIR/node" ] || { echo "deploy group.call first to install private Node runtimes" >&2; exit 1; }
[ -d "$CLI_DIR/node_modules" ] || { echo "CLI runtime dependencies are missing at $CLI_DIR" >&2; exit 1; }
getent group "$MAIL_GROUP" >/dev/null || groupadd --system "$MAIL_GROUP"
for agent in "${AGENTS[@]}"; do
  id "$agent" >/dev/null || { echo "missing Linux account: $agent" >&2; exit 1; }
  groups=" $(id -nG "$agent") "
  case "$groups" in *" sudo "*|*" wheel "*|*" admin "*) echo "$agent has an admin group" >&2; exit 1;; esac
  usermod -a -G "$MAIL_GROUP" "$agent"
done

# Root owns the deployed code. Only Fleet agent accounts need to read it.
chgrp -R "$MAIL_GROUP" "$CLI_DIR"
chmod -R o-rwx "$CLI_DIR"
chmod -R g+rX "$CLI_DIR"
install -d -o root -g "$MAIL_GROUP" -m 2770 /var/lib/fleet-agent-mail "$CLAIM_DIR"
install -o root -g root -m 0755 "$SOURCE_DIR/qc-agent-responder.py" /usr/local/libexec/qc-agent-responder

ready=()
skipped=()
for agent in "${AGENTS[@]}"; do
  home="$(getent passwd "$agent" | cut -d: -f6)"
  group="$(id -gn "$agent")"
  node="$home/.local/share/agent-phone/node"
  install -d -o "$agent" -g "$group" -m 0750 "$home/.config/agent-identities/$agent"
  identity_source="/home/anthony/.config/agent-identities/$agent"
  if [ -f "$identity_source/mail.env" ]; then
    install -o "$agent" -g "$group" -m 0600 "$identity_source/mail.env" "$home/.config/agent-identities/$agent/mail.env"
    rm -f "$identity_source/mail.env"
  fi
  if [ -f "$identity_source/mail-prompt.md" ]; then
    install -o "$agent" -g "$group" -m 0640 "$identity_source/mail-prompt.md" "$home/.config/agent-identities/$agent/mail-prompt.md"
  fi
  if [ -f "$identity_source/AGENTS.md" ]; then
    install -o "$agent" -g "$group" -m 0640 "$identity_source/AGENTS.md" "$home/.config/agent-identities/$agent/AGENTS.md"
  fi
  if [ -f "$identity_source/profile.json" ]; then
    install -o "$agent" -g "$group" -m 0640 "$identity_source/profile.json" "$home/.config/agent-identities/$agent/profile.json"
  fi
  missing=()
  for path in \
    "$home/.config/agent-llm.json" \
    "$home/.config/cli-tools/mail.json" \
    "$home/.codex/auth.json" \
    "$home/.config/qc/session.json" \
    "$home/.config/qc-agent/qc-passphrase" \
    "$home/.config/qc-agent/persona.md"; do
    [ -f "$path" ] || missing+=("${path#"$home"/}")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    skipped+=("$agent (${missing[*]})")
    continue
  fi
  if [ ! -x "$node" ]; then
    skipped+=("$agent (missing private Node runtime)")
    continue
  fi

  install -d -o "$agent" -g "$group" -m 0750 "$home/.local/bin" "$home/.local/state/agent-mail-poll"
  install -o "$agent" -g "$group" -m 0750 "$SOURCE_DIR/agent-mail-trusted.py" "$home/.local/bin/agent-mail-trusted"
  install -o "$agent" -g "$group" -m 0750 "$SOURCE_DIR/agent-mail-claim" "$home/.local/bin/agent-mail-claim"

  cat > "$home/.local/bin/mail.tmp" <<EOF
#!/bin/sh
export HOME=$home
exec $node $CLI_DIR/bin/mail.ts "\$@"
EOF
  chown "$agent:$group" "$home/.local/bin/mail.tmp"
  chmod 0750 "$home/.local/bin/mail.tmp"
  mv "$home/.local/bin/mail.tmp" "$home/.local/bin/mail"

  cat > "$home/.local/bin/agent-mail-poll.tmp" <<EOF
#!/bin/sh
export HOME=$home
exec $node $CLI_DIR/bin/agent-mail-poll.ts "\$@"
EOF
  chown "$agent:$group" "$home/.local/bin/agent-mail-poll.tmp"
  chmod 0750 "$home/.local/bin/agent-mail-poll.tmp"
  mv "$home/.local/bin/agent-mail-poll.tmp" "$home/.local/bin/agent-mail-poll"

  cat > "/etc/systemd/system/agent-mail-poll-$agent.service" <<EOF
[Unit]
Description=$agent trusted email task poller
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$agent
Group=$group
SupplementaryGroups=$MAIL_GROUP
WorkingDirectory=$home
Environment=HOME=$home
Environment=AGENT_MAIL_CLAIM_ROOT=$CLAIM_DIR
Environment=PATH=$home/.local/share/agent-phone:$home/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$home/.local/bin/agent-mail-poll poll --agent $agent
EOF

  cat > "/etc/systemd/system/agent-mail-poll-$agent.timer" <<EOF
[Unit]
Description=Poll $agent's inbox every five minutes

[Timer]
OnCalendar=*-*-* *:0/5:00
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF
  chmod 0644 "/etc/systemd/system/agent-mail-poll-$agent.service" "/etc/systemd/system/agent-mail-poll-$agent.timer"
  ready+=("$agent")
done

systemctl daemon-reload
for agent in "${ready[@]}"; do
  systemctl enable --now "agent-mail-poll-$agent.timer" >/dev/null
done
printf 'Installed contact runners for: %s\n' "${ready[*]:-(none)}"
if [ "${#skipped[@]}" -gt 0 ]; then
  printf 'Skipped accounts missing their own credentials: %s\n' "${skipped[*]}"
fi
