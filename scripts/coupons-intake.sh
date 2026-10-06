#!/bin/sh
# coupons-intake — cron job behind submit@c0upons.com (c0upons.com's mail intake).
#
#   1. fe ensure: submit@c0upons.com (and coupons@profullstack.com) forward to the
#      c0upons webhook, key read from vault c0upons--prod. Idempotent.
#   2. Once, after the alias first exists: send a test mail and wait for the
#      c0upons intake log to show it. Until that has passed, nothing subscribes,
#      so no newsletter's confirmation mail is ever sent into the void.
#   3. dealsubs run: subscribe the inbox to the next few deal newsletters
#      (throttled: see src/dealsubs.ts).
#
# Quiet while FORWARDEMAIL_API_TOKEN is not in the vault yet: it logs that it is
# waiting and exits 0, so the cron line can go in before the token does.
#
# crontab: 17 */3 * * * /home/anthony/src/profullstack/cli-tools/scripts/coupons-intake.sh >>$HOME/.local/share/cli-tools/dealsubs/cron.log 2>&1
set -u
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin"

INBOX=${INBOX:-submit@c0upons.com}
EXTRA=${EXTRA_ALIASES:-coupons@profullstack.com}
HOOK=https://c0upons.com/api/webhooks/email
KEYSPEC=c0upons--prod:INBOUND_EMAIL_SECRET
STATE="${XDG_DATA_HOME:-$HOME/.local/share}/cli-tools/dealsubs"
VERIFIED="$STATE/inbox-verified"
mkdir -p "$STATE"

say() { printf '%s coupons-intake: %s\n' "$(date -u +%FT%TZ)" "$*"; }

for addr in $INBOX $EXTRA; do
  if ! out=$(fe ensure "$addr" "$HOOK" --key-from-vault "$KEYSPEC" --description "c0upons intake (cli-tools coupons-intake)" 2>&1); then
    case $out in
      *FORWARDEMAIL_API_TOKEN*) say "waiting: no FORWARDEMAIL_API_TOKEN in vault profullstack-sharable-keys--prod yet"; exit 0 ;;
      *) say "fe ensure $addr failed: $out"; exit 1 ;;
    esac
  fi
  say "$out"
done

if [ ! -f "$VERIFIED" ]; then
  # `teams pull` needs a real file (it hangs on /dev/stdout); a 0600 one, gone at once.
  envf=$(umask 077; mktemp "$STATE/.vault.XXXXXX")
  logicsrc teams pull profullstack c0upons prod --env "$envf" >/dev/null 2>&1 </dev/null
  secret=$(sed -n 's/^INBOUND_EMAIL_SECRET=//p' "$envf"); rm -f "$envf"
  [ -n "$secret" ] || { say "cannot read INBOUND_EMAIL_SECRET to check the intake log"; exit 1; }
  subject="coupons-intake delivery check $(date +%s)"
  mail send -a work --to "$INBOX" --subject "$subject" --body "Delivery check from cli-tools coupons-intake. No offer in this message." >/dev/null 2>&1 \
    || { say "could not send the delivery check"; exit 1; }
  i=0
  while [ $i -lt 30 ]; do
    if curl -fsS -m 20 -H "Authorization: Bearer $secret" "$HOOK?limit=20" 2>/dev/null | grep -q "$subject"; then
      date -u +%FT%TZ > "$VERIFIED"
      say "delivery check passed: $INBOX reaches the c0upons intake"
      break
    fi
    i=$((i + 1)); sleep 10
  done
  [ -f "$VERIFIED" ] || { say "delivery check: nothing reached the intake in 5 minutes; not subscribing anything"; exit 1; }
fi

dealsubs run --email "$INBOX" --max "${DEALSUBS_MAX:-3}"
