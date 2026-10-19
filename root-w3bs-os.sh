#!/usr/bin/env bash
#
# root-w3bs-os.sh -- bootstrap AND maintain a W3BS OS (Alpine) server as root.
#
# The W3BS OS counterpart of root-ubuntu.sh: the same accounts, confinement,
# dotfiles, tools and per-user web hosting, on Alpine Linux (musl, apk, OpenRC)
# with the w3bs CLI as the front door for packages and Caddy as the web server.
# One file, so it can be curled onto a machine that has nothing on it yet:
#
#   curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/root-w3bs-os.sh | bash -s -- --refresh
#
# bash, NOT sh. /bin/sh on W3BS OS is busybox ash and this script is bash
# throughout. A stock Alpine image has no bash at all, so the guard below
# installs it (apk add bash) and re-runs itself when it was started from a
# file; piped into sh it cannot re-run itself, and says so in one sentence.
#
# Piping it gives a NON-INTERACTIVE run: stdin is the script, so there is no
# terminal to prompt at, and every prompt in here is guarded on one (see
# `interactive`). To be asked the questions, download it and run it as a file:
#
#   curl -fsSLO https://raw.githubusercontent.com/profullstack/cli-tools/master/root-w3bs-os.sh
#   chmod +x root-w3bs-os.sh && ./root-w3bs-os.sh          # as root
#
# Safe to re-run, and re-running is the supported way to pick up updates: it
# upgrades packages and tooling, refreshes anything it owns, and leaves anything
# a user has since edited alone (see install_managed below).
#
# Runs on W3BS OS (/etc/w3bs-os-release: ID=w3bs-os, EDITION=iso|docker-server|
# docker-desktop) and on plain Alpine. Anything else is refused unless --force:
# Ubuntu and Debian have root-ubuntu.sh. OpenRC is the init it is written for;
# systemd is used instead wherever it is the running init (desktop editions may
# move to it), and a container with no init at all still gets the packages, the
# accounts and the dotfiles.
#
# Packages flow through the w3bs CLI. `w3bs dist-upgrade --yes` (or `w3bs os
# update --yes`, once the CLI has it) upgrades the base system and every W3BS
# package; apk adds the base packages; catalog tools (moshcode, threatcrush,
# hqterm/hqsh, sh1pt) are `w3bs install <id>` per account, falling back to the
# publisher's curl installer only where w3bs is missing.
#
#   1. accounts + groups; users provisioned by an earlier run are picked up
#      automatically and refreshed
#   2. w3bs dist-upgrade + apk base packages + a daily unattended upgrade
#   3. ufw (Alpine packages it; dual-stack, IPV6=yes)
#   4. a 2G swapfile, if the box has no swap at all; then zram (zram-init) on
#      top of it and earlyoom watching
#   5. dotfiles (.zsh*, .bash*, .ssh*, ...) from $DOTFILES_REPO, if you have one
#   6. oh-my-zsh + plugins, oh-my-tmux, irssi configs; zsh is every login shell
#   7. mise      (curl https://mise.run | sh)
#   8. moshcode  (w3bs install moshcode.sh/moshcode; --without-moshcode skips)
#      + threatcrush CLI (w3bs install threatcrush.com/threatcrush)
#      + hqterm/hqsh    (w3bs install hqterm.sh/hqterm), so `hqterm connect` works
#      + sh1pt          (w3bs install sh1pt.com/sh1pt), with --with-sh1pt
#   9. a per-user ssh-agent: a systemd user unit under systemd, one long-lived
#      agent per account on a fixed socket everywhere else
#  10. motd from $MOTD_URL
#  11. Caddy: per-user pages, per-user dev apps, automatic HTTPS (one Caddyfile
#      per user under /etc/caddy/users, admin API on localhost only)
#  12. confinement: every non-admin account confined (home, /proc, memory,
#      tasks, ssh forwarding). Runs after the accounts exist, since which
#      side of the line someone is on is decided by their groups.
#
# Usage, as root:
#   ./root-w3bs-os.sh                        # first run, or a refresh
#   ./root-w3bs-os.sh alice bob              # ...and provision two accounts
#   ./root-w3bs-os.sh alice --groups wheel
#   ./root-w3bs-os.sh --refresh              # update everything, ask nothing
#
# Remote shares (see "remote shares" below for the full options):
#   ./root-w3bs-os.sh mount user@host:~/data --via peer
#   ./root-w3bs-os.sh mounts                 # list what is mounted, and who can reach it
#   ./root-w3bs-os.sh umount host
#   ./root-w3bs-os.sh share /mnt/volume -R   # open an existing volume
#   ./root-w3bs-os.sh share /mnt/volume --group caddy -R
#
# Confinement (see "confinement" below, or `confine --help`):
#   ./root-w3bs-os.sh confine            # what is confined on this box, and what is not
#   ./root-w3bs-os.sh confine apply      # re-apply it without a full run
#
# Every account that is not an admin is confined, by default, with nothing to
# remember. root and anyone in wheel/sudo/admin are exempt. It never takes
# admin rights away from an account that already has them; `confine` names
# those and leaves the decision to you. CONFINE=0 turns the whole thing off.
#
# Sandboxed tenants -- an account that gets its own machine (incus) instead of
# a shell on this one (see "sandboxes" below, or `sandbox --help`):
#   ./root-w3bs-os.sh alice --sandbox        # alice gets a container, no host shell
#   ./root-w3bs-os.sh bob --sandbox=vm       # ...and bob gets a real VM
#   ./root-w3bs-os.sh sandbox                # who the tenants are, and their ports
#
# Accounts and groups (see "accounts" below, or `groups --help`):
#   ./root-w3bs-os.sh groups                 # every account, and the groups it is in
#   ./root-w3bs-os.sh groups add alice docker
#   ./root-w3bs-os.sh groups rm alice docker
#   ./root-w3bs-os.sh groups set alice wheel,users
#
# Flags:
#   --refresh          non-interactive update pass over the existing box
#   --groups LIST      groups for the accounts named on this run (no prompt)
#   --force            run on something that is not Alpine (unsupported)
#   --force-dotfiles   overwrite user-edited dotfiles (a .bak is kept)
#   --no-reboot        never reboot, whatever was upgraded
#   --reboot           reboot at the end if the kernel asked for one
#   --with-moshcode / --without-moshcode   moshcode for every account (default on)
#   --with-sh1pt / --without-sh1pt         sh1pt for every account (default off)
#   --sandbox[=container|vm]   accounts named on this run become tenants
#   --no-sandbox / --skip-sandbox
#   --skip-apk / --skip-web / --skip-tailscale / --skip-tools / --skip-dotfiles
#   --skip-firewall
#   -h | --help
#
# Configuration, in order of precedence: the environment, then $SERVER_CONFIG
# (default /etc/cli-tools/server.conf), the same file root-ubuntu.sh reads.
# KEY=value, one per line, # for comments -- read rather than sourced, so
# nothing in it executes and the environment still wins:
#
#   WEB_DOMAIN=dev.example.com
#   ACME_EMAIL=ops@example.com
#   DOTFILES_REPO=git@github.com:example/dotfiles.git
#
# Env overrides (everything root-ubuntu.sh documents applies here too, minus
# the nginx/certbot/apt-only keys; these are the ones that differ):
#   SSH_PORT=22    port to open in ufw
#   SWAP_SIZE=2G / SWAP_FILE=/swapfile / SWAPPINESS=10
#   ZRAM_ENABLE=1  ZRAM_SIZE_MB=  (default min(RAM/2, 8192)) ZRAM_ALGO=zstd
#   EARLYOOM_ENABLE=1 EARLYOOM_MEM=10,5 EARLYOOM_SWAP=10,5 EARLYOOM_AVOID=...
#   AUTO_UPGRADE=1 daily unattended upgrade from /etc/periodic/daily (0 = off)
#   LOGROTATE_ENABLE=1 / LOGROTATE_MAXSIZE=200M / LOGROTATE_KEEP=14
#   FAIL2BAN_ENABLE=1 (+ the FAIL2BAN_* knobs root-ubuntu.sh has)
#   ASSUME_YES=1   don't prompt
#   DEFAULT_GROUPS=... groups an account lands in when --groups is not passed
#                  (default: users when confinement is on, wheel when it is not)
#   CONFINE=0      do not confine accounts at all (default: 1)
#   CONFINE_EXEMPT_GROUPS=wheel,sudo,admin   who counts as an admin
#   CONFINE_CGROUP=1  per-account cgroup v2 caps (memory/pids), see confinement
#   WITH_MOSHCODE=1 / WITH_SH1PT=0
#   W3BS_INSTALL=1 route catalog tools through `w3bs install` (0 = curl installers)
#   WEB_DOMAIN=... domain for the per-user pages
#   WEB_TLS=auto|internal|off   auto: Caddy gets real certificates (ACME);
#                  internal: Caddy's own local CA (no public DNS needed);
#                  off: plain http only
#   CADDY_ADMIN=localhost:2019  the admin API; never anything but loopback
#   DEV_APPS=0     turn off <app>.<user>.$WEB_DOMAIN hosting
#   DOTFILES_REPO=... git URL of the dotfiles to install (optional)
#   PORKBUN_API_KEY=... PORKBUN_SECRET_API_KEY=...  create the DNS records
#                  (Caddy does the certificates itself; no DNS-01 needed)
#   TS_AUTHKEY=... tailscale auth key, to join the tailnet unattended
#
# --- on being re-runnable -----------------------------------------------
# Every step is written to converge, not to assume a blank machine:
#   * files we own are rewritten only when the content actually changes, so
#     Caddy is not reloaded and services are not restarted for nothing
#   * files a USER owns (.zshrc, .gitconfig, .irssi/config, ~/public_html)
#     are never clobbered once they have diverged from what we shipped
#   * no reboot unless the box says one is required AND you agree to it
#   * a lock file makes two concurrent runs impossible
#
# --- on secrets ---------------------------------------------------------
# There are none in this file and there must never be. It is public, it is
# curled onto machines by strangers, and every credential it can use is read
# from the environment or from $SERVER_CONFIG.

# Deliberately POSIX so that busybox ash can parse and run it: this is the one
# thing in the file that has to work in the wrong shell, because its whole job
# is to get us into the right one. Everything past it is bash.
if [ -z "${BASH_VERSION:-}" ]; then
	# Started from a file (sh root-w3bs-os.sh): install bash if this is Alpine
	# and we are root, then run the same file again under it. Piped (curl | sh),
	# $0 is the shell itself and there is no file to re-run.
	if [ -f "$0" ] && grep -q '^# root-w3bs-os.sh --' "$0" 2>/dev/null; then
		if ! command -v bash >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && command -v apk >/dev/null 2>&1; then
			echo "root-w3bs-os.sh: installing bash (apk add bash) to run under it" >&2
			apk add -q bash >/dev/null 2>&1 || true
		fi
		if command -v bash >/dev/null 2>&1; then
			exec bash "$0" "$@"
		fi
	fi
	echo "root-w3bs-os.sh: this is a bash script and you are running it under sh." >&2
	echo "  apk add bash && curl -fsSL <url>/root-w3bs-os.sh | bash -s -- --refresh" >&2
	echo "  ...or: sh root-w3bs-os.sh (installs bash itself when run as root)" >&2
	exit 1
fi

set -uo pipefail

# The packaged release (w3bs install profullstack.com/root-w3bs-os). Bump with every
# change that ships, and tag the commit root-w3bs-os-v<version>.
ROOT_W3BS_OS_VERSION=0.1.0
case "${1:-}" in
	--version|-V) printf 'root-w3bs-os %s\n' "$ROOT_W3BS_OS_VERSION"; exit 0 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || SCRIPT_DIR=""

# ------------------------------------------------------------------ config ---

# Read before anything else looks at a variable, so the file can supply any of
# the defaults below.
#
# READ, not sourced, for two reasons. The environment has to win over the file
# -- that is the rule everywhere else in this repository -- and `.` assigns
# unconditionally, so a sourced config would quietly beat the variable someone
# just put on the command line. And this runs as root: sourcing hands whatever
# is in /etc/cli-tools/server.conf the whole machine, where a config file only
# needs to carry values.
#
# So it is KEY=value, one per line, # for comments, surrounding quotes stripped.
# No expansion, no substitution, nothing executed.
SERVER_CONFIG="${SERVER_CONFIG:-/etc/cli-tools/server.conf}"
read_server_config() {
	local file="$1" line key val
	[[ -r "$file" ]] || return 0
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^[[:space:]]*# ]] && continue
		[[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
		key="${BASH_REMATCH[1]}"
		val="${BASH_REMATCH[2]}"
		# Already in the environment? Then that is the answer, and this line is
		# only what the file would have said.
		[[ -n "${!key+set}" ]] && continue
		# trailing whitespace, then one layer of matching quotes
		val="${val%"${val##*[![:space:]]}"}"
		if [[ "$val" == \"*\" && ${#val} -ge 2 ]]; then
			val="${val:1:${#val}-2}"
		elif [[ "$val" == \'*\' && ${#val} -ge 2 ]]; then
			val="${val:1:${#val}-2}"
		fi
		printf -v "$key" '%s' "$val"
	done <"$file"
	return 0
}
read_server_config "$SERVER_CONFIG"

SSH_PORT="${SSH_PORT:-22}"
ASSUME_YES="${ASSUME_YES:-0}"
MOTD_URL="${MOTD_URL:-https://profullstack.com/motd}"
MOTD_CACHE=/var/cache/profullstack-motd

# Everything this script remembers between runs lives here: which users it
# provisioned, and the checksum of each file it installed into their homes.
# The same directory root-ubuntu.sh uses, so the record means the same thing
# whichever of the two wrote it.
STATE_DIR="${STATE_DIR:-/var/lib/profullstack}"
USERS_STATE="$STATE_DIR/users"
# /run/lock is not a given on Alpine (/var/lock is a symlink to it only once
# OpenRC has booted), so the lock lives in /run directly.
LOCK_FILE="${LOCK_FILE:-/run/root-w3bs-os.lock}"
LOG_FILE="${LOG_FILE:-/var/log/root-w3bs-os.log}"

FORCE_OS="${FORCE_OS:-0}"
FORCE_DOTFILES="${FORCE_DOTFILES:-0}"
SKIP_APK="${SKIP_APK:-0}"
SKIP_WEB="${SKIP_WEB:-0}"
SKIP_TAILSCALE="${SKIP_TAILSCALE:-0}"
SKIP_TOOLS="${SKIP_TOOLS:-0}"
SKIP_DOTFILES="${SKIP_DOTFILES:-0}"
SKIP_FIREWALL="${SKIP_FIREWALL:-0}"
# 0 = never, 1 = only if the box says a reboot is required, 2 = always ask
REBOOT_POLICY=1

# The catalog tools. moshcode is on by default, as it is in root-ubuntu.sh;
# sh1pt is opt-in (--with-sh1pt), since not every box ships anything.
WITH_MOSHCODE="${WITH_MOSHCODE:-1}"
WITH_SH1PT="${WITH_SH1PT:-0}"
# Route the catalog tools through `w3bs install` (receipts, `w3bs update`
# keeps them current, the scan verdict is checked) when the CLI is present.
# 0 forces the publishers' curl installers, which is also the fallback when
# w3bs is missing or a tool is not in the catalog.
W3BS_INSTALL="${W3BS_INSTALL:-1}"
W3BS_CATALOG_URL="${W3BS_CATALOG_URL:-https://w3bs.org/api/packages}"
W3BS_INSTALLER_URL="${W3BS_INSTALLER_URL:-https://w3bs.org/install.sh}"
# Catalog ids, checked against $W3BS_CATALOG_URL at run time.
W3BS_ID_MOSHCODE="${W3BS_ID_MOSHCODE:-moshcode.sh/moshcode}"
W3BS_ID_THREATCRUSH="${W3BS_ID_THREATCRUSH:-threatcrush.com/threatcrush}"
W3BS_ID_HQTERM="${W3BS_ID_HQTERM:-hqterm.sh/hqterm}"
W3BS_ID_SH1PT="${W3BS_ID_SH1PT:-sh1pt.com/sh1pt}"

# Daily unattended upgrade, the Alpine stand-in for unattended-upgrades: within
# a stable branch every apk upgrade is a security or bug fix, so the whole
# upgrade is the safe set.
AUTO_UPGRADE="${AUTO_UPGRADE:-1}"

# Dotfiles are OPTIONAL and they are not in this repository.
#
# They cannot be: a dotfiles tree carries ssh config, known_hosts, sometimes
# keys, and this file is public. So the shell/editor/tmux/irssi configuration a
# team wants on its boxes lives in that team's own repo, and this clones it if
# you name one. With no DOTFILES_REPO the box still gets everything else --
# packages, firewall, accounts, zsh, oh-my-zsh, mise, moshcode, Caddy, TLS --
# and simply keeps whatever dotfiles each account already had.
#
# DOTFILES_DIR points at an existing checkout instead, which is what a run from
# inside such a repo wants: put this script beside the dotfiles and it uses
# them without cloning anything.
DOTFILES_REPO="${DOTFILES_REPO:-}"
DOTFILES_DIR="${DOTFILES_DIR:-}"
DOTFILES_CACHE="${DOTFILES_CACHE:-$STATE_DIR/dotfiles-src}"

# Where a pasted public key is filed so that re-runs and rebuilds keep working.
KEYS_DIR="${KEYS_DIR:-}"

# Tailscale. TS_AUTHKEY joins the tailnet unattended; without it the script
# prints the command to run by hand.
TS_AUTHKEY="${TS_AUTHKEY:-}"
# set_box_hostname renames the box; a tailnet name nobody chose follows it.
TS_HOSTNAME_GIVEN="${TS_HOSTNAME:+1}"
TS_HOSTNAME="${TS_HOSTNAME:-$(hostname -s 2>/dev/null || hostname)}"
BOX_HOSTNAME="${BOX_HOSTNAME:-}"

# Per-user web hosting: https://WEB_DOMAIN/~user and https://user.WEB_DOMAIN
WEB_DOMAIN="${WEB_DOMAIN:-dev.profullstack.com}"
# each user's address is <login>@MAIL_DOMAIN
MAIL_DOMAIN="${MAIL_DOMAIN:-profullstack.com}"
MAIL_URL="${MAIL_URL:-https://forwardemail.net/}"
# the comms network, reached over ssh
BBS_DOMAIN="${BBS_DOMAIN:-bbs.profullstack.com}"
WEBMAIL_URL="${WEBMAIL_URL:-https://mail.forwardemail.net/}"
PORKBUN_API_KEY="${PORKBUN_API_KEY:-}"
PORKBUN_SECRET_API_KEY="${PORKBUN_SECRET_API_KEY:-}"
# No default, and no personal address baked in. Caddy uses it only as the ACME
# account contact (expiry warnings); issuance works without one.
ACME_EMAIL="${ACME_EMAIL:-}"
# Where a Moshpit name with nothing pointed at it is sent -- see the port-80
# catch-all in the Caddyfile. Empty turns parking off.
MOSHPIT_PARKING_URL="${MOSHPIT_PARKING_URL-https://pit.moshcode.sh/n}"
COPY_SSH_PRIVATE_KEYS="${COPY_SSH_PRIVATE_KEYS:-0}"

# Caddy, the W3BS OS web server. It replaces root-ubuntu.sh's nginx + certbot
# + acme.sh: every hostname a site block names gets a certificate on its own
# (HTTP-01/TLS-ALPN, dual-stack), so there is no wildcard, no DNS-01 and no
# renewal job to look after.
#
#   auto      real certificates from a public ACME CA. Needs the names to
#             resolve here and ports 80/443 reachable.
#   internal  Caddy's own local CA: https everywhere, a browser warning until
#             the CA is trusted. For a box with no public DNS.
#   off       plain http on port 80, no certificates at all.
WEB_TLS="${WEB_TLS:-auto}"
CADDY_ADMIN="${CADDY_ADMIN:-localhost:2019}"
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"
CADDYFILE="$CADDY_DIR/Caddyfile"
# One import file per account: its page and its dev apps. Rewritten by the
# devapps generator, so a new ~/apps/<name> goes live without root.
CADDY_USERS_DIR="$CADDY_DIR/users"
CADDY_CONF_DIR="$CADDY_DIR/conf.d"
CADDY_LOG_DIR="${CADDY_LOG_DIR:-/var/log/caddy}"

# Per-user dev apps: https://<app>.<user>.$WEB_DOMAIN
# Static from ~/apps/<app>/public, or reverse-proxied to 127.0.0.1:<port>
# when ~/apps/<app>/.port holds a port number.
DEV_APPS="${DEV_APPS:-1}"

# --- sandboxed tenants ---------------------------------------------------
#
# See "sandboxes" further down. In one line: an account with SANDBOX=1 gets its
# own container (or VM) and no shell on this box at all.
SANDBOX="${SANDBOX:-0}"
# container = unprivileged LXC, shared kernel, instant. vm = KVM, own kernel.
SANDBOX_KIND="${SANDBOX_KIND:-container}"
SKIP_SANDBOX="${SKIP_SANDBOX:-0}"
SANDBOX_PREFIX="${SANDBOX_PREFIX:-dev-}"
# The tenant's group on the HOST. Deliberately not `users`: that group is what
# `share` opens every mounted volume to, and a tenant is exactly who must not
# be in it.
SANDBOX_GROUP="${SANDBOX_GROUP:-tenants}"
SANDBOX_NOLOGIN="${SANDBOX_NOLOGIN:-/sbin/nologin}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-images:ubuntu/24.04/cloud}"
SANDBOX_POOL="${SANDBOX_POOL:-tenants}"
SANDBOX_POOL_DRIVER="${SANDBOX_POOL_DRIVER:-}"
SANDBOX_POOL_SIZE="${SANDBOX_POOL_SIZE:-100GiB}"
SANDBOX_BRIDGE="${SANDBOX_BRIDGE:-tenantbr0}"
SANDBOX_SUBNET="${SANDBOX_SUBNET:-10.171.0.1/24}"
SANDBOX_DNS="${SANDBOX_DNS:-1.1.1.1,9.9.9.9}"
SANDBOX_CPU="${SANDBOX_CPU:-2}"
SANDBOX_MEMORY="${SANDBOX_MEMORY:-2GiB}"
SANDBOX_DISK="${SANDBOX_DISK:-20GiB}"
SANDBOX_PROCESSES="${SANDBOX_PROCESSES:-2048}"
SANDBOX_NESTING="${SANDBOX_NESTING:-0}"
SANDBOX_SSH_PORT_BASE="${SANDBOX_SSH_PORT_BASE:-2200}"
SANDBOX_PORT_BASE="${SANDBOX_PORT_BASE:-21000}"
SANDBOX_PORT_SPAN="${SANDBOX_PORT_SPAN:-100}"
SANDBOX_MOSH_PORTS="${SANDBOX_MOSH_PORTS:-10}"
SANDBOX_MAX_SLOTS="${SANDBOX_MAX_SLOTS:-200}"
SANDBOX_DENY_NETS="${SANDBOX_DENY_NETS:-10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 fc00::/7 fe80::/10}"
SANDBOX_ACL="${SANDBOX_ACL:-tenants}"
SANDBOX_STATE="$STATE_DIR/sandbox"
SANDBOX_TENANTS="$SANDBOX_STATE/tenants"
# Bump to re-run the in-instance setup for every tenant on the next pass.
SANDBOX_BOOTSTRAP_REV=1
SANDBOX_REV_FILE=/var/lib/profullstack/tenant-rev
SANDBOX_BOOT_TIMEOUT="${SANDBOX_BOOT_TIMEOUT:-120}"

# Block AI/LLM crawlers and aggressive scrapers by User-Agent. Search engines
# are deliberately NOT in the list: blocking Googlebot/Bingbot would deindex
# the box rather than protect it.
BLOCK_AI_BOTS="${BLOCK_AI_BOTS:-1}"
AI_CRAWLER_AGENTS=(
	# OpenAI
	GPTBot OAI-SearchBot ChatGPT-User
	# Anthropic
	ClaudeBot Claude-Web Claude-User Claude-SearchBot anthropic-ai
	# Google / Apple opt-out crawlers (NOT Googlebot itself)
	Google-Extended Applebot-Extended
	# Perplexity
	PerplexityBot Perplexity-User
	# Meta
	meta-externalagent meta-externalfetcher FacebookBot
	# Common Crawl -- the corpus most models train on
	CCBot
	# ByteDance / Amazon / others
	Bytespider Amazonbot cohere-ai Diffbot omgili omgilibot
	ImagesiftBot YouBot AI2Bot Timpibot iaskspider DuckAssistBot
	PanguBot "Kangaroo Bot" Webzio-Extended Scrapy
	# generic scraper stacks that ignore robots.txt
	python-requests python-httpx libwww-perl HTTrack Nutch
)

# The sponsor ad root-ubuntu.sh can put on the per-user pages is an nginx
# feature (SSI + random_index + add_before_body) and is NOT ported to Caddy.
# It is off unless a slot is configured there too, so the only thing to do
# with a configured slot here is say that it does nothing.
SPONSOR_AD_SLOT="${SPONSOR_AD_SLOT:-}"

# Logo shown at the top of the landing page. Cached locally so the page does
# not depend on profullstack.com being up.
LOGO_URL="${LOGO_URL:-https://profullstack.com/assets/logo.svg}"
LOGO_FILE=/var/www/userdirs/assets/logo.svg

# Group menu offered when creating a user. Alpine's admin group is wheel
# (doas and sudo both point at it); sudo/admin are honoured where they exist.
GROUP_CHOICES=(wheel docker adm caddy users)
# Was it said out loud, or is it just the default? Confinement turns the
# default from wheel into users, and the difference between "nobody chose
# this" and "the config file chose this" is the whole basis for being allowed
# to change it underneath them.
DEFAULT_GROUPS_EXPLICIT="${DEFAULT_GROUPS+1}"
DEFAULT_GROUPS="${DEFAULT_GROUPS:-wheel}"

# ------------------------------------------------------- confinement ---
#
# These boxes are multi-tenant, so the default has to be that an account is
# confined and an admin is let out, rather than the other way round.
#
#   root       untouched, always. Never capped, never blinded, never denied.
#   admin      anyone in $CONFINE_EXEMPT_GROUPS. Exempt from the resource
#              caps, and kept able to see every process on the box.
#   confined   everybody else, by default, with nothing to remember.
#
# What each mechanism is actually worth on Alpine is written up at
# configure_confinement below. CONFINE=0 turns all of it off.
CONFINE="${CONFINE:-1}"
CONFINE_GROUP="${CONFINE_GROUP:-confined}"
CONFINE_EXEMPT_GROUPS="${CONFINE_EXEMPT_GROUPS:-wheel,sudo,admin}"
CONFINE_PROC_GROUP="${CONFINE_PROC_GROUP:-proc}"
CONFINE_HIDEPID="${CONFINE_HIDEPID:-1}"
CONFINE_HOME_MODE="${CONFINE_HOME_MODE:-0700}"
CONFINE_UMASK="${CONFINE_UMASK:-027}"
CONFINE_SYSCTL="${CONFINE_SYSCTL:-1}"

# Resource caps. There is no systemd user slice under OpenRC, so they are a
# cgroup v2 group per account (/sys/fs/cgroup/w3bs.confined/<login>) that
# every process of a confined account is moved into: by pam_exec at login
# where sshd runs with PAM, and by a once-a-minute sweep from crond either way.
# Memory and tasks are hard caps; CPU is a weight.
CONFINE_CGROUP="${CONFINE_CGROUP:-1}"
CONFINE_CGROUP_ROOT="${CONFINE_CGROUP_ROOT:-/sys/fs/cgroup/w3bs.confined}"
CONFINE_MEMORY_HIGH="${CONFINE_MEMORY_HIGH:-35%}"
CONFINE_MEMORY_MAX="${CONFINE_MEMORY_MAX:-50%}"
CONFINE_TASKS_MAX="${CONFINE_TASKS_MAX:-4096}"
CONFINE_CPU_WEIGHT="${CONFINE_CPU_WEIGHT:-100}"
# A hard CPU ceiling (systemd slices only: CPUQuota=, e.g. 200%).
CONFINE_CPU_QUOTA="${CONFINE_CPU_QUOTA:-}"

# PAM limits. They only bite where sshd is built with PAM (openssh-server-pam,
# UsePAM yes); Alpine's default sshd is not, and `confine` says which it is.
CONFINE_NPROC="${CONFINE_NPROC:-4096}"
CONFINE_NOFILE="${CONFINE_NOFILE:-16384}"
CONFINE_MAXLOGINS="${CONFINE_MAXLOGINS:-20}"

# local  -- ssh -L to their own app still works, ssh -R relays do not
# no     -- no forwarding at all
# yes    -- off; this box is a jump host on purpose
CONFINE_SSH_FORWARDING="${CONFINE_SSH_FORWARDING:-local}"
CONFINE_SSH="${CONFINE_SSH:-1}"

# An unattended run creates accounts with $DEFAULT_GROUPS, and wheel on a
# confined box would hand every new tenant the way out of confinement. Only
# the default moves: a DEFAULT_GROUPS in the environment or server.conf stands.
if [[ "$CONFINE" == 1 && -z "$DEFAULT_GROUPS_EXPLICIT" ]]; then
	DEFAULT_GROUPS="users"
fi

USERS=()         # alice@example -- new this run, get the full treatment
USER_GROUPS=()   # wheel           -- index-matched to USERS
KNOWN_USERS=()   # logins provisioned by an earlier run, refreshed not created
FAILED=()
PRESERVED=()     # files left alone because the user had edited them
CHANGED=()       # things this run actually altered (for the closing summary)

# ---------------------------------------------------------------- helpers ---

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# Run a step; failures are collected and reported at the end instead of
# aborting. The old script died halfway through on one bad package.
try() {
	local desc="$1"; shift
	info "$desc"
	if ! "$@"; then
		warn "$desc -- failed (continuing)"
		FAILED+=("$desc")
		return 1
	fi
}

note() { CHANGED+=("$*"); info "$*"; }

interactive() { [[ -t 0 && "$ASSUME_YES" != 1 ]]; }

confirm() {
	local prompt="$1" default="${2:-n}" ans
	interactive || { [[ "$default" == y ]]; return; }
	read -r -p "$prompt " ans
	ans="${ans:-$default}"
	[[ "$ans" =~ ^[Yy] ]]
}

user_login() { printf '%s' "${1%%@*}"; }   # alice@example -> alice
user_home()  { getent passwd "$1" | cut -d: -f6; }

valid_login() { [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }

# Run a command as $1 with a login-ish env (installers write into ~).
#
# runuser -u keeps the caller's environment AND working directory, so both
# have to be replaced:
#   HOME  -- otherwise installers run for alice still write into /root
#   cwd   -- otherwise anything touching the cwd dies when the script is run
#            from a directory the target user cannot reach, e.g.
#            /root/provision ("sh: cd: can't cd to /root/provision")
as_user() {
	local login="$1"; shift
	local home v
	home="$(user_home "$login")"
	[[ -n "$home" ]] || { warn "no home dir for $login"; return 1; }

	# env -i, NOT the inherited environment. runuser -u keeps the caller's
	# variables, and root's shell exports plenty that are wrong for anybody
	# else. This script points root's shell at our .zshrc, which does
	# 'export ZSH="$HOME/.oh-my-zsh"' -- so from the second run onwards root
	# carries ZSH=/root/.oh-my-zsh, the oh-my-zsh installer honours it over
	# $HOME, and the clone dies with
	#     fatal: cannot mkdir /root/.oh-my-zsh: Permission denied
	# while ostensibly installing for someone else. NVM_DIR, ZDOTDIR,
	# CARGO_HOME and the MISE_* family all leak the same way.
	#
	# Starting clean and letting bash -l rebuild from /etc/profile is the only
	# version of this that stays correct as people add exports to the dotfiles.
	local -a envs=(
		HOME="$home" USER="$login" LOGNAME="$login" SHELL=/bin/bash
		PATH="$home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
		TERM="${TERM:-dumb}"
	)
	# a box behind a proxy still has to reach the network
	for v in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
		[[ -n "${!v:-}" ]] && envs+=("$v=${!v}")
	done

	# cd happens here, in the parent, while still root -- root can enter any
	# directory, and the child then inherits a cwd its own user can reach.
	# stdin from /dev/null: these run inside 'while read ... done < <(...)'
	# loops, and anything that decides to prompt (a git credential helper on a
	# 401, say) would otherwise eat the rest of the list being iterated.
	if [[ "$login" == root ]]; then
		( cd -- "$home" && env -i "${envs[@]}" bash -lc "$*" </dev/null 9>&- )
	else
		# runuser is its own apk (bootstrap_tools installs it). su is the
		# fallback, with -s so a nologin or zsh login shell does not decide
		# what interprets the command.
		if command -v runuser >/dev/null 2>&1; then
			( cd -- "$home" && runuser -u "$login" -- \
				env -i "${envs[@]}" bash -lc "$*" </dev/null 9>&- )
		else
			( cd -- "$home" && su -s /bin/sh "$login" -c \
				"$(printf '%q ' env -i "${envs[@]}" bash -lc "$*")" </dev/null 9>&- )
		fi
	fi
}

# git clone, or fast-forward if it's already there. Keeps re-runs cheap.
#
# --depth 1 clones cannot always fast-forward (the new tip may not descend from
# the shallow tip), so fetch+reset onto the remote head instead of pull.
clone_or_pull() {
	local login="$1" url="$2" dest="$3"
	if as_user "$login" "test -d '$dest/.git'"; then
		as_user "$login" "git -C '$dest' fetch --quiet --depth 1 origin HEAD \
			&& git -C '$dest' reset --quiet --hard FETCH_HEAD" \
			|| as_user "$login" "git -C '$dest' pull --ff-only --quiet" || true
		return
	fi

	# A directory that exists but is not a git checkout belongs to the user --
	# ~/.tmux full of tpm plugins and saved sessions, say. The old 'rm -rf and
	# clone' would delete the lot on the first re-run, so refuse instead.
	if [[ -e "$dest" ]] && [[ -n "$(ls -A "$dest" 2>/dev/null)" ]]; then
		warn "$dest exists and is not a git checkout -- left alone (not installing $url)"
		return 1
	fi
	as_user "$login" "rm -rf '$dest' && git clone --depth 1 --quiet '$url' '$dest'"
}

# ------------------------------------------------- converge, don't clobber ---

file_sha() { [[ -f "$1" ]] && sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# Write stdin to $1 only if the content differs. Returns 0 when it changed, 1
# when it did not -- so callers can reload a service only when there is a
# reason to. Re-running the script should not bounce Caddy for nothing.
write_if_changed() {
	local dest="$1" mode="${2:-0644}" tmp
	tmp="$(mktemp)" || return 1
	cat >"$tmp"
	if [[ -f "$dest" ]] && cmp -s "$tmp" "$dest"; then
		rm -f "$tmp"
		chmod "$mode" "$dest"
		return 1
	fi
	install -m "$mode" "$tmp" "$dest"
	rm -f "$tmp"
	return 0
}

# Where we remember the checksum of the copy we installed for a user.
_state_path() {
	local login="$1" dest="$2"
	printf '%s/dotfiles/%s/%s' "$STATE_DIR" "$login" "${dest//\//%}"
}

# Has this exact content ever been shipped by this repo?
#
# The state file only knows about runs of the NEW script. On a box provisioned
# before it existed there is no record, and every dotfile would look
# user-edited -- which would freeze those boxes forever. So also ask git: if
# the file matches ANY revision of the template in this checkout's history,
# nobody has hand-edited it and updating is safe.
_matches_repo_history() {
	local dest="$1" rel="$2" blob want
	# No checkout, no history to compare against -- every file then looks
	# user-edited, which is the safe answer rather than a wrong one.
	[[ -n "$DOTFILES_DIR" ]] || return 1
	command -v git >/dev/null || return 1
	git -C "$DOTFILES_DIR" rev-parse --git-dir >/dev/null 2>&1 || return 1
	blob="$(git -C "$DOTFILES_DIR" hash-object "$dest" 2>/dev/null)" || return 1
	[[ -n "$blob" ]] || return 1

	want="$(git -C "$DOTFILES_DIR" log --format='%H' --all -- "$rel" 2>/dev/null \
		| sed "s|\$|:$rel|" \
		| git -C "$DOTFILES_DIR" cat-file --batch-check='%(objectname)' 2>/dev/null \
		| grep -qxF "$blob" && echo yes)"
	[[ "$want" == yes ]]
}

# Install $src at $dest for $owner, unless the user has made it theirs.
#
#   dest missing .................. install
#   dest already identical ........ nothing to do (just record it)
#   dest == what we last wrote .... ours, safe to update
#   dest is some older template ... ours, safe to update
#   anything else ................. THEIRS: leave it, drop a .new beside it
#
# --force-dotfiles overrides the last case, keeping a .bak.
install_managed() {
	local src="$1" dest="$2" owner="$3" mode="${4:-0644}" rel="${5:-}"
	local src_sha dest_sha recorded state
	[[ -f "$src" ]] || return 0
	# repo cloned into the very home we are installing to: same file
	[[ "$src" -ef "$dest" ]] && return 0

	rel="${rel:-$(basename "$dest")}"
	state="$(_state_path "$owner" "$dest")"
	src_sha="$(file_sha "$src")"

	if [[ -e "$dest" ]]; then
		dest_sha="$(file_sha "$dest")"
		if [[ -n "$dest_sha" && "$dest_sha" == "$src_sha" ]]; then
			_record_managed "$state" "$src_sha"
			chown "$owner:$owner" "$dest" 2>/dev/null
			return 0
		fi
		recorded="$(cat "$state" 2>/dev/null || true)"
		if [[ "$FORCE_DOTFILES" == 1 ]]; then
			cp -p "$dest" "$dest.bak" 2>/dev/null
			warn "overwriting $dest (backup: $dest.bak)"
		elif [[ -n "$recorded" && "$dest_sha" == "$recorded" ]]; then
			: # we wrote it and it has not been touched since
		elif _matches_repo_history "$dest" "$rel"; then
			: # an older version of this same template
		else
			# theirs. Show them the new version without taking anything away.
			if ! cmp -s "$src" "$dest.new" 2>/dev/null; then
				install -m "$mode" -o "$owner" -g "$owner" "$src" "$dest.new" 2>/dev/null
			fi
			PRESERVED+=("$dest")
			return 0
		fi
	fi

	install -D -m "$mode" -o "$owner" -g "$owner" "$src" "$dest" \
		|| { warn "could not install $dest"; return 1; }
	_record_managed "$state" "$src_sha"
	note "updated $dest"
	return 0
}

_record_managed() {
	local state="$1" sha="$2"
	[[ -n "$sha" ]] || return 0
	install -d -m 0700 "$(dirname "$state")" 2>/dev/null
	printf '%s\n' "$sha" >"$state" 2>/dev/null || true
}

# --------------------------------------------------------- managed users ---

# The set of accounts this script looks after. Recorded so that a bare re-run
# refreshes everyone instead of only the users named on the command line.
load_known_users() {
	local l
	if [[ -s "$USERS_STATE" ]]; then
		while read -r l; do
			[[ -n "$l" ]] && id -u "$l" >/dev/null 2>&1 && KNOWN_USERS+=("$l")
		done <"$USERS_STATE"
	fi

	# Nothing recorded: this is either a fresh box or one provisioned by an
	# older version of the script. Adopt the real humans already on it --
	# regular uids, a home under /home, an actual login shell.
	if [[ ${#KNOWN_USERS[@]} -eq 0 ]]; then
		while IFS=: read -r l _ uid _ _ home shell; do
			[[ "$uid" -ge 1000 && "$uid" -lt 65534 ]] || continue
			[[ "$home" == /home/* && -d "$home" ]] || continue
			[[ "$shell" == */nologin || "$shell" == */false ]] && continue
			KNOWN_USERS+=("$l")
		done < <(getent passwd)
	fi
}

remember_user() {
	local login="$1"
	install -d -m 0755 "$STATE_DIR"
	touch "$USERS_STATE"
	grep -qxF "$login" "$USERS_STATE" 2>/dev/null || printf '%s\n' "$login" >>"$USERS_STATE"
}

# every login this run should touch: previously known + newly created
all_logins() {
	local out=() u l
	for l in ${KNOWN_USERS[@]+"${KNOWN_USERS[@]}"}; do out+=("$l"); done
	for u in ${USERS[@]+"${USERS[@]}"}; do
		l="$(user_login "$u")"
		printf '%s\n' "${out[@]+"${out[@]}"}" | grep -qxF "$l" || out+=("$l")
	done
	printf '%s\n' "${out[@]+"${out[@]}"}"
}

# --------------------------------------------------------------- platform ---
#
# Everything root-ubuntu.sh could take for granted and this cannot: which init
# is running, whether we are in a container, and how to install a package.
# Kept in one place so the sections below read like their Ubuntu originals.

# The init actually running, not the one installed. Asked once.
#
#   systemd   /run/systemd/system exists only while systemd is PID 1
#   openrc    the OpenRC run directory exists once it has booted; a container
#             started without /sbin/init has openrc installed and not running,
#             and rc-service there fails in ways that read like broken units
#   none      no init we can talk to (a plain `docker run`): services are not
#             managed, everything else still converges
INIT_SYSTEM=""
detect_init() {
	[[ -n "$INIT_SYSTEM" ]] && { printf '%s' "$INIT_SYSTEM"; return; }
	if [[ -d /run/systemd/system ]]; then
		INIT_SYSTEM=systemd
	elif command -v rc-service >/dev/null 2>&1 && [[ -d /run/openrc ]]; then
		INIT_SYSTEM=openrc
	else
		INIT_SYSTEM=none
	fi
	printf '%s' "$INIT_SYSTEM"
}

# One name per service across both inits. Alpine and systemd mostly agree; the
# exceptions are listed rather than guessed.
_svc_name() {
	local name="$1"
	if [[ "$(detect_init)" == systemd ]]; then
		case "$name" in
			crond) printf 'crond' ;;
			*)     printf '%s' "$name" ;;
		esac
	else
		case "$name" in
			incus) printf 'incusd' ;;
			*)     printf '%s' "$name" ;;
		esac
	fi
}

# Enabled at boot? Converges silently when it already is.
svc_enable() {
	local s runlevel="${2:-default}"
	s="$(_svc_name "$1")"
	case "$(detect_init)" in
		systemd) systemctl is-enabled --quiet "$s" 2>/dev/null || systemctl enable --quiet "$s" 2>/dev/null ;;
		openrc)
			[[ -e "/etc/init.d/$s" ]] || return 1
			rc-update show "$runlevel" 2>/dev/null | awk '{print $1}' | grep -qxF "$s" && return 0
			rc-update add "$s" "$runlevel" >/dev/null 2>&1
			;;
		*) return 0 ;;
	esac
}

svc_disable() {
	local s; s="$(_svc_name "$1")"
	case "$(detect_init)" in
		systemd) systemctl disable --now --quiet "$s" 2>/dev/null ;;
		openrc)
			rc-service "$s" stop 9>&- >/dev/null 2>&1
			rc-update del "$s" >/dev/null 2>&1
			;;
	esac
	return 0
}

svc_is_active() {
	local s; s="$(_svc_name "$1")"
	case "$(detect_init)" in
		systemd) systemctl is-active --quiet "$s" 2>/dev/null ;;
		openrc)  rc-service "$s" status >/dev/null 2>&1 ;;
		*)       return 1 ;;
	esac
}

svc_start() {
	local s; s="$(_svc_name "$1")"
	svc_is_active "$1" && return 0
	case "$(detect_init)" in
		systemd) systemctl start "$s" 9>&- ;;
		openrc)  rc-service "$s" start 9>&- >/dev/null 2>&1 ;;
		*)       return 1 ;;
	esac
}

svc_restart() {
	local s; s="$(_svc_name "$1")"
	case "$(detect_init)" in
		systemd) systemctl restart "$s" 9>&- ;;
		openrc)
			if svc_is_active "$1"; then rc-service "$s" restart 9>&- >/dev/null 2>&1
			else rc-service "$s" start 9>&- >/dev/null 2>&1; fi
			;;
		*) return 1 ;;
	esac
}

svc_reload() {
	local s; s="$(_svc_name "$1")"
	case "$(detect_init)" in
		systemd) systemctl reload "$s" 9>&- 2>/dev/null || systemctl restart "$s" 9>&- ;;
		openrc)
			svc_is_active "$1" || { svc_start "$1"; return; }
			rc-service "$s" reload 9>&- >/dev/null 2>&1 || rc-service "$s" restart 9>&- >/dev/null 2>&1
			;;
		*) return 1 ;;
	esac
}

# Are we in a container? Alpine has no systemd-detect-virt, so ask the places
# a runtime leaves its mark. The W3BS OS docker editions also say so in
# /etc/w3bs-os-release, which is the most honest answer of all.
_in_container() {
	[[ -e /.dockerenv || -e /run/.containerenv ]] && return 0
	[[ "${W3BS_OS_EDITION:-}" == docker-* ]] && return 0
	grep -qaE 'container=(docker|podman|lxc)' /proc/1/environ 2>/dev/null && return 0
	[[ -r /proc/1/cgroup ]] && grep -qE '/(docker|lxc|kubepods|libpod)' /proc/1/cgroup && return 0
	return 1
}

# none | container | vm -- what root-ubuntu.sh got from systemd-detect-virt,
# coarser, but the only question ever asked of it is "is there real hardware".
_virt() {
	if _in_container; then printf 'container'; return; fi
	if command -v systemd-detect-virt >/dev/null 2>&1; then
		local v; v="$(systemd-detect-virt 2>/dev/null || true)"
		[[ -n "$v" && "$v" != none ]] && { printf '%s' "$v"; return; }
		printf 'none'; return
	fi
	grep -qw hypervisor /proc/cpuinfo 2>/dev/null && { printf 'vm'; return; }
	printf 'none'
}

# Installed? apk info -e is exact and needs no network.
apk_has() { apk info -e "$1" >/dev/null 2>&1; }

# apk add, quietly, of whatever is not there yet. Returns 0 if everything ends
# up installed. The community repository is where half of these live (caddy,
# ufw, earlyoom, fail2ban), so it is enabled first -- see ensure_apk_repos.
apk_add() {
	local p missing=()
	for p in "$@"; do apk_has "$p" || missing+=("$p"); done
	[[ ${#missing[@]} -eq 0 ]] && return 0
	apk add -q "${missing[@]}" >/dev/null 2>&1 && return 0
	# one at a time, so one unavailable package cannot take the batch down
	local rc=0
	for p in "${missing[@]}"; do
		apk add -q "$p" >/dev/null 2>&1 || { warn "apk add $p failed"; rc=1; }
	done
	return $rc
}

# The tools every other section assumes. busybox has most of them, but not
# with the flags this script (and root-ubuntu.sh before it) leans on:
#   coreutils   df --output, stat -c, date -Is/-d, install -D, who
#   findutils   find -printf
#   util-linux  swapon --show, mountpoint, zramctl, flock
#   shadow      useradd/usermod/gpasswd/groupadd/chsh/chpasswd, /etc/login.defs
#   runuser     as_user
#   sed/grep/gawk  GNU forms (0,/re/ addresses, -P is never used)
#   iproute2    ss, ip
#   bind-tools  dig (SPF checks)
#   procps-ng   free, pgrep -U, sysctl -n for every key
BOOTSTRAP_PACKAGES=(
	bash coreutils findutils util-linux util-linux-misc shadow runuser sed grep gawk
	iproute2 procps-ng curl ca-certificates git openssl jq acl tzdata bind-tools
)

# The W3BS OS edition, from /etc/w3bs-os-release (KEY=VALUE). Empty on plain
# Alpine.
W3BS_OS_ID=""
W3BS_OS_EDITION=""
read_w3bs_os_release() {
	local f="${1:-/etc/w3bs-os-release}" line
	[[ -r "$f" ]] || return 0
	while IFS= read -r line; do
		case "$line" in
			ID=*)      W3BS_OS_ID="${line#ID=}"; W3BS_OS_ID="${W3BS_OS_ID//\"/}" ;;
			EDITION=*) W3BS_OS_EDITION="${line#EDITION=}"; W3BS_OS_EDITION="${W3BS_OS_EDITION//\"/}" ;;
		esac
	done <"$f"
	return 0
}

# ------------------------------------------------------------------- w3bs ---
#
# The w3bs CLI is the front door for packages on W3BS OS. It is installed on
# every edition at /usr/local/bin/w3bs; on plain Alpine we install it there.
W3BS_BIN=""
w3bs_bin() {
	[[ -n "$W3BS_BIN" && -x "$W3BS_BIN" ]] && { printf '%s' "$W3BS_BIN"; return 0; }
	local c
	for c in /usr/local/bin/w3bs /usr/bin/w3bs /root/.local/bin/w3bs "$(command -v w3bs 2>/dev/null)"; do
		[[ -n "$c" && -x "$c" ]] && { W3BS_BIN="$c"; printf '%s' "$c"; return 0; }
	done
	return 1
}

# Put the CLI on a box that does not have it. The publisher installer (the
# same one w3bs.org links) verifies its download and lets w3bs install itself
# from its signed repository; W3BS_BIN_DIR puts the binary where every account
# finds it, so one install serves the whole box.
ensure_w3bs() {
	w3bs_bin >/dev/null && { info "w3bs $("$(w3bs_bin)" --version 2>/dev/null | awk '{print $2}') at $(w3bs_bin)"; return 0; }
	info "installing the w3bs CLI from $W3BS_INSTALLER_URL"
	curl -fsSL --max-time 120 "$W3BS_INSTALLER_URL" \
		| env HOME=/root W3BS_YES=1 W3BS_BIN_DIR=/usr/local/bin sh >/dev/null 2>&1 \
		|| { warn "could not install the w3bs CLI -- catalog tools fall back to their curl installers"; return 1; }
	W3BS_BIN=""
	w3bs_bin >/dev/null || { warn "the w3bs installer ran but no w3bs binary appeared"; return 1; }
	note "installed w3bs $("$(w3bs_bin)" --version 2>/dev/null | awk '{print $2}')"
	return 0
}

# The catalog ids w3bs.org lists, one per line, fetched once per run. Empty when
# the catalog cannot be reached -- in which case every tool is assumed to be in
# it and `w3bs install` itself decides, which is the answer it would give.
W3BS_CATALOG=""
W3BS_CATALOG_FETCHED=0
w3bs_catalog_has() {
	local id="$1"
	if [[ "$W3BS_CATALOG_FETCHED" == 0 ]]; then
		W3BS_CATALOG_FETCHED=1
		W3BS_CATALOG="$(curl -fsSL --max-time 20 "$W3BS_CATALOG_URL" 2>/dev/null \
			| jq -r '.packages[]?.id' 2>/dev/null)" || W3BS_CATALOG=""
	fi
	[[ -z "$W3BS_CATALOG" ]] && return 0
	printf '%s\n' "$W3BS_CATALOG" | grep -qxF -- "$id"
}

# w3bs keeps its state per account, repositories included, and refuses to
# install anything ("no repositories are configured") for an account that has
# none. The W3BS OS images add the official one for their own user on first
# start (pinned to its root fingerprint); every account this script makes
# needs the same. The fingerprint is read, in order, from the OS image, the
# environment, or the official installer -- never typed into this file, where
# it would go stale the day the root key rotates.
W3BS_REPO_URL="${W3BS_REPO_URL:-https://w3bs.org/repo/}"
W3BS_REPO_FINGERPRINT="${W3BS_REPO_FINGERPRINT:-}"
_w3bs_fingerprint() {
	[[ -n "$W3BS_REPO_FINGERPRINT" ]] && { printf '%s' "$W3BS_REPO_FINGERPRINT"; return 0; }
	if [[ -s /usr/share/w3bs-os/FINGERPRINT ]]; then
		W3BS_REPO_FINGERPRINT="$(tr -d '[:space:]' </usr/share/w3bs-os/FINGERPRINT)"
	else
		W3BS_REPO_FINGERPRINT="$(curl -fsSL --max-time 20 "$W3BS_INSTALLER_URL" 2>/dev/null \
			| sed -n "s/^[[:space:]]*REPO_FINGERPRINT='\(sha256:[0-9a-f]*\)'.*/\1/p" | head -1)"
	fi
	[[ "$W3BS_REPO_FINGERPRINT" == sha256:* ]] && { printf '%s' "$W3BS_REPO_FINGERPRINT"; return 0; }
	W3BS_REPO_FINGERPRINT=""
	return 1
}

w3bs_repo_ensure() {
	local login="$1" bin="$2" fp
	as_user "$login" "'$bin' repo info w3bs >/dev/null 2>&1" && return 0
	fp="$(_w3bs_fingerprint)" || { warn "no W3BS repository fingerprint (set W3BS_REPO_FINGERPRINT)"; return 1; }
	as_user "$login" "'$bin' repo add w3bs '$W3BS_REPO_URL' --root-fingerprint '$fp' --yes >/dev/null 2>&1" \
		|| { warn "$login: could not add the W3BS repository"; return 1; }
	note "$login: W3BS repository added ($fp)"
	return 0
}

# Install, or bring up to date, one catalog tool for one account through w3bs.
# Falls back to the publisher's curl installer only when w3bs cannot be used.
#
# Idempotent on both paths: w3bs installs once and `w3bs update` is a no-op on
# a current package, and every curl installer here is "fetch the current
# version and put it in place".
#
# w3bs prints a results table and exits 0 even when one row failed, so the row
# is read, not just the status.
w3bs_tool() {
	local login="$1" id="$2" fallback="$3" bin out rc row
	if [[ "$W3BS_INSTALL" == 1 ]] && bin="$(w3bs_bin)" && w3bs_catalog_has "$id"; then
		w3bs_repo_ensure "$login" "$bin" || true
		if as_user "$login" "'$bin' list 2>/dev/null | awk '{print \$1}' | grep -qxF '$id'"; then
			out="$(as_user "$login" "'$bin' update '$id' --yes --non-interactive 2>&1")"; rc=$?
		else
			out="$(as_user "$login" "'$bin' install '$id' --yes --non-interactive 2>&1")"; rc=$?
		fi
		row="$(printf '%s\n' "$out" | grep -E "^${id}[[:space:]]" | tail -1)"
		[[ -n "$row" ]] && printf '        %s\n' "$row"
		# Three ways to fail, all of which have been seen: a non-zero exit
		# (no repository), a row that says so (the publisher's installer
		# failed, exit still 0), and no row at all.
		if [[ "$rc" != 0 || -z "$row" ]] || grep -qiE 'failed|error' <<<"$row"; then
			warn "$login: w3bs could not install $id: $(printf '%s\n' "${row:-$out}" | tail -1)"
			return 1
		fi
		return 0
	fi
	[[ -n "$fallback" ]] || { warn "$id: not in the w3bs catalog and no fallback installer"; return 1; }
	# threatcrush-disable-next-line sh-remote-script-execution first-party installers, the fallback when w3bs is missing
	as_user "$login" "$fallback"
}

# -------------------------------------------------------- remote shares ---
#
# Mount a share from another box, and keep it mounted across reboots.
#
# The mountpoint is named after where the data actually lives. A remote share
# sitting at a path that reads like local disk is genuinely dangerous: someone
# eventually runs mv or rm -rf against what they believe is a spare local
# volume, and it is in fact the only copy, on another machine, over the wire.
#
#   ubuntu@files.example.com:~/Downloads/done
#     ->  /mnt/tailscale.files.example.com/Downloads/done
#        └ how we reach it ┘└ which box ┘└ the remote path, verbatim ┘
#
# The first label is HOW the box is reached -- "tailscale" for a tailnet peer,
# otherwise the protocol ("nfs" or "sshfs"). Never just the remote username:
# "ubuntu" names an account, not a machine, and there is one on every box.

MNT_ROOT="${MNT_ROOT:-/mnt}"

# doas, the ISO's privilege tool, says who ran it in DOAS_USER where sudo says
# SUDO_USER. Everything below asks the sudo spelling, so fold the two together.
SUDO_USER="${SUDO_USER:-${DOAS_USER:-}}"

# Who a --shared mount is opened to. Not "everyone": every human account on
# these boxes is in `users` (it is one of GROUP_CHOICES above), and daemons are
# not, so the group is already the line between a person and a service.
SHARE_GROUP="${SHARE_GROUP:-users}"

# What a shared directory and the files under it end up as. Directories need the
# execute bit to be traversable at all, and the setgid bit to keep new entries in
# the group -- which is why these are not the same number with a digit moved.
SHARE_DIR_MODE="${SHARE_DIR_MODE:-2775}"
SHARE_FILE_MODE="${SHARE_FILE_MODE:-0664}"

# The account Caddy runs as (Alpine's caddy package: user and group `caddy`).
# Used to let it traverse homes and ~/share; it is deliberately NOT
# $SHARE_GROUP, which is who may write to a mount.
WEB_GROUP="${WEB_GROUP:-caddy}"

# Groups beyond $SHARE_GROUP that also need to WRITE to a share. Comma or space
# separated in the environment; `share --group NAME` adds one for a single run.
#
# A directory has exactly one group, so a second one cannot be said in a mode at
# all -- it takes a POSIX ACL. That has a real cost: `ls -l` then shows a mode
# that is no longer the whole truth, marked only by a trailing `+`, and getfacl
# is the only way to read what is actually granted. So it stays opt-in, and the
# plain mode remains the entire story for every share that does not ask for it.
#
# The case it exists for is a volume that both people and a daemon write to: the
# humans are in `users`, Caddy is caddy, and neither belongs in the other's
# group. Putting caddy in `users` hands the web server every other `users`
# share on the box; putting the humans in caddy is the same trade backwards.
# An ACL on the one directory that needs it grants exactly what was meant.
SHARE_EXTRA_GROUPS="${SHARE_EXTRA_GROUPS:-}"

# The extra groups, one per line, deduplicated, with $SHARE_GROUP itself dropped
# -- it is already the owning group, and an ACL entry restating that is noise
# that whoever reads getfacl later has to work out is redundant.
_extra_share_groups() {
	local raw="${SHARE_EXTRA_GROUPS//,/ }" g seen=" "
	for g in $raw; do
		[[ -n "$g" && "$g" != "$SHARE_GROUP" ]] || continue
		[[ "$seen" == *" $g "* ]] && continue
		seen+="$g "
		printf '%s\n' "$g"
	done
}

# Grant $SHARE_EXTRA_GROUPS on a directory. Two entries per group, not one:
#
#   g:NAME:rwx     what NAME may do to this directory as it stands
#   d:g:NAME:rwx   the default, inherited by whatever is created inside it later
#
# Without the default entry the grant covers the directory and nothing that ever
# lands in it -- the same "the first writer locks everyone else out" failure the
# setgid bit exists to prevent, one level down and invisible in `ls -l`.
#
# setfacl recomputes the mask from the entries it is handed, and the mask caps
# every named entry. Spelling out rwx is what keeps the mask open; a plain
# `chmod g+w` afterwards narrows it again, which is why _share_perms sets the
# mode BEFORE calling this and never the other way round.
_share_acl() {
	local dir="$1" recurse="${2:-0}" grp ok rc=0
	local -a extras=()
	while read -r grp; do [[ -n "$grp" ]] && extras+=("$grp"); done < <(_extra_share_groups)
	[[ ${#extras[@]} -gt 0 ]] || return 0

	if ! command -v setfacl >/dev/null 2>&1; then
		warn "share: setfacl is missing -- '${extras[*]}' not granted on $dir (apk add acl)"
		return 1
	fi

	for grp in "${extras[@]}"; do
		if ! getent group "$grp" >/dev/null; then
			warn "share: no group '$grp' -- not granted on $dir"
			rc=1; continue
		fi
		ok=1
		if [[ "$recurse" == 1 ]]; then
			# rwX with a capital X: execute for directories and for files that
			# already had it, nothing else. A flat rwx here would make every
			# data file on the volume executable, which is the thing the
			# separate $SHARE_FILE_MODE exists to avoid.
			setfacl -R -m "g:$grp:rwX" "$dir" 2>/dev/null || ok=0
			# Default entries are a directory-only concept, so they cannot ride
			# along on the -R above -- it would fail on the first plain file.
			[[ "$ok" == 1 ]] && { find "$dir" -type d -exec setfacl -m "d:g:$grp:rwx" {} + 2>/dev/null || ok=0; }
		else
			setfacl -m "g:$grp:rwx" -m "d:g:$grp:rwx" "$dir" 2>/dev/null || ok=0
		fi
		if [[ "$ok" == 0 ]]; then
			warn "share: could not grant '$grp' on $dir -- is the filesystem mounted with ACL support?"
			rc=1; continue
		fi
		info "also writable by group '$grp' (acl)"
	done
	return "$rc"
}

# Resolve a tailnet peer name, as it appears in `tailscale status`, to its IP.
_tailnet_ip() {
	local peer="$1" ip
	command -v tailscale >/dev/null 2>&1 || return 1
	ip="$(tailscale status 2>/dev/null | awk -v p="$peer" '$2 == p { print $1; exit }')"
	[[ -n "$ip" ]] || return 1
	printf '%s' "$ip"
}

_port_open() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

# "alice and root", or just "root" when that is already who we are.
_owner_desc() {
	local me="${SUDO_USER:-root}"
	[[ "$me" == root ]] && printf 'root' || printf '%s and root' "$me"
}

# Open a directory to one account, or to everyone in $SHARE_GROUP.
#
# A volume the team is meant to share cannot be 0700 owned by whoever happened
# to run the mount -- that is how you get `touch foo` -> Permission denied on a
# 200G disk sitting empty. Shared mode hands the directory to the group instead:
#
#   2775  directories: rwx for owner and group, r-x for everyone else, and
#         setgid so every file and directory created inside inherits
#         $SHARE_GROUP rather than the creator's private group. Without the
#         setgid bit the first person to write locks the next one out, which
#         looks exactly like the bug this is meant to fix.
#   0664  files: rw for owner and group, r for everyone else.
#
# The group is who may WRITE; the world r bit only lets other accounts read.
# That is deliberate -- Caddy serving out of a shared volume is the common case
# and does not justify putting caddy in $SHARE_GROUP. Override with
# SHARE_DIR_MODE / SHARE_FILE_MODE if a volume needs to be group-only (2770 and
# 0660), which is the right call for anything actually sensitive.
#
# setgid fixes the group a new file lands in, not its mode -- the group WRITE
# bit comes from the writer's umask. Ubuntu's default 002 grants it (safe here
# because USERGROUPS_ENAB gives each account its own private group). A user who
# has set umask 022 will still create files their colleagues cannot write.
_share_perms() {
	local dir="$1" shared="$2"
	if [[ "$shared" == 1 ]]; then
		getent group "$SHARE_GROUP" >/dev/null \
			|| die "share: group '$SHARE_GROUP' does not exist (groupadd $SHARE_GROUP, or set SHARE_GROUP=)"
		chgrp "$SHARE_GROUP" "$dir" || warn "could not set group $SHARE_GROUP on $dir"
		chmod "$SHARE_DIR_MODE" "$dir" || warn "could not open $dir to $SHARE_GROUP"
		info "shared: anyone in '$SHARE_GROUP' can read and write $dir"
		# After the chmod, never before: chmod rewrites the ACL mask from the
		# group bits, so an ACL granted first would be capped by it a line later.
		_share_acl "$dir" 0 || true
	else
		chown "${SUDO_USER:-root}" "$dir" 2>/dev/null || true
		# 00700, not 0700: chmod leaves a directory's setgid bit alone unless a
		# numeric mode carries the extra leading zero. Going shared -> private
		# with 0700 lands on 2700 -- harmless while the group has no bits, but
		# it comes back the moment someone loosens them again.
		chmod 00700 "$dir" || warn "could not lock down $dir"
		# An ACL outlives a mode. 00700 says private while a leftover
		# g:caddy:rwx entry still hands the directory to a daemon, and `ls -l`
		# shows the reassuring number rather than the entry. Going private has to
		# take both away.
		command -v setfacl >/dev/null 2>&1 && setfacl -b "$dir" 2>/dev/null || true
		info "private: only $(_owner_desc) can traverse $dir"
	fi
}

# /mnt stays the single source of truth; ~/share/<name> is the short path a
# human actually types. A symlink rather than a second mountpoint, so findmnt
# and `mounts` keep showing exactly one location for the data.
#
# Who can reach a share is decided by one directory: the one above the
# mountpoint in /mnt. Without execute there, no other account can traverse to
# the data, whatever the server says the files are. Putting the mount in $HOME
# would not have given that control on its own; /home/<user> is 0751 on these
# boxes, so every account can already walk through it.
#
# That directory is $SHARE_DIR_MODE root:$SHARE_GROUP by default (_share_perms) --
# these are team boxes and a mount nobody but the person who ran it can write to
# is the common failure, not a safe default. Pass --private for a share that
# genuinely belongs to one account and it goes back to 0700.
#
# The symlink has no say in either case -- a symlink cannot grant what the
# directory withholds. ~/share is a shortcut someone types, not the permission
# boundary, so it must not be what withholds traversal from whoever was
# legitimately pointed at one of these links.
#
# A symlink is resolved by whoever follows it, and the kernel then checks EVERY
# component of the path it expands to. So a 0700 ~/share silently becomes a
# second permission boundary for anything that walks in from outside -- Caddy
# following ~/public_html/done -> ~/share/seed gets EACCES on ~/share and 403s,
# while the /mnt directory that is supposed to be making that call sits there
# world-traversable.
#
# What needs to traverse is one account, so name it: the directory goes to
# $WEB_GROUP with 0710. caddy gets the x bit, other accounts get nothing --
# 0711 would have worked too, but it hands traversal to every process on the box
# to solve a problem only Caddy has. Group execute is the same fix, scoped.
#
# Withholding r keeps it per-user either way: Caddy can walk through to a link
# it was pointed at, but cannot list which shares exist.
#
# No $WEB_GROUP means no web server, so nothing needs to traverse and it stays
# 0700. That is the safe direction to fail -- a --skip-web box is not silently
# opened up.
_share_link() {
	local mp="$1" name="$2" owner="${SUDO_USER:-root}" home grp mode
	home="$(getent passwd "$owner" | cut -d: -f6)"
	[[ -n "$home" && -d "$home" ]] || { warn "no home for $owner -- skipping the ~/share link"; return 0; }
	if getent group "$WEB_GROUP" >/dev/null; then
		grp="$WEB_GROUP" mode=0710
	else
		grp="$owner" mode=0700
		info "no group '$WEB_GROUP' -- $home/share stays private to $owner"
	fi
	# -m and -g re-apply to an existing directory too, so a ~/share left 0700 by
	# an earlier run is repaired by the next mount rather than staying broken.
	install -d -o "$owner" -g "$grp" -m "$mode" "$home/share" || return 0
	ln -sfn "$mp" "$home/share/$name" || return 0
	chown -h "$owner:$owner" "$home/share/$name" 2>/dev/null || true
	info "link: $home/share/$name -> $mp"
}

# ubuntu + ~/Downloads/done -> /home/ubuntu/Downloads/done  (what NFS exports)
_expand_remote() {
	local user="$1" path="$2"
	case "$path" in
		'~/'*) printf '/home/%s/%s' "$user" "${path#\~/}" ;;
		'~')   printf '/home/%s' "$user" ;;
		/*)    printf '%s' "$path" ;;
		*)     printf '/home/%s/%s' "$user" "$path" ;;
	esac
}

mount_usage() {
	cat <<-'EOF'
	Usage:
	  root-w3bs-os.sh mount [user@]host:/remote/path [options]
	  root-w3bs-os.sh umount <mountpoint|host>
	  root-w3bs-os.sh mounts
	  root-w3bs-os.sh share <mountpoint>... [--private] [--group NAME] [-R]

	Mounts a remote share at /mnt/<how>.<host>/<remote/path> and adds an fstab
	entry so it comes back after a reboot. Re-running for the same share just
	rewrites the entry, so it is safe to repeat.

	Shares are shared by default: the directory above the mountpoint becomes
	2775 root:$SHARE_GROUP (default: users), so every human account on the box
	can read and write it. The setgid bit keeps new files in the group, so the
	first writer does not lock everyone else out. Other accounts get read only.
	The short path is linked as ~/share/<name>.

	Modes come from $SHARE_DIR_MODE (2775) and $SHARE_FILE_MODE (0664); set both
	in the environment for a volume that should be group-only (2770 and 0660).

	Pass --private for a share that belongs to one account: that directory goes
	to 0700 instead and nobody else on the box can traverse to the data.

	`share` applies the same thing to a volume that is already mounted -- a
	provider-attached block volume, say, which lands root:root 0755 with its own
	fstab line and was never touched by this script. Add -R to sweep contents
	that are already there.

	Options:
	  --link NAME   name for the ~/share/ symlink (default: first label of the
	                host, e.g. files.example.com -> files)
	  --no-link     do not create the ~/share symlink at all
	  --via PEER    reach the host over this tailnet peer (from `tailscale status`).
	                Use when the DNS name resolves to a public IP but you want the
	                traffic on the tailnet -- the mount is then labelled tailscale.
	  --nfs         force NFS            (default when the host answers on 2049)
	  --sshfs       force sshfs          (default otherwise)
	  --name PATH   override the derived mountpoint entirely
	  --shared      open the share to the $SHARE_GROUP group (2775, setgid) -- the default
	  --private     keep it to one account (0700)
	  --group NAME  let a SECOND group write too, e.g. caddy. A directory has
	                one group, so this is a POSIX ACL (g:NAME:rwx plus the
	                inherited default) rather than a mode -- `ls -l` shows a
	                trailing + and getfacl shows the rest. Repeatable; needs the
	                acl package and a filesystem mounted with ACL support.
	                $SHARE_EXTRA_GROUPS is the same thing from the environment.
	  --ro          mount read-only
	  --no-fstab    mount now, do not persist across reboots
	  --dry-run     print the mountpoint, fstab line and unit, change nothing

	Examples:
	  root-w3bs-os.sh mount ubuntu@files.example.com:~/Downloads/done --via ubuntu
	  root-w3bs-os.sh mount media.example.com:/srv/media --ro
	  root-w3bs-os.sh umount /mnt/tailscale.files.example.com/Downloads/done
	EOF
}

cmd_mount() {
	local spec="" via="" proto="" override="" persist=1 ro=0 dry=0
	local link_name="" want_link=1 shared=1

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--via)      via="${2:-}"; shift ;;
			--nfs)      proto=nfs ;;
			--sshfs)    proto=sshfs ;;
			--name)     override="${2:-}"; shift ;;
			--link)     link_name="${2:-}"; shift ;;
			--no-link)  want_link=0 ;;
			--shared)   shared=1 ;;
			--private)  shared=0 ;;
			--group)    SHARE_EXTRA_GROUPS="${SHARE_EXTRA_GROUPS:+$SHARE_EXTRA_GROUPS,}${2:-}"; shift ;;
			--group=*)  SHARE_EXTRA_GROUPS="${SHARE_EXTRA_GROUPS:+$SHARE_EXTRA_GROUPS,}${1#*=}" ;;
			--ro)       ro=1 ;;
			--no-fstab) persist=0 ;;
			--dry-run)  dry=1 ;;
			-h|--help)  mount_usage; return 0 ;;
			-*)         die "mount: unknown option: $1" ;;
			*)          [[ -z "$spec" ]] && spec="$1" || die "mount: unexpected argument: $1" ;;
		esac
		shift
	done
	[[ -n "$spec" ]] || { mount_usage; return 2; }
	[[ "$spec" == *:* ]] || die "mount: expected [user@]host:/remote/path, got '$spec'"

	local hostpart="${spec%%:*}" rpath="${spec#*:}" user host
	if [[ "$hostpart" == *@* ]]; then
		user="${hostpart%%@*}"; host="${hostpart#*@}"
	else
		user=root; host="$hostpart"
	fi
	[[ -n "$host" && -n "$rpath" ]] || die "mount: could not parse '$spec'"

	local remote; remote="$(_expand_remote "$user" "$rpath")"

	# Where we actually talk to the box, and what we therefore call the mount.
	local target label=""
	if [[ -n "$via" ]]; then
		target="$(_tailnet_ip "$via")" \
			|| die "mount: '$via' is not a peer in 'tailscale status'"
		label=tailscale
		info "routing over the tailnet: $via = $target"
	elif target="$(_tailnet_ip "$host")"; then
		label=tailscale
		info "$host is a tailnet peer ($target)"
	else
		target="$host"
	fi

	# NFS if the box is exporting, sshfs if it is not. Probing beats guessing.
	if [[ -z "$proto" ]]; then
		if _port_open "$target" 2049; then proto=nfs; else proto=sshfs; fi
		info "detected transport: $proto"
	fi
	[[ -n "$label" ]] || label="$proto"

	# The mountpoint mirrors the path as TYPED (~/Downloads/done -> Downloads/done),
	# not the expanded one -- /mnt/...  /home/ubuntu/Downloads/done reads terribly.
	local mpath="${rpath#\~/}"; mpath="${mpath#/}"
	local mp="${override:-$MNT_ROOT/$label.$host/$mpath}"

	local rw=rw; [[ "$ro" == 1 ]] && rw=ro
	# systemd turns these options into an automount unit; OpenRC's netmount
	# service mounts every _netdev line once the network is up, and ignores
	# x-systemd.* (they are not passed to mount(8) there, so they are left out).
	local tsreq="" auto=""
	if [[ "$(detect_init)" == systemd ]]; then
		auto=",x-systemd.automount"
		[[ "$label" == tailscale ]] && tsreq=",x-systemd.requires=tailscaled.service"
	fi

	local src opts fstype
	case "$proto" in
		nfs)
			fstype=nfs
			src="$target:$remote"
			opts="nfsvers=4.1,proto=tcp,$rw,hard,_netdev,nofail$auto$tsreq"
			;;
		sshfs)
			# A dry run must not install anything -- just say it would.
			if ! command -v sshfs >/dev/null 2>&1; then
				if [[ "$dry" == 1 ]]; then
					info "sshfs is not installed; a real run would apk add it"
				else
					log "installing sshfs"
					apk_add sshfs || die "mount: could not install sshfs"
					modprobe fuse 2>/dev/null || true
				fi
			fi
			fstype=fuse.sshfs
			src="$user@$target:$remote"
			# root does the mounting, so it is root's key that has to be authorised
			# on the far side -- not the invoking user's.
			opts="$rw,_netdev,nofail$auto$tsreq,allow_other,reconnect,ServerAliveInterval=15,IdentityFile=/root/.ssh/id_ed25519"
			[[ -r /root/.ssh/id_ed25519 ]] \
				|| warn "no /root/.ssh/id_ed25519 -- ssh-keygen and copy it to $user@$host first"
			;;
		*) die "mount: unknown protocol '$proto'" ;;
	esac

	# files.example.com -> files. Short, and it is the name you already say out loud.
	[[ -n "$link_name" ]] || link_name="${host%%.*}"

	# The gate is the first directory under /mnt, not the mountpoint itself --
	# once NFS is mounted, the mountpoint's own mode comes from the server.
	local rel="${mp#"$MNT_ROOT"/}" share_root
	share_root="$MNT_ROOT/${rel%%/*}"

	if [[ "$dry" == 1 ]]; then
		log "dry run -- nothing was changed"
		info "mountpoint : $mp"
		info "fstab      : $src $mp $fstype $opts 0 0"
		if [[ "$(detect_init)" == systemd ]]; then
			info "unit       : $(systemd-escape -p --suffix=automount "$mp")"
		else
			info "boot       : netmount (rc-update add netmount boot)"
		fi
		if [[ "$shared" == 1 ]]; then
			info "shared     : $share_root becomes $SHARE_DIR_MODE root:$SHARE_GROUP"
		else
			info "private    : $share_root becomes 0700, reachable by $(_owner_desc)"
		fi
		[[ "$want_link" == 1 ]] && info "link       : ~/share/$link_name -> $mp"
		return 0
	fi

	[[ $EUID -eq 0 ]] || die "mount: must run as root (try: sudo $0 mount ...)"

	log "mounting $src -> $mp"
	install -d -m 0755 "$mp" || die "mount: could not create $mp"

	_share_perms "$share_root" "$shared"

	if [[ "$persist" == 1 ]]; then
		cp -a /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d-%H%M%S)"
		# Drop any previous entry for this mountpoint or this source, so a repeat
		# run replaces its own line instead of stacking a second one beside it.
		local tmp; tmp="$(mktemp)"
		awk -v mp="$mp" -v src="$src" '$1 == src || $2 == mp { next } { print }' \
			/etc/fstab >"$tmp" && cat "$tmp" >/etc/fstab
		rm -f "$tmp"
		printf '%s %s %s %s 0 0\n' "$src" "$mp" "$fstype" "$opts" >>/etc/fstab
		if [[ "$(detect_init)" == systemd ]]; then
			systemctl daemon-reload
			local unit; unit="$(systemd-escape -p --suffix=automount "$mp")"
			systemctl start "$unit" 2>/dev/null || true
		else
			# _netdev lines come back at boot through netmount, not localmount.
			svc_enable netmount boot 2>/dev/null || true
		fi
	fi

	mountpoint -q "$mp" || mount "$mp" 2>/dev/null || ls "$mp" >/dev/null 2>&1
	if ! mountpoint -q "$mp"; then
		warn "not mounted yet -- check: mount $mp (and dmesg)"
		return 1
	fi

	info "mounted: $(ls -1 "$mp" 2>/dev/null | wc -l) entries, $(df -h --output=used "$mp" | tail -1 | tr -d ' ') used"
	[[ "$persist" == 1 ]] && info "persisted in /etc/fstab (survives reboot)"
	[[ "$want_link" == 1 ]] && _share_link "$mp" "$link_name"
	return 0
}

cmd_umount() {
	local what="${1:-}"
	[[ -n "$what" ]] || { mount_usage; return 2; }
	[[ $EUID -eq 0 ]] || die "umount: must run as root (try: sudo $0 umount ...)"

	# Accept either the mountpoint itself or the host it came from.
	local mp="$what"
	if [[ ! -d "$mp" ]]; then
		mp="$(awk -v h="$what" -v root="$MNT_ROOT" '$2 ~ ("^" root "/[^/]*\\." h "/") { print $2; exit }' /etc/fstab)"
		[[ -n "$mp" ]] || die "umount: no mount found for '$what'"
	fi

	log "unmounting $mp"
	if [[ "$(detect_init)" == systemd ]]; then
		systemctl stop "$(systemd-escape -p --suffix=automount "$mp")" 2>/dev/null || true
		systemctl stop "$(systemd-escape -p --suffix=mount "$mp")"     2>/dev/null || true
	fi
	umount "$mp" 2>/dev/null || true
	mountpoint -q "$mp" && die "umount: $mp is busy -- something is sitting in it (lsof +D $mp)"

	cp -a /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d-%H%M%S)"
	local tmp; tmp="$(mktemp)"
	awk -v mp="$mp" '$2 == mp { next } { print }' /etc/fstab >"$tmp" && cat "$tmp" >/etc/fstab
	rm -f "$tmp"
	[[ "$(detect_init)" == systemd ]] && systemctl daemon-reload
	rmdir "$mp" 2>/dev/null || true

	# Leave no symlink pointing at a mountpoint that no longer exists.
	local owner="${SUDO_USER:-root}" home l
	home="$(getent passwd "$owner" | cut -d: -f6)"
	if [[ -n "$home" && -d "$home/share" ]]; then
		while IFS= read -r l; do
			[[ "$(readlink "$l")" == "$mp" ]] || continue
			rm -f "$l" && info "removed link $l"
		done < <(find "$home/share" -maxdepth 1 -type l 2>/dev/null)
	fi

	info "unmounted and removed from /etc/fstab"
	return 0
}

cmd_mounts() {
	local found=0
	while read -r src mp fstype _; do
		[[ "$mp" == "$MNT_ROOT"/* ]] || continue
		found=1
		# The gate is the first directory under /mnt, the same one `share` and
		# `mount` set -- reporting the mountpoint's own mode would describe the
		# far side's opinion, not this box's.
		local rel="${mp#"$MNT_ROOT"/}" gate access
		gate="$MNT_ROOT/${rel%%/*}"
		access="$(stat -c '%A %U:%G' "$gate" 2>/dev/null || echo '? ?')"
		if mountpoint -q "$mp"; then
			printf '  %-12s %-52s %-22s %s\n' "$fstype" "$mp" "$access" "$src"
		else
			printf '  %-12s %-52s %-22s %s  (not mounted)\n' "$fstype" "$mp" "$access" "$src"
		fi
	done < <(grep -vE '^\s*(#|$)' /etc/fstab)
	[[ "$found" == 1 ]] || info "no shares configured under $MNT_ROOT"
	return 0
}

# Open (or re-close) a volume that is already mounted.
#
# `mount` only covers shares this script created. A cloud block volume attached
# by the provider arrives root:root 0755 with its own fstab line, and nothing
# here ever touched it -- so it needs the same treatment applied after the fact,
# which is all this does.
cmd_share() {
	local shared=1 recurse=0 paths=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--private)     shared=0 ;;
			--shared)      shared=1 ;;
			# Appends rather than replaces, so --group can be given more than
			# once and still means "these as well", which is the only reading
			# that makes sense for a grant.
			--group)       SHARE_EXTRA_GROUPS="${SHARE_EXTRA_GROUPS:+$SHARE_EXTRA_GROUPS,}${2:-}"; shift ;;
			--group=*)     SHARE_EXTRA_GROUPS="${SHARE_EXTRA_GROUPS:+$SHARE_EXTRA_GROUPS,}${1#*=}" ;;
			-R|--recursive) recurse=1 ;;
			-h|--help)     mount_usage; return 0 ;;
			-*)            die "share: unknown option: $1" ;;
			*)             paths+=("$1") ;;
		esac
		shift
	done
	[[ ${#paths[@]} -gt 0 ]] || { mount_usage; return 2; }
	[[ $EUID -eq 0 ]] || die "share: must run as root (try: $0 share ... as root)"

	local p
	for p in "${paths[@]}"; do
		[[ -d "$p" ]] || { warn "share: $p is not a directory -- skipped"; continue; }
		mountpoint -q "$p" || warn "share: $p is not a mountpoint (setting it anyway)"
		_share_perms "$p" "$shared"

		# Only for a volume that already has data in it. Directories and files get
		# separate modes -- a single -R chmod cannot express "traversable dirs,
		# non-executable files" without the capital-X trick, and $SHARE_FILE_MODE
		# is meant to be an exact mode, not a set of bits to add.
		#
		# Which means a flat $SHARE_FILE_MODE takes the execute bit off scripts
		# and binaries living on the volume. That is the right default for a data
		# share and wrong for one holding anything runnable, so it is said out
		# loud rather than worked around.
		if [[ "$recurse" == 1 ]]; then
			log "applying to existing contents of $p"
			if [[ "$shared" == 1 ]]; then
				local execs
				execs="$(find "$p" -type f -perm -u+x -printf . 2>/dev/null | wc -c)"
				[[ "$execs" -gt 0 ]] \
					&& warn "$execs executable file(s) under $p will lose +x (mode $SHARE_FILE_MODE)"
				chgrp -R "$SHARE_GROUP" "$p" 2>/dev/null || warn "chgrp -R fell short on $p"
				find "$p" -type d -exec chmod "$SHARE_DIR_MODE"  {} + 2>/dev/null || warn "chmod on dirs fell short under $p"
				find "$p" -type f -exec chmod "$SHARE_FILE_MODE" {} + 2>/dev/null || warn "chmod on files fell short under $p"
				# Last, for the same reason as in _share_perms: the two chmods
				# above would each reset the mask on everything they touched.
				_share_acl "$p" 1 || true
			else
				chown -R "${SUDO_USER:-root}" "$p" 2>/dev/null || warn "chown -R fell short on $p"
				chmod -R go-rwx,g-s "$p" 2>/dev/null || warn "chmod -R fell short on $p"
				command -v setfacl >/dev/null 2>&1 && setfacl -R -b "$p" 2>/dev/null || true
			fi
		fi
	done
	return 0
}
# ------------------------------------------------------------- accounts ---
#
# Read and change which groups the humans on this box are in.
#
# A provisioning run already sets groups, but only for the accounts named on
# that run and only ever additively (--groups). There was no way to see what
# everyone is in, and no way at all to take a group back -- so "take alice out
# of docker" meant `gpasswd -d` typed from memory, on a box where getting it
# slightly wrong locks somebody out of root. It is also the wrong shape of tool
# for a one-line change: adding an account to docker should not drag an apk
# upgrade, a Caddy reload and a possible reboot along behind it.
#
# Reading needs no privilege. Every mutation asks for root and is a thin wrapper
# over the shadow-utils command that already does the work, so nothing in here
# carries its own idea of what /etc/group looks like:
#
#   add    gpasswd -a        rm      gpasswd -d
#   set    usermod -G        create  groupadd       delete  groupdel
#
# On `rm` sitting next to `delete`. They are one word apart and one of them is
# destructive, so they are told apart by what their first argument IS rather
# than by the reader being careful: `rm` takes a LOGIN first and dies on
# anything that is not one, `delete` takes GROUP names and dies on anything that
# is not one. `groups rm docker` is "no such user: docker", not a deleted docker
# group, and `groups delete alice` is "no such group: alice". Both directions of
# the mix-up fail before anything is touched.

GROUPS_FORCE=0            # --force: lift the two refusals below
GROUPS_CREATE_MISSING=0   # --create: groupadd a named group that is not there
GROUPS_RC=0               # non-zero if any single operation fell short

# Below this gid a group is the system's, not ours. `users` is 100 and
# `www-data` is 82 on Alpine -- between them they are the whole idea of who may write to a
# shared volume on these boxes, and groupadd cannot put either back on the same
# gid afterwards, so every file left on disk would keep a numeric group with no
# name. Deleting one is almost always a typo for `groups rm`.
GROUPS_SYSTEM_FLOOR="${GROUPS_SYSTEM_FLOOR:-1000}"

# Same rule as a login: groupadd is as fussy as useradd about names, and a group
# with an uppercase letter or a slash in it breaks the same Caddyfile matchers that
# valid_login exists to protect.
valid_group() { [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }

# The primary group is not a supplementary one and must never be handled as if
# it were: usermod -G takes the supplementary list alone, so feeding the primary
# back into it is at best a no-op and at worst hides that it was dropped.
_primary_group() { id -gn "$1" 2>/dev/null; }

# Supplementary groups only, one per line, sorted. An account with none is not
# an error -- the `|| true` is there because grep exits 1 on no match and
# pipefail would otherwise turn "alice is in nothing extra" into a failure.
_supp_groups() {
	local login="$1" primary all
	primary="$(id -gn "$login" 2>/dev/null)" || return 1
	all="$(id -Gn "$login" 2>/dev/null)" || return 1
	{ printf '%s\n' $all | grep -vxF -- "$primary" | sort -u; } || true
}

# "wheel,docker" and "wheel docker" are the same list, because --groups already
# accepts either and a subcommand that mirrors a flag must not be stricter than
# the flag it mirrors.
_split_list() {
	local raw="${*//,/ }" tok
	for tok in $raw; do
		[[ -n "$tok" ]] && printf '%s\n' "$tok"
	done
}

# The one change on this box that cannot be undone from this box.
#
# Take the last account out of the admin group and there is nobody left who can
# put it back: the fix is a console or a rescue image, not another run of this
# script. gpasswd, usermod and groupdel will all do it without a word, so the
# refusal has to live here.
#
# root is not itself in `wheel` and does not need to be, so "no members left" is
# the lockout rather than a false alarm.
#
# Given the member list rather than reading /etc/group, so the decision is a
# pure function and can be tested without a box that has these groups on it.
_orphans_admin() {
	local group="$1" login="$2" members="$3"
	case "$group" in
		sudo|admin|wheel) ;;
		*) return 1 ;;
	esac
	[[ "$members" == "$login" ]]
}

_groups_root() { [[ $EUID -eq 0 ]] || die "groups: $1 must run as root (try: $0 groups $1 ... as root)"; }
_groups_user() { id -u "$1" >/dev/null 2>&1 || die "groups: no such user: $1"; }
_groups_in()   { id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qxF -- "$2"; }

# groupadd on demand, so --create is one rule in one place rather than the same
# three lines repeated in add and set.
_groups_ensure() {
	local g="$1"
	getent group "$g" >/dev/null && return 0
	if [[ "$GROUPS_CREATE_MISSING" != 1 ]]; then
		warn "groups: no group '$g' -- skipped (pass --create to make it)"
		GROUPS_RC=1
		return 1
	fi
	valid_group "$g" || { warn "groups: '$g' is not a valid group name -- skipped"; GROUPS_RC=1; return 1; }
	if groupadd "$g"; then
		note "created group $g"
		return 0
	fi
	warn "groups: could not create group '$g'"
	GROUPS_RC=1
	return 1
}

_groups_list() {
	local -a logins=("$@")
	local login primary supp
	if [[ ${#logins[@]} -eq 0 ]]; then
		load_known_users
		logins=(${KNOWN_USERS[@]+"${KNOWN_USERS[@]}"})
	fi
	if [[ ${#logins[@]} -eq 0 ]]; then
		info "no accounts found"
		return 0
	fi
	# Every name checked before the first row is printed. A misspelling in a
	# list of five otherwise prints four accounts and then dies, which reads as
	# a partial answer rather than a rejected question.
	for login in "${logins[@]}"; do _groups_user "$login"; done
	printf '  %-16s %-16s %s\n' LOGIN PRIMARY GROUPS
	for login in "${logins[@]}"; do
		primary="$(_primary_group "$login")"
		supp="$(_supp_groups "$login" | paste -sd, -)"
		printf '  %-16s %-16s %s\n' "$login" "$primary" "${supp:--}"
	done
}

_groups_add() {
	local login="${1:-}" g
	[[ -n "$login" ]] || { groups_usage; return 2; }
	shift
	_groups_root add
	_groups_user "$login"
	[[ $# -gt 0 ]] || { groups_usage; return 2; }
	while read -r g; do
		[[ -n "$g" ]] || continue
		_groups_ensure "$g" || continue
		if _groups_in "$login" "$g"; then
			info "$login is already in $g"
			continue
		fi
		if gpasswd -a "$login" "$g" >/dev/null 2>&1; then
			note "$login added to $g"
		else
			warn "groups: could not add $login to $g"
			GROUPS_RC=1
		fi
	done < <(_split_list "$@")
	return "$GROUPS_RC"
}

_groups_rm() {
	local login="${1:-}" g primary members
	[[ -n "$login" ]] || { groups_usage; return 2; }
	shift
	_groups_root rm
	# The login is checked BEFORE the arity, so that `groups rm docker` -- the
	# mix-up this verb is named to survive -- answers "no such user: docker"
	# rather than printing usage and leaving the reader to work out which of the
	# two commands they were actually holding.
	_groups_user "$login"
	[[ $# -gt 0 ]] || { groups_usage; return 2; }
	primary="$(_primary_group "$login")"
	while read -r g; do
		[[ -n "$g" ]] || continue
		if ! getent group "$g" >/dev/null; then
			warn "groups: no group '$g' -- skipped"
			GROUPS_RC=1
			continue
		fi
		# gpasswd -d cannot take away a primary group, and says so obscurely.
		# Changing one is `usermod -g`: a different decision, with consequences
		# for every file the account already owns, so it is named rather than
		# quietly done on the way past.
		if [[ "$g" == "$primary" ]]; then
			warn "groups: $g is $login's primary group -- not removed (usermod -g changes that)"
			GROUPS_RC=1
			continue
		fi
		if ! _groups_in "$login" "$g"; then
			info "$login is not in $g"
			continue
		fi
		members="$(getent group "$g" | cut -d: -f4)"
		if _orphans_admin "$g" "$login" "$members" && [[ "$GROUPS_FORCE" != 1 ]]; then
			die "groups: $login is the last member of '$g' -- removing them locks this box out of root (--force if you have another way in)"
		fi
		if gpasswd -d "$login" "$g" >/dev/null 2>&1; then
			note "$login removed from $g"
		else
			warn "groups: could not remove $login from $g"
			GROUPS_RC=1
		fi
	done < <(_split_list "$@")
	return "$GROUPS_RC"
}

# Replace the supplementary set exactly: anything not named is taken away.
#
# One usermod -G call, not a sequence of adds and removes, because the sequence
# has a window in the middle where the account is in neither the old set nor the
# new one -- and anything that reads its groups during that window (a login, a
# daemon restart, another run of this script) gets an answer that was never
# meant to be true.
#
# There is deliberately no way to spell "no groups at all" here. `set` with an
# empty list and `set` with a typo that swallowed the list look identical on the
# command line, and one of them strips an account bare. Use `rm` for that, where
# each group taken away is a word somebody actually typed.
_groups_set() {
	local login="${1:-}" g gone members primary
	[[ -n "$login" ]] || { groups_usage; return 2; }
	shift
	_groups_root set
	_groups_user "$login"
	[[ $# -gt 0 ]] || { groups_usage; return 2; }
	primary="$(_primary_group "$login")"

	local -a want=()
	while read -r g; do
		[[ -n "$g" ]] || continue
		[[ "$g" == "$primary" ]] && continue   # not a supplementary group
		_groups_ensure "$g" || continue
		want+=("$g")
	done < <(_split_list "$@")
	[[ ${#want[@]} -gt 0 ]] || die "groups: set needs at least one group that exists"

	# The lockout guard runs over what would be LOST, not over what was typed:
	# `set` takes a group away by not mentioning it, so the dangerous group is
	# precisely the one absent from the command line.
	while read -r gone; do
		[[ -n "$gone" ]] || continue
		printf '%s\n' "${want[@]}" | grep -qxF -- "$gone" && continue
		members="$(getent group "$gone" | cut -d: -f4)"
		if _orphans_admin "$gone" "$login" "$members" && [[ "$GROUPS_FORCE" != 1 ]]; then
			die "groups: set would drop $login from '$gone', its last member -- that locks this box out of root (--force if you have another way in)"
		fi
	done < <(_supp_groups "$login")

	if usermod -G "$(IFS=,; printf '%s' "${want[*]}")" "$login"; then
		note "$login groups set to ${want[*]}"
	else
		warn "groups: could not set groups for $login"
		GROUPS_RC=1
	fi
	return "$GROUPS_RC"
}

_groups_create() {
	local g
	[[ $# -gt 0 ]] || { groups_usage; return 2; }
	_groups_root create
	while read -r g; do
		[[ -n "$g" ]] || continue
		if getent group "$g" >/dev/null; then
			info "group $g already exists (gid $(getent group "$g" | cut -d: -f3))"
			continue
		fi
		# create IS the request to make it, so --create is implied here and
		# only here; add and set still refuse to invent a group nobody asked for.
		GROUPS_CREATE_MISSING=1 _groups_ensure "$g" || true
	done < <(_split_list "$@")
	return "$GROUPS_RC"
}

# groupdel already refuses a group that is somebody's PRIMARY group, which is
# the accident that would break logins outright. The two it does not refuse are
# guarded here: a system group (see $GROUPS_SYSTEM_FLOOR) and an admin group
# that still has members (see _orphans_admin).
_groups_delete() {
	local g gid members
	[[ $# -gt 0 ]] || { groups_usage; return 2; }
	_groups_root delete
	while read -r g; do
		[[ -n "$g" ]] || continue
		if ! getent group "$g" >/dev/null; then
			warn "groups: no such group: $g -- skipped (did you mean: groups rm <user> $g ?)"
			GROUPS_RC=1
			continue
		fi
		gid="$(getent group "$g" | cut -d: -f3)"
		if [[ "$gid" -lt "$GROUPS_SYSTEM_FLOOR" && "$GROUPS_FORCE" != 1 ]]; then
			warn "groups: '$g' is a system group (gid $gid) -- refusing (--force to insist)"
			GROUPS_RC=1
			continue
		fi
		members="$(getent group "$g" | cut -d: -f4)"
		case "$g" in
			sudo|admin|wheel)
				if [[ -n "$members" && "$GROUPS_FORCE" != 1 ]]; then
					warn "groups: '$g' still has members ($members) -- refusing (--force to insist)"
					GROUPS_RC=1
					continue
				fi
				;;
		esac
		if groupdel "$g"; then
			note "deleted group $g"
		else
			warn "groups: could not delete $g"
			GROUPS_RC=1
		fi
	done < <(_split_list "$@")
	return "$GROUPS_RC"
}

_groups_members() {
	local g gid line l ugid
	[[ $# -gt 0 ]] || { groups_usage; return 2; }
	while read -r g; do
		[[ -n "$g" ]] || continue
		if ! line="$(getent group "$g")"; then
			warn "groups: no such group: $g"
			GROUPS_RC=1
			continue
		fi
		gid="$(printf '%s' "$line" | cut -d: -f3)"
		local -a members=()
		while read -r l; do [[ -n "$l" ]] && members+=("$l"); done \
			< <(printf '%s' "$line" | cut -d: -f4 | tr ',' '\n')
		# /etc/group's member field holds the SUPPLEMENTARY members only. Anyone
		# whose primary group this is does not appear in it at all -- printed
		# verbatim, `www-data` would list every human on the box and not the
		# www-data account, which is the one member that matters for a share
		# a web server has to write to.
		while IFS=: read -r l _ _ ugid _; do
			[[ "$ugid" == "$gid" ]] || continue
			printf '%s\n' "${members[@]+"${members[@]}"}" | grep -qxF -- "$l" && continue
			members+=("$l (primary)")
		done < <(getent passwd)
		printf '  %-16s gid %-8s %s\n' "$g" "$gid" "${members[*]:--}"
	done < <(_split_list "$@")
	return "$GROUPS_RC"
}

groups_usage() {
	cat <<-'EOF'
	Usage:
	  root-w3bs-os.sh groups                           every account, and its groups
	  root-w3bs-os.sh groups [list] <user>...          just these accounts
	  root-w3bs-os.sh groups add     <user> <group>... put a user in groups
	  root-w3bs-os.sh groups rm      <user> <group>... take a user out of groups
	  root-w3bs-os.sh groups set     <user> <group>... exactly these, drop the rest
	  root-w3bs-os.sh groups create  <group>...        make a group
	  root-w3bs-os.sh groups delete  <group>...        remove a group
	  root-w3bs-os.sh groups members <group>...        who is in a group

	Group lists take commas or spaces: 'docker,caddy' and 'docker caddy'
	are the same thing, as they are for --groups.

	Listing is unprivileged. Everything that changes something needs root.

	add/rm/set take a LOGIN first and refuse anything that is not one.
	create/delete/members take GROUP names and refuse anything that is not one.
	So `groups rm docker` is an error, not a deleted docker group.

	set replaces the supplementary groups outright -- a group left off the line
	is a group taken away. The primary group is never touched by any of these;
	usermod -g is how that changes.

	Two refusals, both liftable with --force: taking the last member out of
	sudo/admin/wheel, which locks this box out of root with no way back in from
	the box itself, and deleting a group below gid 1000 ($GROUPS_SYSTEM_FLOOR),
	which is the system's and cannot be recreated on the same gid.

	Options:
	  --create   groupadd a named group that does not exist yet (add, set)
	  --force    lift the two refusals above
	  -h|--help  this

	Examples:
	  root-w3bs-os.sh groups
	  root-w3bs-os.sh groups alice
	  root-w3bs-os.sh groups add alice docker,caddy        # as root
	  root-w3bs-os.sh groups rm alice docker               # as root
	  root-w3bs-os.sh groups set alice wheel,users         # as root
	  root-w3bs-os.sh groups members caddy
	EOF
}

cmd_groups() {
	local verb=""
	local -a rest=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			-h|--help) groups_usage; return 0 ;;
			--force)   GROUPS_FORCE=1 ;;
			--create)  GROUPS_CREATE_MISSING=1 ;;
			-*)        die "groups: unknown option: $1  (try: $0 groups --help)" ;;
			*)         rest+=("$1") ;;
		esac
		shift
	done

	# A verb is only a verb in first position, and only if it is one of these.
	# An account genuinely called `add` would otherwise be unreachable, which is
	# what the explicit `list` verb is for: `groups list add` still names it.
	if [[ ${#rest[@]} -gt 0 ]]; then
		case "${rest[0]}" in
			list|add|rm|set|create|delete|members)
				verb="${rest[0]}"
				rest=("${rest[@]:1}")
				;;
		esac
	fi

	case "${verb:-list}" in
		list)    _groups_list    ${rest[@]+"${rest[@]}"} ;;
		add)     _groups_add     ${rest[@]+"${rest[@]}"} ;;
		rm)      _groups_rm      ${rest[@]+"${rest[@]}"} ;;
		set)     _groups_set     ${rest[@]+"${rest[@]}"} ;;
		create)  _groups_create  ${rest[@]+"${rest[@]}"} ;;
		delete)  _groups_delete  ${rest[@]+"${rest[@]}"} ;;
		members) _groups_members ${rest[@]+"${rest[@]}"} ;;
	esac
}
# --------------------------------------------------------- user confine ---
#
# Confine every account that is not an admin. See the tier model up at the
# CONFINE knobs; this is what each tier actually costs the tenant.
#
# The threat is not a stranger -- it is the account we just created. Someone
# with a shell on a shared box, or the customer of a VPS we sold, who should be
# able to do their own work and nothing else. Five things they could do before:
#
#   1. read other people's homes. A home is 0750 and this script chmod o+x'd
#      it, so ~/.config was walkable and anything world-readable in there --
#      session tokens, api keys people leave in dotfiles -- was readable by
#      every account on the box. This is the one that has actually leaked.
#   2. watch other people work. /proc is world-readable, so `ps -ef` hands over
#      every command line on the machine, and command lines carry tokens.
#   3. take the box down. No per-account memory or task cap, so one runaway
#      build or fork bomb is everybody's outage. earlyoom (above) picks up the
#      pieces; this stops the pieces.
#   4. relay through us. ssh -R turns the box into an open proxy under our IP,
#      which is how a dev box ends up on a blocklist.
#   5. read the kernel back. kptr/dmesg/perf leak the addresses and traces that
#      turn a local bug into a local root.
#
# What it deliberately does NOT do is take wheel away from an account that
# already has it. Demoting a live admin unattended is how you lose a box --
# maybe it is a colleague, maybe it is the only other admin, maybe it is the
# account your own automation logs in as. `confine status` names them and
# `groups rm <user> wheel` demotes them, both with a human present.

_confine_on() { [[ "$CONFINE" == 1 ]]; }

# Is this account exempt -- root, or an admin? The safe direction on every
# unknown is "no": an account we cannot classify is confined, not let out.
_confine_exempt() {
	local login="$1" g uid
	uid="$(id -u "$login" 2>/dev/null)" || return 1
	[[ "$uid" == 0 ]] && return 0
	for g in ${CONFINE_EXEMPT_GROUPS//,/ }; do
		[[ -n "${g// }" ]] || continue
		_groups_in "$login" "$g" && return 0
	done
	return 1
}

# Every human account on the box. Not $KNOWN_USERS: an account this script
# never created still shares the machine, and confinement with a hole in it the
# shape of the cloud image's default user is not confinement.
_confine_humans() {
	getent passwd | awk -F: -v floor="${GROUPS_SYSTEM_FLOOR:-1000}" \
		'$3 >= floor && $3 < 65534 && $7 !~ /(nologin|\/false|sync)$/ { print $1 }'
}

_confine_group_ensure() {
	local g="$1"
	getent group "$g" >/dev/null && return 0
	valid_group "$g" || { warn "confine: '$g' is not a valid group name"; return 1; }
	groupadd "$g" >/dev/null 2>&1 || { warn "confine: could not create group $g"; return 1; }
	note "created group $g"
	return 0
}

# Recompute who is in which tier. Convergent in both directions: a promotion
# takes someone out of the confined group on the next run, a demotion puts them
# back, and neither needs the flag that was passed when the account was made.
sync_confine_membership() {
	local login rc=0
	_confine_group_ensure "$CONFINE_GROUP" || return 1
	if [[ "$CONFINE_HIDEPID" == 1 ]]; then
		_confine_group_ensure "$CONFINE_PROC_GROUP" || rc=1
	fi

	while read -r login; do
		[[ -n "$login" ]] || continue
		if _confine_exempt "$login"; then
			if _groups_in "$login" "$CONFINE_GROUP"; then
				gpasswd -d "$login" "$CONFINE_GROUP" >/dev/null 2>&1 \
					&& note "confine: $login is an admin -- released from $CONFINE_GROUP"
			fi
			if [[ "$CONFINE_HIDEPID" == 1 ]] && getent group "$CONFINE_PROC_GROUP" >/dev/null \
				&& ! _groups_in "$login" "$CONFINE_PROC_GROUP"; then
				usermod -aG "$CONFINE_PROC_GROUP" "$login" \
					&& note "confine: $login -> $CONFINE_PROC_GROUP (keeps seeing every process)"
			fi
		else
			if ! _groups_in "$login" "$CONFINE_GROUP"; then
				usermod -aG "$CONFINE_GROUP" "$login" \
					&& note "confine: confined $login" \
					|| { warn "confine: could not confine $login"; rc=1; }
			fi
		fi
	done < <(_confine_humans)
	return $rc
}

# Emit "key = value", but only when the running kernel is BELOW it.
#
# Every key here is "higher is stricter", and distributions already ship some
# of them stricter than the floor we ask for (Ubuntu sets
# kernel.perf_event_paranoid=4 against our 3, and a kernel may well set
# kernel.unprivileged_bpf_disabled=2 against our 1). Writing the file
# unconditionally would therefore LOOSEN the box in the name of hardening it. So each line is a
# floor rather than a setting, and a key the kernel does not have at all
# (yama on a kernel built without it) is skipped rather than guessed at.
_confine_sysctl_floor() {
	# "floor", not "want": `want` is an array elsewhere in this file, and the
	# linter does not scope locals, so that name costs two false SC2178/SC2128
	# warnings on a string that is only ever a number. (A comment cannot open
	# with the linter's own name either -- that is read as a directive.)
	local key="$1" floor="$2" have
	have="$(sysctl -n "$key" 2>/dev/null)" || return 1
	[[ "$have" =~ ^-?[0-9]+$ ]] || return 1
	# At the floor BECAUSE of our own file is not "already at the floor": the
	# line stays, or the second run would delete the file the first one wrote
	# and the box would boot without the hardening. (root-ubuntu.sh has this
	# flip-flop; measured here on the second of two runs.)
	if (( have == floor )) && grep -qxF "$key = $floor" "$CONFINE_SYSCTL_CONF" 2>/dev/null; then
		printf '%s = %s\n' "$key" "$floor"
		return 0
	fi
	(( have >= floor )) && return 1
	printf '%s = %s\n' "$key" "$floor"
	return 0
}

CONFINE_SYSCTL_CONF=/etc/sysctl.d/62-profullstack-confine.conf
configure_confine_sysctl() {
	local conf="$CONFINE_SYSCTL_CONF" body="" dumpable

	if [[ "$CONFINE_SYSCTL" != 1 ]]; then
		info "confine: sysctl hardening off (CONFINE_SYSCTL=0)"
		return 0
	fi
	# A container's kernel is the host's. In a privileged one these writes
	# land on the host (measured), which is not this script's box to harden.
	if _in_container; then
		info "confine: inside a container -- kernel sysctls are the host's, skipping"
		return 0
	fi

	# kptr/dmesg/perf: stop handing out the kernel addresses and traces that
	# turn a local bug into local root. ptrace_scope 1 keeps a debugger working
	# on your own children while stopping it from attaching to anything else.
	# protected_*: the /tmp symlink and hardlink games, which only matter on a
	# box where someone else is also writing to /tmp. suid_dumpable 0: a core
	# from a setuid binary is a memory image nobody should be handed.
	body+="$(_confine_sysctl_floor kernel.kptr_restrict 2)"$'\n'
	body+="$(_confine_sysctl_floor kernel.dmesg_restrict 1)"$'\n'
	body+="$(_confine_sysctl_floor kernel.perf_event_paranoid 3)"$'\n'
	body+="$(_confine_sysctl_floor kernel.yama.ptrace_scope 1)"$'\n'
	body+="$(_confine_sysctl_floor kernel.unprivileged_bpf_disabled 1)"$'\n'
	body+="$(_confine_sysctl_floor net.core.bpf_jit_harden 2)"$'\n'
	body+="$(_confine_sysctl_floor fs.protected_symlinks 1)"$'\n'
	body+="$(_confine_sysctl_floor fs.protected_hardlinks 1)"$'\n'
	body+="$(_confine_sysctl_floor fs.protected_fifos 2)"$'\n'
	body+="$(_confine_sysctl_floor fs.protected_regular 2)"$'\n'

	# fs.suid_dumpable is the one key here that does NOT run in one direction,
	# so it cannot be a floor: 0 (never dump) is safest, 2 (dump, readable only
	# by root) is safe, and 1 -- dump like any other process, into a file the
	# account can read back -- is the dangerous one in the middle. Ordering
	# them numerically and taking the larger, which is what a floor does, would
	# have left a box sitting on 2 alone and called it hardened. It is an exact
	# value instead, and 0 can never be a loosening of anything.
	dumpable="$(sysctl -n fs.suid_dumpable 2>/dev/null)"
	if [[ "$dumpable" =~ ^[0-9]+$ && "$dumpable" != 0 ]] \
		|| { [[ "$dumpable" == 0 ]] && grep -qxF 'fs.suid_dumpable = 0' "$conf" 2>/dev/null; }; then
		body+='fs.suid_dumpable = 0'$'\n'
	fi

	body="$(printf '%s' "$body" | grep -v '^$')"

	if [[ -z "$body" ]]; then
		# Nothing to raise. Leave no file behind claiming otherwise.
		if [[ -f "$conf" ]]; then
			rm -f "$conf" && note "confine: kernel already at or above every floor -- removed $conf"
		else
			info "confine: kernel already at or above every hardening floor"
		fi
		return 0
	fi

	if write_if_changed "$conf" 0644 <<EOF
# Written by root-w3bs-os.sh -- floors for a box with tenants on it.
# Only keys whose running value was BELOW the floor appear here; anything the
# kernel already sets stricter is left alone rather than written back down.
$body
EOF
	then
		sysctl -q -p "$conf" 2>/dev/null || true
		note "confine: kernel hardening ($(printf '%s' "$body" | wc -l) floor(s) raised)"
	fi
	return 0
}

# /proc mounted hidepid, so an account sees its own processes and nothing else.
#
# Order matters and is the whole difficulty. The live remount is attempted
# FIRST and /etc/fstab is only written once it has actually worked: a kernel
# that rejects the option would otherwise fail the mount at boot, and finding
# that out at boot is finding it out in the worst place. hidepid=invisible is
# the modern spelling; older kernels want the numeric 2, so both are tried.
#
# root is not affected by any of this -- it sees everything regardless, which
# is why earlyoom (running as root) can still find the hog to kill.
configure_confine_proc() {
	local gid opts="" want spelling ok=0

	[[ "$CONFINE_HIDEPID" == 1 ]] || { info "confine: hidepid off (CONFINE_HIDEPID=0)"; return 0; }

	# A container is handed its /proc by the runtime and cannot remount it.
	if _in_container; then
		info "confine: inside a container -- /proc is the runtime's to mount, skipping hidepid"
		return 0
	fi

	getent group "$CONFINE_PROC_GROUP" >/dev/null || _confine_group_ensure "$CONFINE_PROC_GROUP" || return 1
	gid="$(getent group "$CONFINE_PROC_GROUP" | cut -d: -f3)"
	[[ -n "$gid" ]] || { warn "confine: no gid for group $CONFINE_PROC_GROUP"; return 1; }

	# The units that read other people's /proc as a non-root user, before the
	# mount that would blind them rather than after.
	_confine_proc_units "$gid"

	for spelling in invisible 2; do
		want="hidepid=$spelling,gid=$gid"
		if mount -o "remount,$want" /proc 2>/dev/null \
			&& grep -q ' /proc ' /proc/mounts && grep ' /proc ' /proc/mounts | grep -q hidepid; then
			opts="rw,nosuid,nodev,noexec,relatime,$want"
			ok=1
			break
		fi
	done

	if [[ "$ok" != 1 ]]; then
		warn "confine: this kernel would not remount /proc with hidepid -- processes stay visible"
		return 1
	fi

	if _confine_fstab_proc "$opts" "$gid"; then
		note "confine: /proc hidepid -- an account sees only its own processes"
	else
		info "confine: /proc already hidepid ($opts)"
	fi
	return 0
}

# SupplementaryGroups for the units that would otherwise go blind. Written per
# unit, and only for units this box actually has.
_confine_proc_units() {
	local u dir
	# Only systemd units can be handed a supplementary group this way. On
	# OpenRC nothing that ships with a W3BS OS server reads other people's
	# /proc as a non-root user (polkit is a desktop concern).
	[[ "$(detect_init)" == systemd ]] || return 0
	for u in ${CONFINE_PROC_UNITS//,/ }; do
		[[ -n "${u// }" ]] || continue
		systemctl list-unit-files "$u" >/dev/null 2>&1 || continue
		[[ -n "$(systemctl list-unit-files --no-legend "$u" 2>/dev/null)" ]] || continue
		dir="/etc/systemd/system/$u.d"
		install -d -m 0755 "$dir"
		if write_if_changed "$dir/50-profullstack-confine.conf" 0644 <<EOF
# /proc is mounted hidepid: this unit runs as a non-root user and reads
# /proc/<pid> of processes belonging to other people, so it needs the group
# that is still allowed to see them.
[Service]
SupplementaryGroups=$CONFINE_PROC_GROUP
EOF
		then
			systemctl daemon-reload 2>/dev/null || true
			systemctl try-restart "$u" 2>/dev/null || true
			note "confine: $u keeps /proc visibility"
		fi
	done
	return 0
}

# Rewrite the /proc line in /etc/fstab. Our own comment lines carry a marker so
# that they are stripped and re-added rather than accumulating a fresh pair on
# every single run.
_confine_fstab_proc() {
	local opts="$1" gid="$2" tmp
	tmp="$(mktemp)" || return 1
	grep -vE '^#root-w3bs-os:proc|^#root-ubuntu:proc|^[^#]*[[:space:]]/proc[[:space:]]' /etc/fstab >"$tmp" 2>/dev/null
	{
		printf '#root-w3bs-os:proc hidepid -- an account sees only its own processes.\n'
		printf '#root-w3bs-os:proc gid %s is the "%s" group; its members still see them all.\n' \
			"$gid" "$CONFINE_PROC_GROUP"
		printf 'proc /proc proc %s 0 0\n' "$opts"
	} >>"$tmp"
	if cmp -s "$tmp" /etc/fstab; then
		rm -f "$tmp"
		return 1
	fi
	install -m 0644 "$tmp" /etc/fstab
	rm -f "$tmp"
	return 0
}

# Resource caps, in two places because they catch two different things.
#
# PAM limits bite at login: nproc stops a fork bomb in the fork, before there
# is anything for a cgroup to account. A cgroup bites afterwards, and is the
# only one of the two that can cap memory.
#
# Under systemd the cgroup is the per-user slice, exactly as on Ubuntu. Under
# OpenRC there is no user slice -- logins live in sshd's own cgroup with
# everyone else's -- so each confined account gets a group of its own under
# $CONFINE_CGROUP_ROOT and its processes are moved in (see _confine_cgroup).
#
# Then both are LIFTED for root and for every admin: under systemd by an
# explicit per-uid drop-in, under OpenRC by never moving them at all. That is
# the point of the exercise: the account you fix the box with must not be
# subject to the cap that is wedging it.
configure_confine_limits() {
	install -d -m 0755 /etc/security/limits.d
	if write_if_changed /etc/security/limits.d/60-profullstack-confine.conf 0644 <<EOF
# Written by root-w3bs-os.sh. Applies to @$CONFINE_GROUP only -- root and
# admins are not in that group and so are not named here at all.
@$CONFINE_GROUP  soft  nproc      $CONFINE_NPROC
@$CONFINE_GROUP  hard  nproc      $CONFINE_NPROC
@$CONFINE_GROUP  soft  nofile     $CONFINE_NOFILE
@$CONFINE_GROUP  hard  nofile     $CONFINE_NOFILE
@$CONFINE_GROUP  hard  maxlogins  $CONFINE_MAXLOGINS
# A core dump is a memory image, written where the account can read it back.
@$CONFINE_GROUP  hard  core       0
EOF
	then
		note "confine: pam limits for @$CONFINE_GROUP (nproc=$CONFINE_NPROC, nofile=$CONFINE_NOFILE)"
	fi
	_confine_pam || true

	if [[ "$(detect_init)" == systemd ]]; then
		_confine_limits_systemd
	else
		_confine_cgroup
	fi
	return 0
}

# Does sshd run PAM? Alpine's default openssh-server is built without it, and
# then /etc/security/limits.d is a file nobody reads. Asked of sshd itself.
_sshd_uses_pam() {
	local t
	command -v sshd >/dev/null 2>&1 || return 1
	t="$(sshd -T 2>/dev/null)"
	if [[ -n "$t" ]]; then
		grep -qi '^usepam yes' <<<"$t"
		return
	fi
	# sshd -T needs root; an unprivileged `confine status` reads the files
	grep -qiE '^[[:space:]]*UsePAM[[:space:]]+yes' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null
}

# Where sshd has PAM: make sure its session stack reads the limits and runs
# the cgroup hook. /etc/pam.d/sshd is not ours, so only missing lines are
# appended (marked), never a rewrite -- and both are `optional`, so a module
# that is not there cannot stop anyone logging in.
_confine_pam() {
	local f=/etc/pam.d/sshd
	_sshd_uses_pam || return 1
	[[ -f "$f" ]] || return 1
	if ! grep -qE '^[[:space:]]*session[[:space:]].*pam_limits\.so' "$f"; then
		printf 'session    optional   pam_limits.so   # root-w3bs-os.sh: confine\n' >>"$f"
		note "confine: pam_limits in $f"
	fi
	if [[ "$CONFINE_CGROUP" == 1 ]] && ! grep -q 'w3bs-confine-cgroup' "$f"; then
		printf 'session    optional   pam_exec.so quiet /usr/local/sbin/w3bs-confine-cgroup --pam   # root-w3bs-os.sh: confine\n' >>"$f"
		note "confine: cgroup hook in $f"
	fi
	return 0
}

# Percent of RAM -> bytes, for a cgroup file that only takes absolute values.
# Anything else (4G, max, a byte count) is already what memory.max accepts.
_mem_value() {
	local v="$1" kb
	if [[ "$v" =~ ^([0-9]+)%$ ]]; then
		kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
		[[ -n "$kb" ]] || { printf 'max'; return; }
		printf '%s' "$(( kb * 1024 * BASH_REMATCH[1] / 100 ))"
	else
		printf '%s' "$v"
	fi
}

# The OpenRC side of the caps. One small root script does the work, run two
# ways: by pam_exec at session open where sshd has PAM (so a login starts
# inside its cap), and every minute by crond regardless (so nothing that got
# in some other way -- su, a cron job of their own, a sshd without PAM --
# stays out for long). The sweep is the guarantee; the hook closes the window.
_confine_cgroup() {
	local script=/usr/local/sbin/w3bs-confine-cgroup

	if [[ "$CONFINE_CGROUP" != 1 ]]; then
		info "confine: per-account cgroups off (CONFINE_CGROUP=0)"
		_crontab_drop w3bs-confine-cgroup
		return 0
	fi
	if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
		warn "confine: no cgroup v2 hierarchy at /sys/fs/cgroup -- memory/task caps NOT applied (rc_cgroup_mode=\"unified\" in /etc/rc.conf)"
		return 1
	fi

	install -d -m 0755 /usr/local/sbin
	write_if_changed "$script" 0755 <<EOF && note "confine: cgroup sweeper ($script)"
#!/bin/sh
# Generated by cli-tools/root-w3bs-os.sh -- edits here are overwritten.
#
# Keep every process of a confined account inside its own cgroup v2 group,
# $CONFINE_CGROUP_ROOT/<login>, with its caps on it. Admins and root are never
# in @$CONFINE_GROUP, so they are never moved.
#
#   $script            sweep every confined account (crond, each minute)
#   $script --pam      the session pam_exec is opening (PAM_USER)
root='$CONFINE_CGROUP_ROOT'
group='$CONFINE_GROUP'
mem_high='$(_mem_value "$CONFINE_MEMORY_HIGH")'
mem_max='$(_mem_value "$CONFINE_MEMORY_MAX")'
pids_max='$CONFINE_TASKS_MAX'
cpu_weight='$CONFINE_CPU_WEIGHT'

[ -f /sys/fs/cgroup/cgroup.controllers ] || exit 0
mkdir -p "\$root" 2>/dev/null || exit 0
# Controllers have to be switched on at each level on the way down. A level
# that refuses (a container's namespace root with processes in it) leaves the
# caps unenforced, and the next run tries again.
for c in memory pids cpu; do
	grep -qw "\$c" /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null \\
		|| echo "+\$c" >/sys/fs/cgroup/cgroup.subtree_control 2>/dev/null
	grep -qw "\$c" "\$root/cgroup.subtree_control" 2>/dev/null \\
		|| echo "+\$c" >"\$root/cgroup.subtree_control" 2>/dev/null
done

ensure() {
	d="\$root/\$1"
	mkdir -p "\$d" 2>/dev/null || return 1
	[ -w "\$d/memory.max" ] && { echo "\$mem_high" >"\$d/memory.high"; echo "\$mem_max" >"\$d/memory.max"; } 2>/dev/null
	[ -w "\$d/pids.max" ] && echo "\$pids_max" >"\$d/pids.max" 2>/dev/null
	[ -w "\$d/cpu.weight" ] && echo "\$cpu_weight" >"\$d/cpu.weight" 2>/dev/null
	return 0
}

move() {
	# \$1 login, \$2 pid
	case "\$(cat "/proc/\$2/cgroup" 2>/dev/null)" in
		*"/\${root##*/}/\$1") return 0 ;;
	esac
	echo "\$2" >"\$root/\$1/cgroup.procs" 2>/dev/null
}

members="\$(getent group "\$group" | cut -d: -f4 | tr ',' ' ')"

if [ "\${1:-}" = --pam ]; then
	[ "\${PAM_TYPE:-open_session}" = open_session ] || exit 0
	u="\${PAM_USER:-}"
	case " \$members " in *" \$u "*) ;; *) exit 0 ;; esac
	ensure "\$u" && move "\$u" "\$PPID"
	exit 0
fi

for u in \$members; do
	[ -n "\$u" ] || continue
	ensure "\$u" || continue
	for pid in \$(pgrep -U "\$u" 2>/dev/null); do move "\$u" "\$pid"; done
done
# an account that has left the group (promoted, deleted) loses its group
for d in "\$root"/*/; do
	[ -d "\$d" ] || continue
	u="\$(basename "\$d")"
	case " \$members " in *" \$u "*) continue ;; esac
	# rmdir refuses a cgroup that still has processes in it, which is the check
	rmdir "\$d" 2>/dev/null
done
exit 0
EOF

	_crontab_ensure w3bs-confine-cgroup "* * * * * $script >/dev/null 2>&1"
	svc_enable crond 2>/dev/null
	svc_start crond 2>/dev/null || true

	"$script" || true
	if [[ -n "$(cat "$CONFINE_CGROUP_ROOT/cgroup.subtree_control" 2>/dev/null)" ]]; then
		info "confine: cgroup caps live under $CONFINE_CGROUP_ROOT (memory.max=$CONFINE_MEMORY_MAX, pids.max=$CONFINE_TASKS_MAX)"
	else
		warn "confine: the kernel would not delegate memory/pids to $CONFINE_CGROUP_ROOT -- caps NOT enforced here (container?)"
		return 1
	fi
	return 0
}

# One line of root's crontab, owned by a marker comment so a re-run replaces it
# rather than stacking a second copy. busybox crond reads /etc/crontabs/root.
_crontab_file() {
	if [[ -d /etc/crontabs ]]; then printf '/etc/crontabs/root'
	else printf '/var/spool/cron/crontabs/root'; fi
}

_crontab_ensure() {
	local tag="$1" line="$2" f tmp
	f="$(_crontab_file)"
	install -d -m 0755 "$(dirname "$f")"
	touch "$f"
	# Already there, verbatim: nothing to do. (Re-appending would move it to
	# the end, and with two tags each run would swap them -- a "change" every
	# run on a box that has not changed.)
	grep -qxF "$line # root-w3bs-os:$tag" "$f" && return 1
	tmp="$(mktemp)" || return 1
	{ grep -v "# root-w3bs-os:$tag\$" "$f"; printf '%s # root-w3bs-os:%s\n' "$line" "$tag"; } >"$tmp"
	if cmp -s "$tmp" "$f"; then rm -f "$tmp"; return 1; fi
	install -m 0600 "$tmp" "$f"; rm -f "$tmp"
	note "cron: $tag"
	return 0
}

_crontab_drop() {
	local tag="$1" f tmp
	f="$(_crontab_file)"
	[[ -f "$f" ]] && grep -q "# root-w3bs-os:$tag\$" "$f" || return 0
	tmp="$(mktemp)" || return 1
	grep -v "# root-w3bs-os:$tag\$" "$f" >"$tmp"
	install -m 0600 "$tmp" "$f"; rm -f "$tmp"
	note "cron: removed $tag"
}

# The systemd side, unchanged from root-ubuntu.sh: a prefix drop-in on every
# user slice, lifted again per admin uid.
_confine_limits_systemd() {
	local dir=/etc/systemd/system/user-.slice.d changed=0 quota=""

	if [[ -n "$CONFINE_CPU_QUOTA" ]]; then
		quota="CPUQuota=$CONFINE_CPU_QUOTA"
	else
		quota="# CPUQuota: deliberately unset -- see above. CONFINE_CPU_QUOTA sets it."
	fi

	# user-.slice.d is systemd's prefix drop-in: it applies to user-1000.slice,
	# user-1001.slice and every other instance -- including user-0.slice, which
	# is root's, which is why the exemption below is not optional.
	install -d -m 0755 "$dir"
	if write_if_changed "$dir/50-profullstack-confine.conf" 0644 <<EOF
# Written by root-w3bs-os.sh. Per-account resource caps.
#
# Memory and tasks are hard ceilings: their failure mode is the whole box
# going down with one account. CPU is a weight, not a quota -- it only bites
# under contention, so a build gets the whole machine when the machine is idle
# and a fair share when it is not. Set CONFINE_CPU_QUOTA for a real ceiling.
[Slice]
MemoryAccounting=yes
MemoryHigh=$CONFINE_MEMORY_HIGH
MemoryMax=$CONFINE_MEMORY_MAX
TasksAccounting=yes
TasksMax=$CONFINE_TASKS_MAX
CPUAccounting=yes
CPUWeight=$CONFINE_CPU_WEIGHT
IOAccounting=yes
IOWeight=100
$quota
EOF
	then
		changed=1
		note "confine: slice caps (MemoryMax=$CONFINE_MEMORY_MAX, TasksMax=$CONFINE_TASKS_MAX)"
	fi

	_confine_slice_exemptions && changed=1
	[[ "$changed" == 1 ]] && systemctl daemon-reload 2>/dev/null
	return 0
}


# Lift the caps back off root and every admin, and take the lifting away again
# from anyone who is no longer one. Written per uid because that is the only
# way to override a prefix drop-in for one instance of it.
_confine_slice_exemptions() {
	local login uid want=() u f changed=0

	want=(0)
	while read -r login; do
		[[ -n "$login" ]] || continue
		_confine_exempt "$login" || continue
		uid="$(id -u "$login" 2>/dev/null)" || continue
		want+=("$uid")
	done < <(_confine_humans)

	for uid in "${want[@]}"; do
		install -d -m 0755 "/etc/systemd/system/user-$uid.slice.d"
		if write_if_changed "/etc/systemd/system/user-$uid.slice.d/60-profullstack-exempt.conf" 0644 <<EOF
# uid $uid is root or an admin. The caps in the user-.slice.d drop-in apply to
# every user slice including this one, so they are lifted again here. An
# unbounded admin session is the point: this is the account that fixes the box.
[Slice]
MemoryHigh=infinity
MemoryMax=infinity
TasksMax=infinity
CPUQuota=
EOF
		then
			changed=1
			note "confine: uid $uid exempt from the resource caps"
		fi
	done

	# Someone demoted since the last run still has their exemption on disk.
	for f in /etc/systemd/system/user-*.slice.d/60-profullstack-exempt.conf; do
		[[ -e "$f" ]] || continue
		u="${f#/etc/systemd/system/user-}"; u="${u%%.slice.d/*}"
		printf '%s\n' "${want[@]}" | grep -qxF "$u" && continue
		rm -f "$f"
		rmdir "$(dirname "$f")" 2>/dev/null || true
		changed=1
		note "confine: uid $u is no longer an admin -- resource caps now apply"
	done

	[[ "$changed" == 1 ]]
}

# UMASK and HOME_MODE in login.defs, so that what is created from here on is
# born private. Neither fixes a file that already exists -- that is what
# fix_home_permissions does to the home itself -- but together they stop the
# box from generating the problem again with every new account.
configure_confine_login() {
	local changed=0
	_set_login_def UMASK "$CONFINE_UMASK" && { changed=1; note "confine: login.defs UMASK $CONFINE_UMASK"; }
	_set_login_def HOME_MODE "$CONFINE_HOME_MODE" && { changed=1; note "confine: login.defs HOME_MODE $CONFINE_HOME_MODE"; }
	return 0
}

# Set one key in /etc/login.defs. Not a file we own, so the existing line is
# edited in place -- commented or not -- and only appended when there is none.
_set_login_def() {
	local key="$1" val="$2" file=/etc/login.defs tmp
	[[ -w "$file" ]] || return 1
	grep -qE "^[[:space:]]*${key}[[:space:]]+${val}[[:space:]]*$" "$file" && return 1
	tmp="$(mktemp)" || return 1
	if grep -qE "^[[:space:]]*#?[[:space:]]*${key}[[:space:]]" "$file"; then
		sed -E "0,/^[[:space:]]*#?[[:space:]]*${key}[[:space:]].*$/s##${key}\t${val}#" "$file" >"$tmp"
	else
		{ cat "$file"; printf '\n# root-w3bs-os.sh: born-private defaults for new accounts\n%s\t%s\n' "$key" "$val"; } >"$tmp"
	fi
	if cmp -s "$tmp" "$file"; then rm -f "$tmp"; return 1; fi
	install -m 0644 "$tmp" "$file"
	rm -f "$tmp"
	return 0
}

# What a confined account may do over ssh.
#
# Forwarding is the interesting one, and the interesting direction is OUT. A
# tenant with -L can reach a service on localhost -- but so can any shell on
# the box, so -L costs nothing they did not already have. -R is different: it
# turns the machine into an open relay under our IP, and that is how a dev box
# ends up on a blocklist. Hence "local" by default: keep ssh -L for previewing
# your own app, drop the relay.
configure_confine_ssh() {
	local conf=/etc/ssh/sshd_config.d/60-profullstack-confine.conf backup fwd

	[[ "$CONFINE_SSH" == 1 ]] || { info "confine: sshd policy off (CONFINE_SSH=0)"; return 0; }
	[[ -d /etc/ssh/sshd_config.d ]] || { info "confine: no sshd_config.d on this box -- skipping"; return 0; }

	# A drop-in in a directory nothing includes is a policy that does not exist.
	if ! grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config 2>/dev/null; then
		warn "confine: /etc/ssh/sshd_config has no Include for sshd_config.d -- ssh policy NOT applied"
		return 1
	fi

	case "$CONFINE_SSH_FORWARDING" in
		local|no|yes) fwd="$CONFINE_SSH_FORWARDING" ;;
		*) warn "confine: CONFINE_SSH_FORWARDING='$CONFINE_SSH_FORWARDING' is not local|no|yes -- using local"; fwd=local ;;
	esac

	# sshd -t needs host keys to exist, and a box whose sshd has never been
	# started has none yet. ssh-keygen -A makes only the missing ones.
	command -v sshd >/dev/null 2>&1 || { info "confine: no sshd on this box -- skipping the ssh policy"; return 0; }
	ssh-keygen -A >/dev/null 2>&1 || true

	backup="$(mktemp)"
	[[ -f "$conf" ]] && cp -f "$conf" "$backup"

	write_if_changed "$conf" 0644 <<EOF || { rm -f "$backup"; return 0; }
# Written by root-w3bs-os.sh. What an account in @$CONFINE_GROUP may do.
#
# The closing 'Match all' is deliberate. On Alpine this directory is included
# near the top of /etc/ssh/sshd_config, so everything in the main file
# comes AFTER whatever is opened here. OpenSSH scopes a Match to the file it
# appears in -- measured on 10.2p1: with and without the closing line, the
# effective config for a non-matching user is identical -- so this is belt and
# braces rather than a fix for a live bug. It costs one line, it makes the file
# safe to concatenate or move, and 'Match Group' as the last thing in an
# included file is a footgun waiting for the version where that changes.
Match Group $CONFINE_GROUP
	AllowTcpForwarding $fwd
	AllowStreamLocalForwarding no
	GatewayPorts no
	PermitTunnel no
	X11Forwarding no
	AllowAgentForwarding no
	PermitUserRC no
Match all
EOF

	# A bad sshd config locks everyone out of the box, so it is validated before
	# anything is reloaded, and put back the way it was if it does not hold.
	if ! sshd -t 2>/dev/null; then
		if [[ -s "$backup" ]]; then
			install -m 0644 "$backup" "$conf"
		else
			rm -f "$conf"
		fi
		rm -f "$backup"
		warn "confine: sshd rejected the policy drop-in -- rolled back, sshd untouched"
		return 1
	fi
	rm -f "$backup"

	svc_is_active sshd && { svc_reload sshd || true; }
	note "confine: sshd policy for @$CONFINE_GROUP (forwarding=$fwd)"
	return 0
}

# A home is the account's own business: $CONFINE_HOME_MODE, and an ACL for
# Caddy where Caddy actually has something to serve.
#
# The mode alone would break the per-user web pages, because caddy has to
# walk through the home to reach ~/public_html. The old answer was chmod o+x,
# which opens that path to every account on the box as well. An ACL says the
# same thing to one user instead of to everyone -- and it is EXECUTE only, so
# caddy can traverse the home without being able to list it.
#
# Granted only where there is something published, so a home with no web
# content grants nothing at all.
_confine_home_mode() {
	local home="$1" login="$2"

	chmod "$CONFINE_HOME_MODE" "$home" 2>/dev/null || {
		warn "confine: could not chmod $CONFINE_HOME_MODE $home"
		return 1
	}

	if [[ -d "$home/public_html" || -d "$home/apps" ]] && getent group "$WEB_GROUP" >/dev/null; then
		if command -v setfacl >/dev/null 2>&1; then
			setfacl -m "u:$WEB_GROUP:--x" "$home" 2>/dev/null \
				|| warn "confine: could not grant $WEB_GROUP traverse on $home"
		else
			# No acl package yet (it arrives in the bootstrap stage). Fall back to the
			# old behaviour rather than silently breaking the user's web page --
			# less private, but a working box, and the next run fixes it.
			chmod o+x "$home"
			warn "confine: setfacl missing -- $home left traversable; re-run after apk installs acl"
		fi
	fi
	return 0
}

# Every human home, not only the accounts this script provisioned. The cloud
# image's own default user (w3bs, on the W3BS OS images) was never created by us and so never had its permissions
# touched -- and it is on every box.
configure_confine_homes() {
	local login home before
	while read -r login; do
		[[ -n "$login" ]] || continue
		home="$(user_home "$login")"
		[[ -n "$home" && -d "$home" ]] || continue
		before="$(stat -c '%a' "$home" 2>/dev/null)"
		_confine_home_mode "$home" "$login" || continue
		[[ "$(stat -c '%a' "$home" 2>/dev/null)" != "$before" ]] \
			&& note "confine: $home $before -> $(stat -c '%a' "$home" 2>/dev/null)"
	done < <(_confine_humans)
	return 0
}

configure_confinement() {
	local rc=0
	sync_confine_membership   || rc=1
	configure_confine_homes   || rc=1
	configure_confine_sysctl  || rc=1
	configure_confine_login   || rc=1
	configure_confine_limits  || rc=1
	configure_confine_proc    || rc=1
	configure_confine_ssh     || rc=1
	_confine_report_sudoers
	return $rc
}

# The one thing this will not do by itself. Naming them is the whole point:
# an account with wheel is outside confinement no matter what else is set.
_confine_report_sudoers() {
	local login extra=()
	while read -r login; do
		[[ -n "$login" ]] || continue
		_confine_exempt "$login" || continue
		extra+=("$login")
	done < <(_confine_humans)
	[[ ${#extra[@]} -gt 0 ]] || return 0
	info "confine: NOT confined (admins): ${extra[*]}"
	info "confine: each of those can leave confinement at will -- \`groups rm <user> wheel\` to demote"
	return 0
}

confine_usage() {
	cat <<EOF
usage: $0 confine [status|apply]

  status    what is confined on this box right now, and what is not (default).
            Reads only, and needs no root.
  apply     (re)apply confinement. Root. This is also done by every ordinary
            run, so you only need it to pick up a changed setting without
            doing the rest of the provisioning.

The model, in one line: root and admins are never confined, everybody else is
confined by default. Admins are whoever is in $CONFINE_EXEMPT_GROUPS.

Turning it off:      CONFINE=0 $0 --refresh
Letting someone out: $0 groups add <user> wheel
Putting them back:   $0 groups rm <user> wheel
EOF
	exit "${1:-0}"
}

# A read-only report on the posture. The point is to be able to answer "is this
# box actually tight?" without reading five config files -- and to be honest
# about the parts that are not, rather than printing a row of ticks.
_confine_status() {
	local login home mode tier admins=() confined=() leaky=() key want have

	printf '\n\033[1mconfine\033[0m: %s\n' \
		"$([[ "$CONFINE" == 1 ]] && echo "on" || echo "OFF (CONFINE=0)")"
	printf '  admin groups : %s\n' "$CONFINE_EXEMPT_GROUPS"
	printf '  confine group: %s\n' "$CONFINE_GROUP"

	printf '\n\033[1maccounts\033[0m\n'
	while read -r login; do
		[[ -n "$login" ]] || continue
		home="$(user_home "$login")"
		mode="$(stat -c '%a' "$home" 2>/dev/null || echo '?')"
		if _confine_exempt "$login"; then
			tier="admin"; admins+=("$login")
		else
			tier="confined"; confined+=("$login")
		fi
		# 'other' with any bit set means every account on the box can at least
		# walk in. That is the leak this whole thing exists to close.
		if [[ "$mode" =~ ^[0-7]?[0-7][0-7][1-7]$ ]]; then
			leaky+=("$login")
			printf '  %-8s  %-16s %s  \033[1;33m<- other can traverse/read\033[0m\n' "$tier" "$login" "$mode"
		else
			printf '  %-8s  %-16s %s\n' "$tier" "$login" "$mode"
		fi
	done < <(_confine_humans)

	printf '\n\033[1mmechanisms\033[0m\n'
	if grep ' /proc ' /proc/mounts 2>/dev/null | grep -q hidepid; then
		printf '  hidepid      yes  (an account sees only its own processes)\n'
	else
		printf '  hidepid      \033[1;33mno\033[0m   (ps -ef shows every command line on the box)\n'
	fi
	if [[ -f /etc/systemd/system/user-.slice.d/50-profullstack-confine.conf ]]; then
		printf '  slice caps   yes  MemoryMax=%s TasksMax=%s\n' "$CONFINE_MEMORY_MAX" "$CONFINE_TASKS_MAX"
		printf '  exempt uids  %s\n' \
			"$(ls -d /etc/systemd/system/user-*.slice.d 2>/dev/null \
				| sed 's#.*/user-##; s#\.slice\.d##' | tr '\n' ' ')"
	elif [[ -n "$(cat "$CONFINE_CGROUP_ROOT/cgroup.subtree_control" 2>/dev/null)" ]]; then
		printf '  cgroup caps  yes  memory.max=%s pids.max=%s (%s)\n' "$CONFINE_MEMORY_MAX" "$CONFINE_TASKS_MAX" "$CONFINE_CGROUP_ROOT"
	else
		printf '  cgroup caps  \033[1;33mno\033[0m   (one account can take the box down)\n'
	fi
	if [[ -f /etc/security/limits.d/60-profullstack-confine.conf ]] && _sshd_uses_pam; then
		printf '  pam limits   yes  nproc=%s nofile=%s\n' "$CONFINE_NPROC" "$CONFINE_NOFILE"
	elif [[ -f /etc/security/limits.d/60-profullstack-confine.conf ]]; then
		printf '  pam limits   \033[1;33mwritten, not read\033[0m (sshd has no PAM: apk add openssh-server-pam, UsePAM yes)\n'
	else
		printf '  pam limits   \033[1;33mno\033[0m\n'
	fi
	if [[ -f /etc/ssh/sshd_config.d/60-profullstack-confine.conf ]]; then
		printf '  ssh policy   yes  forwarding=%s\n' "$CONFINE_SSH_FORWARDING"
	else
		printf '  ssh policy   \033[1;33mno\033[0m   (ssh -R can relay through this box)\n'
	fi

	printf '\n\033[1mkernel floors\033[0m\n'
	for key in kernel.kptr_restrict:2 kernel.dmesg_restrict:1 kernel.perf_event_paranoid:3 \
		kernel.yama.ptrace_scope:1 fs.protected_fifos:2 fs.protected_regular:2; do
		want="${key#*:}"; key="${key%%:*}"
		have="$(sysctl -n "$key" 2>/dev/null)" || { printf '  %-32s absent on this kernel\n' "$key"; continue; }
		if [[ "$have" =~ ^-?[0-9]+$ ]] && (( have >= want )); then
			printf '  %-32s %s\n' "$key" "$have"
		else
			printf '  %-32s \033[1;33m%s\033[0m (floor %s)\n' "$key" "$have" "$want"
		fi
	done
	# Reported separately for the same reason it is set separately: 0 is safest
	# and 1 is the dangerous one, so "bigger is better" does not hold here.
	have="$(sysctl -n fs.suid_dumpable 2>/dev/null)"
	if [[ "$have" == 0 ]]; then
		printf '  %-32s %s\n' fs.suid_dumpable "$have"
	else
		printf '  %-32s \033[1;33m%s\033[0m (wanted 0)\n' fs.suid_dumpable "${have:-?}"
	fi

	printf '\n'
	if [[ ${#admins[@]} -gt 0 ]]; then
		printf '%d account(s) are NOT confined, because they are admins: %s\n' \
			"${#admins[@]}" "${admins[*]}"
		printf 'An admin can leave confinement at will. Demote with: %s groups rm <user> wheel\n' "$0"
	fi
	[[ ${#confined[@]} -gt 0 ]] && printf '%d account(s) confined: %s\n' "${#confined[@]}" "${confined[*]}"
	if [[ ${#leaky[@]} -gt 0 ]]; then
		printf '\n\033[1;33m%d home(s) are still reachable by other accounts: %s\033[0m\n' \
			"${#leaky[@]}" "${leaky[*]}"
		printf 'Fix with: doas %s confine apply\n' "$0"
	fi
	return 0
}

cmd_confine() {
	local action="${1:-status}"
	case "$action" in
		-h|--help|help) confine_usage 0 ;;
		status|"")      _confine_status ;;
		apply)
			[[ $EUID -eq 0 ]] || die "confine apply: must run as root (try: doas $0 confine apply)"
			[[ "$CONFINE" == 1 ]] || die "confine apply: CONFINE=0 -- nothing to apply"
			configure_confinement
			printf '\n'
			_confine_status
			;;
		*) die "confine: unknown action '$action' (try: status, apply)" ;;
	esac
}
# --------------------------------------------------------------- sandboxes ---
#
# Tenants: accounts that get a whole machine of their own instead of a shell on
# this one.
#
# The thing being avoided is the default UNIX answer to "let someone else use
# the box", which is a normal account. That answer is only as strong as every
# world-readable file, every setuid binary, every service listening on
# localhost, and every kernel LPE published between now and whenever this box
# is next patched. It is fine for colleagues and it is not fine for customers:
# one account, one bad afternoon, and everybody's work is on the floor.
#
# So a tenant does not get a shell here at all. Their host account exists --
# with $SANDBOX_NOLOGIN as its shell -- purely to own /home/<login>, which is
# what Caddy serves and what this script keeps dotfiles in. Everything they can
# actually run happens inside their own instance:
#
#   container   an unprivileged system container (LXC, via incus). Shares the
#               host kernel; boots in a second; they are root inside it and
#               nothing at all outside it. This is the default and it is what
#               almost everyone should get.
#   vm          a real virtual machine (KVM, via the same incus). Its own
#               kernel, so they can load modules, run docker without nesting
#               tricks, and break things a container would refuse to break.
#               Costs a few hundred MB of RAM and a slower boot. This is the
#               tier to sell to someone who says "I need root".
#
# The word for either of them is an INSTANCE. "Sandbox" usually means something
# smaller -- seccomp/bubblewrap/firejail around a single process -- and is the
# wrong mental model here: these are full systems with their own init, their
# own package manager and their own users.
#
# The manager is incus (https://linuxcontainers.org/incus), which is the LXD
# fork the original LXC/LXD maintainers moved to when Canonical took LXD
# in-house. Apache-2.0, in Alpine's community repository, one daemon, one CLI, and
# the same CLI drives both containers and VMs -- which is the whole reason both
# tiers above are ~20 lines apart rather than two separate implementations.
#
# --- what stops a tenant reaching anything of ours -------------------------
#
#   * no host shell             $SANDBOX_NOLOGIN, and never in wheel/sudo/admin
#   * unprivileged container    root inside maps to a high, unprivileged uid
#                               out here; a setuid file they make is setuid to
#                               nobody-in-particular
#   * no host-side execution    the tool installers (oh-my-zsh, mise, moshcode)
#                               run INSIDE the instance for a tenant. Running
#                               them on the host as the tenant would hand
#                               anyone who edits their own ~/.gitconfig code
#                               execution out here, which is the one thing this
#                               whole section exists to prevent
#   * a network ACL             egress to the internet, but RFC1918, link-local
#                               (169.254.169.254 -- cloud metadata) and the
#                               100.64/10 tailnet are rejected. That also stops
#                               tenant reaching tenant, since a neighbour is
#                               only ever an address inside our own bridge
#   * caps on cpu/memory/procs  a fork bomb starves its own instance and
#                               nothing else. Disk quotas need a pool driver
#                               that can enforce them -- see $SANDBOX_POOL
#   * one listening port each   $SANDBOX_SSH_PORT_BASE + slot, forwarded to the
#                               instance's own sshd. The host's sshd is never
#                               told about them
#
# --- how their work still shows up on the web ------------------------------
#
# /home/<login> is bind-mounted into the instance (idmapped, so the uids match
# on both sides). That one device is what keeps the rest of this script
# working unchanged: ~/public_html is still served by the host's Caddy, and
# ~/apps/<app>/.port is still compiled into the devapps map.
#
# The port in that file is a port on the tenant's OWN loopback. Each tenant is
# allocated a band of $SANDBOX_PORT_SPAN ports (slot 0 gets 21000-21099) which
# is forwarded 127.0.0.1:N <-> 127.0.0.1:N into their instance, so Caddy's
# `reverse_proxy 127.0.0.1:<port>` reaches it with no idea anything has
# changed. profullstack-devapps refuses a port outside the
# tenant's own band, so nobody can publish a neighbour's service under their
# own name.
#
# --- re-running -----------------------------------------------------------
#
# Everything here converges like the rest of the file: pools, networks, ACLs,
# profiles and devices are compared before they are written, the in-instance
# bootstrap is gated on a revision marker, and a tenant already holding slot 4
# keeps slot 4 forever (their ports are in DNS, in people's ~/.ssh/config, and
# in the Caddyfile). Deleting a tenant frees their slot for the next one.

_sandbox_configured() { [[ "$SANDBOX" == 1 || -s "$SANDBOX_TENANTS" ]]; }

# Same job as _groups_root, worded for this command. Reading "groups: init must
# run as root" after typing `sandbox init` sends people to the wrong subcommand.
_sandbox_root() {
	[[ $EUID -eq 0 ]] || die "sandbox: $1 must run as root (try: doas $0 sandbox $1 ...)"
}

# incus present AND answering. A daemon that is installed but not up is the
# common case right after apk, and every command below would otherwise fail
# one at a time with the same socket error.
incus_ok() {
	command -v incus >/dev/null 2>&1 || return 1
	incus info >/dev/null 2>&1
}

# ufw rules, applied without the noise. ufw is already idempotent -- it says
# "Skipping adding existing rule" and exits 0 -- so the only thing to add is
# not announcing a change that did not happen.
_ufw_rule() {
	local out
	command -v ufw >/dev/null 2>&1 || return 0
	out="$(ufw "$@" 2>&1)" || { warn "ufw $*: $out"; return 1; }
	[[ "$out" == *Skipping* ]] || note "ufw $*"
	return 0
}

# ---------------------------------------------------------- tenant records ---
#
# $SANDBOX_TENANTS is the register: one line per tenant, "<login> <slot>
# <kind>", tab separated. The slot is the only number that matters -- every
# port a tenant owns is derived from it -- so it is allocated once and never
# recomputed.

_tenant_field() {
	local login="$1" col="$2"
	[[ -s "$SANDBOX_TENANTS" ]] || return 1
	awk -F'\t' -v u="$login" -v c="$col" \
		'$1==u { print $c; found=1 } END { exit !found }' "$SANDBOX_TENANTS"
}
_tenant_slot() { _tenant_field "$1" 2; }
_tenant_kind() { _tenant_field "$1" 3; }
_is_tenant()   { _tenant_field "$1" 1 >/dev/null 2>&1; }

_sandbox_name() { printf '%s%s' "$SANDBOX_PREFIX" "$1"; }

_tenant_logins() {
	[[ -s "$SANDBOX_TENANTS" ]] || return 0
	cut -f1 "$SANDBOX_TENANTS"
}

# Record a tenant, allocating the lowest free slot. The slot comes back in
# $TENANT_SLOT rather than on stdout, because this function calls note() --
# and note() both prints and appends to $CHANGED, so a caller reading it
# through $(...) would splice the message into the slot number AND lose the
# entry, the subshell's array being thrown away when it exits.
#
# Re-registering an existing tenant only ever updates the kind (container ->
# vm), because moving someone's slot would move their ssh port, their app port
# band and everything anybody has written down about them.
TENANT_SLOT=""
_tenant_register() {
	local login="$1" kind="$2" slot tmp
	install -d -m 0700 "$SANDBOX_STATE"
	touch "$SANDBOX_TENANTS"

	slot="$(_tenant_slot "$login" 2>/dev/null)" || slot=""
	if [[ -n "$slot" ]]; then
		if [[ "$(_tenant_kind "$login")" != "$kind" ]]; then
			tmp="$(mktemp)" || return 1
			awk -F'\t' -v OFS='\t' -v u="$login" -v k="$kind" \
				'$1==u { $3=k } { print }' "$SANDBOX_TENANTS" >"$tmp" \
				&& install -m 0600 "$tmp" "$SANDBOX_TENANTS"
			rm -f "$tmp"
			note "tenant $login is now a $kind"
		fi
		TENANT_SLOT="$slot"
		return 0
	fi

	slot=0
	while awk -F'\t' -v s="$slot" '$2==s { found=1 } END { exit !found }' \
		"$SANDBOX_TENANTS"; do
		slot=$((slot + 1))
		[[ "$slot" -le "$SANDBOX_MAX_SLOTS" ]] || {
			warn "no free tenant slot (max $SANDBOX_MAX_SLOTS)"; return 1; }
	done
	printf '%s\t%s\t%s\n' "$login" "$slot" "$kind" >>"$SANDBOX_TENANTS"
	chmod 0600 "$SANDBOX_TENANTS"
	note "tenant $login -> slot $slot ($kind)"
	TENANT_SLOT="$slot"
	return 0
}

_tenant_forget() {
	local login="$1" tmp
	[[ -s "$SANDBOX_TENANTS" ]] || return 0
	tmp="$(mktemp)" || return 1
	awk -F'\t' -v u="$login" '$1!=u' "$SANDBOX_TENANTS" >"$tmp" \
		&& install -m 0600 "$tmp" "$SANDBOX_TENANTS"
	rm -f "$tmp"
}

# The four numbers a slot owns. Printed as one line so a caller can read them
# all at once and there is exactly one place the arithmetic lives.
#
#   ssh          the tcp port on the public interface -> instance :22
#   app_lo..hi   tcp, LOOPBACK ONLY, for ~/apps/<app>/.port
#   mosh_lo..hi  udp, public, for mosh-server inside the instance
_tenant_ports() {
	local slot="$1" lo hi mosh_lo
	lo=$((SANDBOX_PORT_BASE + slot * SANDBOX_PORT_SPAN))
	hi=$((lo + SANDBOX_PORT_SPAN - 1))
	mosh_lo=$((hi - SANDBOX_MOSH_PORTS + 1))
	printf '%s %s %s %s %s\n' \
		$((SANDBOX_SSH_PORT_BASE + slot)) "$lo" $((mosh_lo - 1)) "$mosh_lo" "$hi"
}

# ------------------------------------------------------------ incus itself ---

install_incus() {
	# incus is in Alpine's community repository: the daemon is incusd (OpenRC)
	# or incus (systemd), and the CLI is incus-client.
	if ! command -v incus >/dev/null 2>&1; then
		info "installing incus"
		# btrfs-progs is not incus' dependency but it decides whether per-tenant
		# disk quotas can be enforced at all (see _sandbox_pool), so it goes in
		# before the pool is created rather than after somebody notices.
		apk_add incus incus-client btrfs-progs \
			|| { warn "installing incus failed"; return 1; }
		# VMs need the qemu side; containers do not, so it is best effort.
		[[ "$SANDBOX_KIND" == vm ]] && { apk_add incus-vm || warn "incus-vm unavailable -- containers only"; }
		note "installed incus"
	fi

	svc_enable incus 2>/dev/null || true
	svc_start incus 2>/dev/null || true

	local i
	for i in $(seq 1 20); do
		incus_ok && return 0
		sleep 1
	done
	warn "incus is installed but not answering on its socket"
	return 1
}

# Set one key on an incus object, only when it is not already that. `incus
# <kind> set` is cheap but it is not free -- on a network or a profile it
# restarts every instance using it.
_incus_set() {
	local kind="$1" name="$2" key="$3" val="$4" cur
	cur="$(incus "$kind" get "$name" "$key" 2>/dev/null)"
	[[ "$cur" == "$val" ]] && return 0
	incus "$kind" set "$name" "$key" "$val" \
		|| { warn "incus $kind set $name $key=$val failed"; return 1; }
	note "incus $kind $name: $key=$val"
}

# Apply a rendered YAML document through `incus ... edit`, but only when the
# document has changed since the last run.
#
# incus has no "is this already the config" check of its own, and diffing what
# `show` prints against what we meant is hopeless -- the server adds defaults,
# reorders maps and echoes back computed fields. So the comparison is against
# what WE last sent, which is the question actually being asked: has this
# script's idea of the object changed?
_sandbox_apply_yaml() {
	local tag="$1"; shift
	local state="$SANDBOX_STATE/$tag.sha" body sha
	body="$(cat)"
	sha="$(printf '%s\n' "$body" | sha256sum | cut -d' ' -f1)"
	[[ "$(cat "$state" 2>/dev/null)" == "$sha" ]] && return 1
	printf '%s\n' "$body" | "$@" || { warn "$tag: incus rejected the config"; return 2; }
	install -d -m 0700 "$SANDBOX_STATE"
	printf '%s\n' "$sha" >"$state"
	return 0
}

# ------------------------------------------------- pool, bridge, acl, profile ---

_sandbox_pool() {
	incus storage show "$SANDBOX_POOL" >/dev/null 2>&1 && return 0

	local driver="$SANDBOX_POOL_DRIVER"
	if [[ -z "$driver" ]]; then
		if command -v mkfs.btrfs >/dev/null 2>&1; then driver=btrfs
		elif command -v zpool >/dev/null 2>&1; then driver=zfs
		else driver=dir; fi
	fi

	if [[ "$driver" == dir ]]; then
		# Worth saying out loud rather than discovering it when one tenant
		# fills the disk: the dir driver has nowhere to record a quota, so
		# $SANDBOX_DISK is accepted and then ignored.
		warn "storage pool '$SANDBOX_POOL' will use the dir driver -- per-tenant DISK QUOTAS ARE NOT ENFORCED"
		info "      to get them: apk add btrfs-progs, then re-run (the pool is created once)"
		incus storage create "$SANDBOX_POOL" dir >/dev/null \
			|| { warn "could not create storage pool $SANDBOX_POOL"; return 1; }
	else
		incus storage create "$SANDBOX_POOL" "$driver" size="$SANDBOX_POOL_SIZE" >/dev/null \
			|| { warn "could not create storage pool $SANDBOX_POOL ($driver)"; return 1; }
	fi
	note "incus storage pool $SANDBOX_POOL ($driver)"
	return 0
}

_sandbox_network() {
	local dnsopt="dhcp-option=6,$SANDBOX_DNS"

	if incus network show "$SANDBOX_BRIDGE" >/dev/null 2>&1; then
		_incus_set network "$SANDBOX_BRIDGE" raw.dnsmasq "$dnsopt"
	else
		incus network create "$SANDBOX_BRIDGE" \
			ipv4.address="$SANDBOX_SUBNET" ipv4.nat=true ipv6.address=none \
			raw.dnsmasq="$dnsopt" >/dev/null \
			|| { warn "could not create bridge $SANDBOX_BRIDGE"; return 1; }
		note "incus bridge $SANDBOX_BRIDGE ($SANDBOX_SUBNET)"
	fi

	# Tenants resolve through $SANDBOX_DNS, NOT through the bridge's own
	# dnsmasq, and that is not a preference: the ACL below rejects every
	# RFC1918 destination, the bridge gateway is one, and incus orders ACL
	# rules by action rather than by position -- so a reject on 10/8 would beat
	# an allow for the resolver no matter which order they are written in.
	# Handing out a public resolver over DHCP sidesteps the whole argument.

	_sandbox_ufw_bridge
	return 0
}

# ufw defaults to DROP on FORWARD, which breaks NAT egress from the bridge in a
# way that looks exactly like "the internet is down inside the container".
_sandbox_ufw_bridge() {
	command -v ufw >/dev/null 2>&1 || return 0
	ufw status 2>/dev/null | grep -q "Status: active" || return 0
	_ufw_rule allow in on "$SANDBOX_BRIDGE"
	_ufw_rule route allow in on "$SANDBOX_BRIDGE"
	return 0
}

# The one rule that makes a tenant a tenant rather than a neighbour.
#
# Only rejects are listed. incus evaluates drop, then reject, then allow --
# position in the list means nothing -- so a policy written as "reject these,
# allow the rest" is expressed by leaving the default egress action alone
# (allow) and naming only what must not happen.
_sandbox_acl() {
	[[ -n "$SANDBOX_ACL" ]] || return 0
	incus network acl show "$SANDBOX_ACL" >/dev/null 2>&1 || {
		incus network acl create "$SANDBOX_ACL" >/dev/null 2>&1 \
			|| { warn "could not create network acl $SANDBOX_ACL (is the nftables firewall driver in use?)"; return 1; }
		note "incus network acl $SANDBOX_ACL"
	}

	local dest
	{
		printf 'name: %s\n' "$SANDBOX_ACL"
		printf 'description: "tenants may reach the internet and nothing on this side of it"\n'
		printf 'config: {}\n'
		printf 'ingress: []\n'
		printf 'egress:\n'
		for dest in $SANDBOX_DENY_NETS; do
			printf -- '- action: reject\n  destination: %s\n  state: enabled\n' "$dest"
		done
	} | _sandbox_apply_yaml acl incus network acl edit "$SANDBOX_ACL"
	case $? in
		0) note "tenant network acl rules" ;;
		2) return 1 ;;
	esac
	return 0
}

_sandbox_profile_name() { [[ "$1" == vm ]] && printf 'tenant-vm' || printf 'tenant'; }

# The default shape of a tenant. Per-tenant overrides (a bigger disk for one
# customer, say) go on the instance and win over this.
_sandbox_profile_yaml() {
	local kind="$1" name
	name="$(_sandbox_profile_name "$kind")"
	printf 'name: %s\n' "$name"
	printf 'description: "profullstack tenant (%s)"\n' "$kind"
	printf 'config:\n'
	printf '  limits.cpu: "%s"\n' "$SANDBOX_CPU"
	printf '  limits.memory: "%s"\n' "$SANDBOX_MEMORY"
	printf '  boot.autostart: "true"\n'
	if [[ "$kind" == container ]]; then
		# A container shares the host kernel, so its limits are the host's
		# cgroups and its risk surface is the host's syscall table.
		printf '  limits.memory.swap: "false"\n'
		printf '  limits.processes: "%s"\n' "$SANDBOX_PROCESSES"
		printf '  security.privileged: "false"\n'
		printf '  security.nesting: "%s"\n' \
			"$([[ "$SANDBOX_NESTING" == 1 ]] && echo true || echo false)"
		printf '  security.syscalls.intercept.mknod: "false"\n'
		printf '  security.syscalls.intercept.setxattr: "false"\n'
	fi
	printf 'devices:\n'
	printf '  eth0:\n'
	printf '    type: nic\n'
	printf '    network: %s\n' "$SANDBOX_BRIDGE"
	[[ -n "$SANDBOX_ACL" ]] && printf '    security.acls: %s\n' "$SANDBOX_ACL"
	printf '  root:\n'
	printf '    type: disk\n'
	printf '    path: /\n'
	printf '    pool: %s\n' "$SANDBOX_POOL"
	printf '    size: %s\n' "$SANDBOX_DISK"
}

_sandbox_profile() {
	local kind="$1" name
	name="$(_sandbox_profile_name "$kind")"
	incus profile show "$name" >/dev/null 2>&1 || {
		incus profile create "$name" >/dev/null \
			|| { warn "could not create profile $name"; return 1; }
		note "incus profile $name"
	}
	_sandbox_profile_yaml "$kind" \
		| _sandbox_apply_yaml "profile-$name" incus profile edit "$name"
	case $? in
		0) note "incus profile $name updated" ;;
		2) return 1 ;;
	esac
	return 0
}

# Everything that exists once per box rather than once per tenant.
sandbox_init() {
	incus_ok || { warn "incus is not answering -- skipping sandbox setup"; return 1; }
	install -d -m 0700 "$SANDBOX_STATE"
	_sandbox_pool     || return 1
	_sandbox_network  || return 1
	_sandbox_acl      || warn "continuing without a tenant network ACL"
	_sandbox_profile container || return 1
	_sandbox_profile vm        || warn "vm profile unavailable (no KVM on this box?)"
	return 0
}

# ------------------------------------------------------------- an instance ---

# Add a device if it is missing, or reconcile the keys we care about if it is
# not. Devices are the part of an instance most likely to drift, because they
# are also the part a human edits by hand when something is on fire.
_incus_device() {
	local inst="$1" dev="$2" type="$3"; shift 3
	local kv key val changed=0

	if ! incus config device list "$inst" 2>/dev/null | grep -qxF "$dev"; then
		incus config device add "$inst" "$dev" "$type" "$@" >/dev/null \
			|| { warn "$inst: could not add device $dev ($type)"; return 1; }
		note "$inst: device $dev ($type)"
		return 0
	fi

	for kv in "$@"; do
		key="${kv%%=*}"; val="${kv#*=}"
		[[ "$(incus config device get "$inst" "$dev" "$key" 2>/dev/null)" == "$val" ]] && continue
		incus config device set "$inst" "$dev" "$key" "$val" \
			|| { warn "$inst: could not set $dev.$key"; continue; }
		changed=1
	done
	[[ "$changed" == 1 ]] && note "$inst: device $dev reconciled"
	return 0
}

_sandbox_running() {
	[[ "$(incus info "$1" 2>/dev/null | awk '/^Status:/ { print tolower($2) }')" == running ]]
}

# An instance is "up" when it is running AND will run a command -- which for a
# VM means the incus agent inside it has started, several seconds after the
# status says RUNNING.
_sandbox_wait() {
	local name="$1" i
	for i in $(seq 1 "$SANDBOX_BOOT_TIMEOUT"); do
		incus exec "$name" -- true >/dev/null 2>&1 && return 0
		sleep 1
	done
	warn "$name did not become reachable within ${SANDBOX_BOOT_TIMEOUT}s"
	return 1
}

_sandbox_devices() {
	local login="$1" name="$2" kind="$3" slot="$4"
	local ssh_port app_lo app_hi mosh_lo mosh_hi home
	read -r ssh_port app_lo app_hi mosh_lo mosh_hi < <(_tenant_ports "$slot")
	home="$(user_home "$login")"

	# The shared home. shift=true is an idmapped mount: /home/alice is owned by
	# alice's uid on both sides, so the host's Caddy and the tenant's editor are
	# looking at the same files with the same owner. VMs get the same directory
	# over virtiofs, where the uid is passed through as-is -- which is why the
	# account inside the instance is created with the host's uid, not with
	# whatever useradd would have picked.
	if [[ -n "$home" && -d "$home" ]]; then
		if [[ "$kind" == container ]]; then
			_incus_device "$name" home disk \
				"source=$home" "path=$home" shift=true
		else
			_incus_device "$name" home disk "source=$home" "path=$home"
		fi
	fi

	# Public: this is how the tenant gets in. 0.0.0.0 rather than a specific
	# address so it keeps working when the box's IP changes.
	_incus_device "$name" ssh proxy \
		"listen=tcp:0.0.0.0:$ssh_port" connect=tcp:127.0.0.1:22

	# Loopback only: Caddy is the only thing that should ever reach a dev app,
	# and binding these publicly would put every tenant's unfinished work on
	# the internet on a guessable port.
	_incus_device "$name" apps proxy \
		"listen=tcp:127.0.0.1:$app_lo-$app_hi" \
		"connect=tcp:127.0.0.1:$app_lo-$app_hi"

	# mosh picks a udp port at connect time, so it needs a range rather than a
	# port. The tenant passes it: mosh -p <lo>:<hi> --ssh="ssh -p <ssh>" ...
	_incus_device "$name" mosh proxy \
		"listen=udp:0.0.0.0:$mosh_lo-$mosh_hi" \
		"connect=udp:127.0.0.1:$mosh_lo-$mosh_hi"

	# Per-instance overrides of the profile, so one tenant can be given more
	# without moving everyone else.
	_incus_device "$name" root disk path=/ "pool=$SANDBOX_POOL" "size=$SANDBOX_DISK"
	return 0
}

# What the tenant's own machine gets, once. Gated on a revision marker written
# inside the instance -- bump $SANDBOX_BOOTSTRAP_REV to make every tenant pick
# up a change on the next run.
_sandbox_bootstrap() {
	local login="$1" name="$2" slot="$3" have uid gid
	local ssh_port app_lo app_hi mosh_lo mosh_hi
	read -r ssh_port app_lo app_hi mosh_lo mosh_hi < <(_tenant_ports "$slot")

	have="$(incus exec "$name" -- cat "$SANDBOX_REV_FILE" 2>/dev/null | tr -cd '0-9')"
	[[ "$have" == "$SANDBOX_BOOTSTRAP_REV" ]] && return 0

	uid="$(id -u "$login" 2>/dev/null)" || { warn "no host account for $login"; return 1; }
	gid="$(id -g "$login")"

	info "bootstrapping $name (rev $SANDBOX_BOOTSTRAP_REV)"
	incus exec "$name" \
		--env TENANT="$login" --env TENANT_UID="$uid" --env TENANT_GID="$gid" \
		--env TENANT_REV="$SANDBOX_BOOTSTRAP_REV" --env TENANT_REV_FILE="$SANDBOX_REV_FILE" \
		--env TENANT_APP_LO="$app_lo" --env TENANT_APP_HI="$app_hi" \
		--env TENANT_MOSH_LO="$mosh_lo" --env TENANT_MOSH_HI="$mosh_hi" \
		--env TENANT_SSH_PORT="$ssh_port" --env TENANT_DOMAIN="$WEB_DOMAIN" \
		--env DEBIAN_FRONTEND=noninteractive \
		-- bash -s <<'TENANT_BOOTSTRAP' || { warn "$name: bootstrap failed"; return 1; }
set -uo pipefail

apt-get update -qq
apt-get install -y --no-install-recommends \
	openssh-server mosh sudo zsh git curl ca-certificates rsync unzip \
	tmux vim htop build-essential >/dev/null || exit 1

# The uid is the host's, deliberately: /home/$TENANT is the same directory on
# both sides of the mount, and a mismatch here shows up as a home directory the
# tenant cannot write to.
getent group "$TENANT" >/dev/null 2>&1 || groupadd -g "$TENANT_GID" "$TENANT" || true
if ! id -u "$TENANT" >/dev/null 2>&1; then
	# -M: the home is a mount, not ours to create or populate
	useradd -u "$TENANT_UID" -g "$TENANT_GID" -M -d "/home/$TENANT" -s /bin/zsh "$TENANT"
fi

# Root inside their own machine is the entire point of giving them one.
usermod -aG sudo "$TENANT" 2>/dev/null || true
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$TENANT" >/etc/sudoers.d/90-tenant
chmod 0440 /etc/sudoers.d/90-tenant

mkdir -p /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/10-tenant.conf <<CFG
# managed by root-w3bs-os.sh on the host -- edits are overwritten
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $TENANT
CFG

# authorized_keys already exists: it is in the shared home, put there on the
# host from ssh-keys/<login>.pub. Nothing to install, only permissions to
# assert, because sshd silently ignores the file otherwise.
if [ -d "/home/$TENANT/.ssh" ]; then
	chmod 0700 "/home/$TENANT/.ssh"
	[ -e "/home/$TENANT/.ssh/authorized_keys" ] && chmod 0600 "/home/$TENANT/.ssh/authorized_keys"
fi

systemctl enable ssh >/dev/null 2>&1 || systemctl enable sshd >/dev/null 2>&1 || true
systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || true

cat >/etc/motd <<MOTD

  This is ${TENANT}'s machine. You are root here and nowhere else.

  Web        ~/public_html          -> https://${TENANT}.${TENANT_DOMAIN}
  Dev apps   mkdir ~/apps/<name>    -> https://<name>.${TENANT}.${TENANT_DOMAIN}
             echo <port> > ~/apps/<name>/.port, and listen on 127.0.0.1:<port>

  Your ports are ${TENANT_APP_LO}-${TENANT_APP_HI}. A .port outside that range
  is ignored -- it would be somebody else's service.

  ssh        ssh -p ${TENANT_SSH_PORT} ${TENANT}@${TENANT_DOMAIN}
  mosh       mosh -p ${TENANT_MOSH_LO}:${TENANT_MOSH_HI} --ssh="ssh -p ${TENANT_SSH_PORT}" ${TENANT}@${TENANT_DOMAIN}

MOTD

mkdir -p "$(dirname "$TENANT_REV_FILE")"
printf '%s\n' "$TENANT_REV" >"$TENANT_REV_FILE"
TENANT_BOOTSTRAP

	note "$name bootstrapped (rev $SANDBOX_BOOTSTRAP_REV)"
	return 0
}

# oh-my-zsh, mise and moshcode -- the same three the host installs for everyone
# else, run INSIDE the instance as the tenant. This is the deliberate half of
# the isolation: these are `curl | sh` installers reading the tenant's own
# dotfiles, and running them on the host would be handing a customer code
# execution outside their box.
_sandbox_tools() {
	local login="$1" name="$2"
	[[ "$SKIP_TOOLS" == 1 ]] && return 0
	incus exec "$name" --env HOME="/home/$login" -- \
		runuser -u "$login" -- bash -lc '
			ZSH="$HOME/.oh-my-zsh" ZDOTDIR="$HOME" RUNZSH=no CHSH=no KEEP_ZSHRC=yes \
				sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" >/dev/null 2>&1
			curl -fsSL https://mise.run | sh >/dev/null 2>&1
			curl -fsSL https://moshcode.sh/install.sh | sh >/dev/null 2>&1
			# threatcrush-disable-next-line sh-remote-script-execution first-party installer, same accepted idiom as mise/moshcode above
			curl -fsSL https://threatcrush.com/install.sh | sh >/dev/null 2>&1
			# threatcrush-disable-next-line sh-remote-script-execution first-party installer (hqsh, for hqterm connect)
			curl -fsSL https://hqterm.sh/install | sh -s -- --server >/dev/null 2>&1
			true' >/dev/null 2>&1 \
		|| warn "$name: one of the tool installers failed (not fatal)"
	return 0
}

_sandbox_ufw() {
	local slot="$1" ssh_port app_lo app_hi mosh_lo mosh_hi
	read -r ssh_port app_lo app_hi mosh_lo mosh_hi < <(_tenant_ports "$slot")
	# app_lo..app_hi is deliberately NOT opened: those listen on loopback for
	# Caddy and must not be reachable from outside.
	_ufw_rule allow "$ssh_port/tcp"
	_ufw_rule allow "$mosh_lo:$mosh_hi/udp"
	return 0
}

create_sandbox() {
	local login="$1" kind="${2:-$SANDBOX_KIND}" name slot
	case "$kind" in
		container|vm) ;;
		*) warn "unknown sandbox kind '$kind' -- using container"; kind=container ;;
	esac
	incus_ok || { warn "incus is not available -- $login has no instance"; return 1; }
	valid_login "$login" || return 1
	id -u "$login" >/dev/null 2>&1 || { warn "no host account for $login"; return 1; }

	name="$(_sandbox_name "$login")"
	_tenant_register "$login" "$kind" || return 1
	slot="$TENANT_SLOT"

	if ! incus info "$name" >/dev/null 2>&1; then
		info "launching $kind $name from $SANDBOX_IMAGE (this takes a minute the first time)"
		local -a args=(launch "$SANDBOX_IMAGE" "$name"
			--profile "$(_sandbox_profile_name "$kind")")
		[[ "$kind" == vm ]] && args+=(--vm)
		incus "${args[@]}" >/dev/null || {
			warn "could not launch $name"
			# Do not keep the slot for an instance that does not exist.
			_tenant_forget "$login"
			return 1
		}
		note "$kind $name created for $login"
	fi

	refresh_sandbox "$login"
}

# What a re-run does to a tenant that already exists: no launch, no image
# fetch, no data touched -- start it if it is down, reconcile the devices, and
# re-assert the firewall.
refresh_sandbox() {
	local login="$1" kind name slot
	kind="$(_tenant_kind "$login" 2>/dev/null)" || return 0
	slot="$(_tenant_slot "$login")"
	name="$(_sandbox_name "$login")"

	incus_ok || { warn "incus is not answering -- $login's instance not refreshed"; return 1; }
	if ! incus info "$name" >/dev/null 2>&1; then
		warn "$login is registered as a tenant but $name does not exist"
		info "      create it: $0 sandbox create $login --$kind"
		return 1
	fi

	_sandbox_running "$name" || {
		incus start "$name" >/dev/null 2>&1 || { warn "could not start $name"; return 1; }
		note "started $name"
	}
	_sandbox_wait "$name" || return 1

	_sandbox_devices "$login" "$name" "$kind" "$slot"
	_sandbox_bootstrap "$login" "$name" "$slot" || return 1
	_sandbox_tools "$login" "$name"
	_sandbox_ufw "$slot"
	return 0
}

delete_sandbox() {
	local login="$1" name slot ssh_port app_lo app_hi mosh_lo mosh_hi
	name="$(_sandbox_name "$login")"
	slot="$(_tenant_slot "$login" 2>/dev/null)" || slot=""

	if incus_ok && incus info "$name" >/dev/null 2>&1; then
		incus delete --force "$name" >/dev/null \
			|| { warn "could not delete $name"; return 1; }
		note "deleted instance $name"
	fi

	if [[ -n "$slot" ]]; then
		read -r ssh_port app_lo app_hi mosh_lo mosh_hi < <(_tenant_ports "$slot")
		command -v ufw >/dev/null 2>&1 && {
			ufw delete allow "$ssh_port/tcp" >/dev/null 2>&1
			ufw delete allow "$mosh_lo:$mosh_hi/udp" >/dev/null 2>&1
		}
	fi
	_tenant_forget "$login"
	note "$login is no longer a tenant (their home is untouched)"
	return 0
}

# ------------------------------------------------------- the sandbox command ---

sandbox_usage() {
	cat <<EOF
$0 sandbox -- give an account its own machine instead of a shell on this one

  sandbox                       list the tenants on this box
  sandbox init                  install incus and create the pool/bridge/profiles
  sandbox create <user> [--vm]  give an existing account an instance
  sandbox refresh [<user>...]   reconcile instances with this script (default: all)
  sandbox info <user>           incus' own view of one instance
  sandbox enter <user>          a root shell inside their machine
  sandbox exec <user> -- <cmd>  run one command inside it
  sandbox start|stop|restart <user>
  sandbox rm <user>             delete the instance; the host home is KEPT

Kinds:
  --container   (default) an unprivileged system container: shared kernel,
                instant boot, root inside and nothing outside
  --vm          a real KVM virtual machine: its own kernel, so nested
                containers and kernel modules work. This is the "I need root"
                tier, and it costs RAM

A tenant's account has $SANDBOX_NOLOGIN as its shell and is NOT in wheel, sudo
or admin. They reach their machine on its own port:

  ssh -p <${SANDBOX_SSH_PORT_BASE}+slot> <user>@$WEB_DOMAIN

Their /home is shared with this box, so ~/public_html and ~/apps keep working
exactly as they do for a normal account.
EOF
}

_sandbox_list() {
	local login slot kind name status ssh_port app_lo app_hi _x _y
	if [[ ! -s "$SANDBOX_TENANTS" ]]; then
		info "no tenants on this box"
		info "make one: $0 <user> --sandbox    (or: $0 sandbox create <user>)"
		return 0
	fi
	printf '    %-14s %-5s %-10s %-9s %-7s %s\n' USER SLOT KIND STATUS SSH APPS
	while IFS=$'\t' read -r login slot kind; do
		[[ -n "$login" ]] || continue
		name="$(_sandbox_name "$login")"
		status=absent
		incus_ok && status="$(incus info "$name" 2>/dev/null \
			| awk '/^Status:/ { print tolower($2) }')"
		read -r ssh_port app_lo app_hi _x _y < <(_tenant_ports "$slot")
		printf '    %-14s %-5s %-10s %-9s %-7s %s\n' \
			"$login" "$slot" "$kind" "${status:-absent}" "$ssh_port" "$app_lo-$app_hi"
	done <"$SANDBOX_TENANTS"
	return 0
}

cmd_sandbox() {
	local verb="" kind="" login
	local -a rest=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			-h|--help)   sandbox_usage; return 0 ;;
			--vm)        kind=vm ;;
			--container) kind=container ;;
			# `sandbox rm` asks before it deletes; this is how a script says
			# yes, and it is the same spelling as everywhere else in the file.
			-y|--yes)    ASSUME_YES=1 ;;
			--)          shift; rest+=("$@"); break ;;
			-*)          die "sandbox: unknown option: $1  (try: $0 sandbox --help)" ;;
			*)           rest+=("$1") ;;
		esac
		shift
	done

	if [[ ${#rest[@]} -gt 0 ]]; then
		case "${rest[0]}" in
			list|init|create|refresh|info|enter|exec|start|stop|restart|rm)
				verb="${rest[0]}"; rest=("${rest[@]:1}") ;;
		esac
	fi

	case "${verb:-list}" in
		list) _sandbox_list ;;
		init)
			_sandbox_root init
			install_incus || return 1
			sandbox_init
			;;
		create)
			_sandbox_root create
			[[ ${#rest[@]} -gt 0 ]] || die "sandbox create: which user?"
			install_incus || return 1
			sandbox_init  || return 1
			for login in "${rest[@]}"; do
				create_sandbox "$login" "${kind:-$SANDBOX_KIND}"
			done
			;;
		refresh)
			_sandbox_root refresh
			incus_ok || die "sandbox refresh: incus is not available"
			if [[ ${#rest[@]} -gt 0 ]]; then
				for login in "${rest[@]}"; do refresh_sandbox "$login"; done
			else
				while read -r login; do
					[[ -n "$login" ]] && refresh_sandbox "$login"
				done < <(_tenant_logins)
			fi
			;;
		info)
			[[ ${#rest[@]} -gt 0 ]] || die "sandbox info: which user?"
			incus info "$(_sandbox_name "${rest[0]}")"
			;;
		enter)
			_sandbox_root enter
			[[ ${#rest[@]} -gt 0 ]] || die "sandbox enter: which user?"
			incus exec "$(_sandbox_name "${rest[0]}")" -- \
				login -f "${SANDBOX_ENTER_AS:-root}"
			;;
		exec)
			_sandbox_root exec
			[[ ${#rest[@]} -gt 1 ]] || die "sandbox exec: $0 sandbox exec <user> -- <command>"
			login="${rest[0]}"
			incus exec "$(_sandbox_name "$login")" -- "${rest[@]:1}"
			;;
		start|stop|restart)
			_sandbox_root "$verb"
			[[ ${#rest[@]} -gt 0 ]] || die "sandbox $verb: which user?"
			for login in "${rest[@]}"; do
				incus "$verb" "$(_sandbox_name "$login")" \
					&& info "$login: $verb ok" || warn "$login: $verb failed"
			done
			;;
		rm)
			_sandbox_root rm
			[[ ${#rest[@]} -gt 0 ]] || die "sandbox rm: which user?"
			for login in "${rest[@]}"; do
				_is_tenant "$login" || { warn "$login is not a tenant"; continue; }
				confirm "Delete $(_sandbox_name "$login") and everything in it (their /home is kept)? [y/N]" n \
					|| { info "$login left alone"; continue; }
				delete_sandbox "$login"
			done
			;;
	esac
}
usage() {
	sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
	exit "${1:-0}"
}

# Subcommands are peeled off before the provisioning flags, so that `mount`
# can take its own options without colliding with them.
SUBCMD=""
SUBARGS=()
case "${1:-}" in
	mount|umount|mounts|share|groups|sandbox|confine)
		SUBCMD="$1"; shift; SUBARGS=("$@"); set -- ;;
esac

ARGS=()
CLI_GROUPS=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--refresh)        ASSUME_YES=1 ;;
		--force-dotfiles) FORCE_DOTFILES=1 ;;
		--no-reboot)      REBOOT_POLICY=0 ;;
		--reboot)         REBOOT_POLICY=2 ;;
		--skip-apk|--skip-apt) SKIP_APK=1 ;;
		--skip-firewall)  SKIP_FIREWALL=1 ;;
		# Not Alpine? Refused, unless this. Inside `groups` it means something
		# else (lift a refusal) -- subcommands are peeled off above, so the two
		# never meet.
		--force)          FORCE_OS=1 ;;
		--with-moshcode)     WITH_MOSHCODE=1 ;;
		--without-moshcode|--no-moshcode) WITH_MOSHCODE=0 ;;
		--with-sh1pt)        WITH_SH1PT=1 ;;
		--without-sh1pt|--no-sh1pt) WITH_SH1PT=0 ;;
		--skip-web)       SKIP_WEB=1 ;;
		--skip-tailscale) SKIP_TAILSCALE=1 ;;
		--skip-tools)     SKIP_TOOLS=1 ;;
		--skip-dotfiles)  SKIP_DOTFILES=1 ;;
		# Accounts named on THIS run get their own machine instead of a shell
		# here. --sandbox=vm for the tier with its own kernel.
		--sandbox)        SANDBOX=1 ;;
		--sandbox=*)      SANDBOX=1; SANDBOX_KIND="${1#*=}" ;;
		--no-sandbox)     SANDBOX=0 ;;
		# Leave existing tenants alone this run (they are slow to reconcile and
		# an apk/Caddy pass has no reason to wait for them).
		--skip-sandbox)   SKIP_SANDBOX=1 ;;
		# Groups for every account named on this run. Without it an interactive
		# run asks per account and an unattended one takes $DEFAULT_GROUPS --
		# which left no way at all to say "these two, in these groups" from a
		# pipe, and provisioning accounts from a pipe is the whole point of
		# being curl-able.
		--groups)         CLI_GROUPS="${2:-}"; shift ;;
		--groups=*)       CLI_GROUPS="${1#*=}" ;;
		--yes|-y)         ASSUME_YES=1 ;;
		-h|--help)        usage 0 ;;
		-*)               die "unknown option: $1  (try --help)" ;;
		*)                ARGS+=("$1") ;;
	esac
	shift
done
set -- ${ARGS[@]+"${ARGS[@]}"}

[[ "${NO_REBOOT:-0}" == 1 ]] && REBOOT_POLICY=0

case "$SANDBOX_KIND" in
	container|vm) ;;
	*) die "--sandbox: unknown kind '$SANDBOX_KIND' (container or vm)" ;;
esac

# The share and groups helpers are self-contained: no apk, no lock, no dotfiles
# checkout needed. They come before the root check so that --help, --dry-run and
# a plain `groups` listing work as a normal user; each asks for root only when
# it mutates.
case "$SUBCMD" in
	mount)  cmd_mount  ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
	umount) cmd_umount ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
	mounts) cmd_mounts; exit $? ;;
	share)  cmd_share  ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
	groups) cmd_groups ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
	sandbox) cmd_sandbox ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
	confine) cmd_confine ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
esac

# Root, not admin-capable: this writes to /etc, creates accounts and drives
# OpenRC. Saying which is which up front beats failing on the twentieth step.
if [[ $EUID -ne 0 ]]; then
	if command -v doas >/dev/null 2>&1; then
		die "must run as root -- try: doas $0${*:+ $*}"
	elif command -v sudo >/dev/null 2>&1; then
		die "must run as root -- try: sudo $0${*:+ $*}"
	fi
	die "must run as root (and there is no doas or sudo on this box -- log in as root)"
fi

# What this actually supports, checked rather than assumed.
#
# W3BS OS is Alpine underneath, and that is the line: Alpine, or something
# that says it is like Alpine (postmarketOS), runs. Anything else is refused,
# because every package name and service in here is Alpine's -- Ubuntu and
# Debian boxes have root-ubuntu.sh, and running this there would half-convert
# a box to tools it does not have. --force overrides that for someone who
# knows better; the run will mostly fail, loudly.
check_os() {
	local id="" like="" ver="" pretty=""
	if [[ -r /etc/os-release ]]; then
		# Read, not sourced: it is not ours, and only three keys are wanted.
		id="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -1)"
		like="$(sed -n 's/^ID_LIKE=//p' /etc/os-release | tr -d '"' | head -1)"
		ver="$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"' | head -1)"
		pretty="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '"' | head -1)"
	fi
	read_w3bs_os_release

	case " $id $like " in
		*" alpine "*) ;;
		*)
			if [[ "$FORCE_OS" != 1 ]]; then
				case "$id" in
					ubuntu|debian)
						die "${pretty:-$id} is not W3BS OS -- use root-ubuntu.sh on Ubuntu/Debian (or --force to insist)" ;;
					*)
						die "${pretty:-${id:-this OS}} is not W3BS OS or Alpine (--force to run anyway, unsupported)" ;;
				esac
			fi
			warn "${pretty:-${id:-unknown OS}} is not Alpine -- continuing because of --force"
			;;
	esac
	command -v apk >/dev/null 2>&1 || [[ "$FORCE_OS" == 1 ]] \
		|| die "no apk on this box -- this script targets W3BS OS / Alpine"

	# 3.20 and up: caddy, ufw, earlyoom and incus are all in community there.
	if [[ "$id" == alpine && -n "$ver" ]] && awk -v v="$ver" 'BEGIN { split(v, a, "."); exit !((a[1] + 0) * 100 + (a[2] + 0) < 320) }'; then
		warn "${pretty:-Alpine $ver} is older than 3.20 -- expect some packages to be missing"
	fi

	if [[ "$W3BS_OS_ID" == w3bs-os ]]; then
		info "W3BS OS (${W3BS_OS_EDITION:-unknown edition}) on ${pretty:-Alpine} $(uname -m)"
	else
		info "${pretty:-Alpine} on $(uname -m) (no /etc/w3bs-os-release: plain Alpine, treated the same)"
	fi
	info "init: $(detect_init)$(_in_container && echo ', in a container')"
	[[ "$(detect_init)" == none ]] \
		&& warn "no running init -- services are installed but not started, and cron jobs only run under one"
	return 0
}
check_os

# Two copies racing each other through apk, chsh and Caddy is a good way to
# corrupt exactly the box you were trying to maintain. busybox has flock, so
# this works before the bootstrap packages are in.
#
# fd 9 is closed (9>&-) on everything that can leave a daemon behind -- the
# svc_* helpers and as_user. OpenRC's supervise-daemon otherwise inherits the
# locked descriptor and holds the lock for as long as Caddy runs, so the NEXT
# run dies with "already in progress" (measured: run two, 0.3s in).
exec 9>"$LOCK_FILE"
flock -n 9 || die "another run of $0 is already in progress"

# Unattended runs (cron, --refresh) leave a trail; interactive ones stay on the
# terminal only, so prompts behave normally.
if ! interactive; then
	exec > >(tee -a "$LOG_FILE") 2>&1
	printf '\n===== %s  %s =====\n' "$(date -Is)" "$0 $*"
fi

# Where the dotfiles come from, if they come from anywhere.
#
# This used to be a hard requirement -- the script died unless it was sitting
# inside a dotfiles checkout -- which is exactly what stopped it being usable on
# a machine that had only curled the one file. Dotfiles are now one optional
# stage of many, resolved in this order:
#
#   1. $DOTFILES_DIR              -- an existing checkout you point at
#   2. the directory holding this script, if it looks like one (so running it
#      from inside a dotfiles repo still Just Works, as it always did)
#   3. $DOTFILES_REPO, cloned to $DOTFILES_CACHE and fast-forwarded on re-runs
#   4. nothing, and the dotfile stages are skipped
#
# A checkout is recognised by its content, not its name: any tree with a
# .zshrc or a .bashrc in it is one.
looks_like_dotfiles() {
	[[ -n "${1:-}" && -d "$1" ]] || return 1
	[[ -f "$1/.zshrc" || -f "$1/.bashrc" ]]
}

resolve_dotfiles() {
	if [[ "$SKIP_DOTFILES" == 1 ]]; then
		DOTFILES_DIR=""
		return 0
	fi

	if looks_like_dotfiles "$DOTFILES_DIR"; then
		info "dotfiles: $DOTFILES_DIR"
		return 0
	fi
	if [[ -n "$DOTFILES_DIR" ]]; then
		warn "DOTFILES_DIR=$DOTFILES_DIR has no .zshrc or .bashrc -- ignoring it"
		DOTFILES_DIR=""
	fi

	# ...but only a CHECKOUT. The documented way to run this is from /root
	# (curl -O, then ./root-w3bs-os.sh), and after the first run /root has a
	# .zshrc of its own -- oh-my-zsh puts one there. Taken at face value that
	# made the second run treat root's home as the team's dotfiles and copy
	# root's shell config into every account (measured; root-ubuntu.sh has the
	# same trap). A dotfiles repo is a git checkout; a home directory is not.
	if looks_like_dotfiles "$SCRIPT_DIR" && [[ -e "$SCRIPT_DIR/.git" ]]; then
		DOTFILES_DIR="$SCRIPT_DIR"
		info "dotfiles: $DOTFILES_DIR (running from inside them)"
		return 0
	fi

	if [[ -n "$DOTFILES_REPO" ]]; then
		# Same converge-don't-clobber rule as everywhere else: fetch and reset
		# onto the remote head, because a --depth 1 clone cannot always
		# fast-forward and a half-updated dotfiles tree is worse than a stale one.
		if [[ -d "$DOTFILES_CACHE/.git" ]]; then
			git -C "$DOTFILES_CACHE" fetch --quiet --depth 1 origin HEAD \
				&& git -C "$DOTFILES_CACHE" reset --quiet --hard FETCH_HEAD \
				|| warn "could not update $DOTFILES_CACHE -- using the copy on disk"
		else
			install -d -m 0755 "$(dirname "$DOTFILES_CACHE")"
			git clone --depth 1 --quiet "$DOTFILES_REPO" "$DOTFILES_CACHE" \
				|| warn "could not clone $DOTFILES_REPO"
		fi
		# A dotfiles tree is somebody's shell config and may carry ssh config or
		# known_hosts; it has no business being world-readable on a shared box.
		[[ -d "$DOTFILES_CACHE" ]] && chmod 0700 "$DOTFILES_CACHE"
		if looks_like_dotfiles "$DOTFILES_CACHE"; then
			DOTFILES_DIR="$DOTFILES_CACHE"
			info "dotfiles: $DOTFILES_REPO -> $DOTFILES_DIR"
			return 0
		fi
		warn "$DOTFILES_REPO has no .zshrc or .bashrc at its root -- skipping dotfiles"
	fi

	DOTFILES_DIR=""
	info "no dotfiles source (set DOTFILES_REPO to install a team's shell config)"
	return 0
}

# The pasted-key store follows the dotfiles when there are some, so a team's
# keys travel with a team's config, and falls back to this box's state
# directory when there are not. Either way it has to be somewhere that survives
# a re-run, or every rebuild would ask for every key again.
resolve_keys_dir() {
	[[ -n "$KEYS_DIR" ]] && return 0
	if [[ -n "$DOTFILES_DIR" ]]; then
		KEYS_DIR="$DOTFILES_DIR/ssh-keys"
	else
		KEYS_DIR="$STATE_DIR/ssh-keys"
	fi
	return 0
}

# Both of these are CALLED after the apk stage, not here: cloning a dotfiles
# repo needs git, and git is one of the packages the bootstrap installs.

# The repositories every package below comes from. A stock Alpine install
# (setup-alpine without "c") has only main enabled, and caddy, ufw, earlyoom,
# fail2ban and incus all live in community -- so the community line for the
# SAME branch as main is uncommented or added. Never edge: mixing branches is
# how an Alpine box breaks.
ensure_apk_repos() {
	local f="${1:-/etc/apk/repositories}" main tmp
	[[ -f "$f" ]] || return 0
	grep -qE '^[^#]*/community/?[[:space:]]*$' "$f" && return 0
	main="$(grep -E '^[^#]*/main/?[[:space:]]*$' "$f" | head -1)"
	[[ -n "$main" ]] || { warn "no main repository in $f -- not touching it"; return 1; }
	tmp="$(mktemp)" || return 1
	if grep -qE "^#[[:space:]]*${main%/main*}/community" "$f"; then
		sed -E "s|^#[[:space:]]*(${main%/main*}/community)|\1|" "$f" >"$tmp"
	else
		{ cat "$f"; printf '%s\n' "${main%/main*}/community"; } >"$tmp"
	fi
	install -m 0644 "$tmp" "$f"; rm -f "$tmp"
	note "apk: community repository enabled"
	apk update -q >/dev/null 2>&1 || warn "apk update failed after enabling community"
}

# The GNU tools the rest of the file is written against, before anything uses
# them. On a box that already has them this is one `apk info -e` per name.
bootstrap_tools() {
	ensure_apk_repos
	local missing=() p
	for p in "${BOOTSTRAP_PACKAGES[@]}"; do apk_has "$p" || missing+=("$p"); done
	if [[ ${#missing[@]} -gt 0 ]]; then
		apk update -q >/dev/null 2>&1 || true
		apk_add "${missing[@]}" && note "bootstrap: ${missing[*]}"
	fi
	return 0
}
log "bootstrap tools"
try "bootstrap packages" bootstrap_tools

install -d -m 0755 "$STATE_DIR"
if [[ -e "$STATE_DIR/provisioned" ]]; then
	log "maintenance run -- converging $(hostname -s 2>/dev/null || hostname) to the current templates"
else
	log "first run on $(hostname -s 2>/dev/null || hostname)"
fi

load_known_users

# ------------------------------------------------- collect users + groups ---

# Numbered menu; accepts "1 3", "1,3" or group names. Empty = $DEFAULT_GROUPS.
ask_groups() {
	local login="$1" raw tok out=() i
	# --groups was given: that is an answer, so do not ask the question. It wins
	# over the prompt as well as over the default, because someone who spelled
	# the groups out on the command line has already decided.
	if [[ -n "$CLI_GROUPS" ]]; then printf '%s' "$CLI_GROUPS"; return; fi
	if ! interactive; then printf '%s' "$DEFAULT_GROUPS"; return; fi

	printf '\n    groups for %s:\n' "$login" >&2
	for i in "${!GROUP_CHOICES[@]}"; do
		printf '      %d) %s\n' "$((i + 1))" "${GROUP_CHOICES[$i]}" >&2
	done
	read -r -p "    pick (numbers or names, space/comma separated) [${DEFAULT_GROUPS}]: " raw >&2
	raw="${raw//,/ }"
	[[ -z "${raw// }" ]] && { printf '%s' "$DEFAULT_GROUPS"; return; }

	for tok in $raw; do
		if [[ "$tok" =~ ^[0-9]+$ ]]; then
			if (( tok >= 1 && tok <= ${#GROUP_CHOICES[@]} )); then
				out+=("${GROUP_CHOICES[$((tok - 1))]}")
			else
				warn "ignoring out-of-range choice '$tok'"
			fi
		else
			out+=("$tok")
		fi
	done

	[[ ${#out[@]} -eq 0 ]] && { printf '%s' "$DEFAULT_GROUPS"; return; }
	printf '%s' "$(IFS=,; echo "${out[*]}")"
}

add_user_spec() {
	local spec="$1" login
	login="$(user_login "$spec")"
	valid_login "$login" || { warn "invalid username derived from '$spec' -- skipped"; return 1; }
	USERS+=("$spec")
	# A tenant's groups are not a question. The whole arrangement rests on
	# them having no privilege out here, and "wheel" is what both the
	# default and the interactive prompt would otherwise hand them.
	if [[ "$SANDBOX" == 1 ]]; then
		USER_GROUPS+=("$SANDBOX_GROUP")
		info "queued ${login} -> $SANDBOX_KIND, groups: $SANDBOX_GROUP (no shell on this box)"
		return 0
	fi
	USER_GROUPS+=("$(ask_groups "$login")")
	info "queued ${login} -> groups: ${USER_GROUPS[-1]}"
}

for arg in "$@"; do
	add_user_spec "$arg"
done

if [[ ${#KNOWN_USERS[@]} -gt 0 ]]; then
	log "already provisioned (will be refreshed, not recreated)"
	info "${KNOWN_USERS[*]}"
fi

if interactive; then
	log "user accounts"
	echo "    Existing users above are refreshed automatically -- press enter to skip."
	echo "    To add someone NEW, enter one account at a time, e.g. alice@example"
	while true; do
		read -r -p "    add user: " spec
		[[ -z "${spec// }" ]] && break
		case "${spec,,}" in
			n|no|done|q|quit|exit) break ;;
		esac
		add_user_spec "$spec"
	done
fi

# No prompt for the private keys any more. It asked on every interactive run,
# and one mistaken 'y' scatters your own private keys through other people's
# home directories with nothing to undo it. COPY_SSH_PRIVATE_KEYS=1 in the
# environment is now the only way, which is deliberate rather than reflexive.


# ------------------------------------------------------------------- apk ---

# Only the OS-level bits: shell, terminal apps we keep configs for, firewall,
# web server. Language runtimes and dev tools are mise's job, and the suite
# tools are the w3bs CLI's.
# mosh ships mosh, mosh-client and mosh-server in one package.
BASE_PACKAGES=(
	ca-certificates curl git zsh tmux irssi mosh ufw
	caddy
	openssh-server openssh-keygen
	# the tools whose dotfiles this repo ships -- without them the configs
	# are dead weight and the box feels half-provisioned
	vim htop ack screen rsync unzip jq openssl
	# setfacl/getfacl: `share --group` and the per-home grant for caddy
	acl
	# PDFs: pdftotext/pdfinfo/pdftoppm/pdfimages, and qpdf to decrypt/split
	poppler-utils qpdf
	ripgrep
	# chawan is packaged on Alpine (it is a .deb off the author's site on
	# Ubuntu); lynx stays as the fallback, as it is there
	chawan lynx
	# Hardware sensors and inventory, read-only -- see configure_sensors.
	lm-sensors lm-sensors-detect i2c-tools smartmontools nvme-cli ipmitool acpi
	powertop sysstat dmidecode lshw pciutils usbutils
	# the cron daemon every periodic job below is driven by, and logrotate
	logrotate
)

# Load the kernel modules that expose temperatures, fans and voltages under
# /sys/class/hwmon. Only worth doing on bare metal: a VM is not given the
# host's thermal hardware, and a container is not given anything.
configure_sensors() {
	local virt=""

	if ! command -v sensors-detect >/dev/null 2>&1; then
		info "lm-sensors-detect not installed -- skipping sensor detection"
		return 0
	fi

	virt="$(_virt)"
	if [[ -n "$virt" && "$virt" != none ]]; then
		info "running under $virt -- no thermal hardware is exposed to guests, skipping sensors-detect"
		return 0
	fi

	if compgen -G "/sys/class/hwmon/hwmon*/temp*_input" >/dev/null 2>&1; then
		info "hardware sensors already available under /sys/class/hwmon"
		return 0
	fi

	# sensors-detect probes SMBus adapters through /dev/i2c-*, which only exist
	# once i2c-dev is loaded. --auto answers no to loading it itself.
	modprobe i2c-dev 2>/dev/null || true

	if sensors-detect --auto >/dev/null 2>&1; then
		# OpenRC loads /etc/modules at boot; sensors-detect wrote what it found
		# there, so load it now rather than waiting for the next boot.
		svc_restart modules 2>/dev/null || true
		if compgen -G "/sys/class/hwmon/hwmon*/temp*_input" >/dev/null 2>&1; then
			note "hardware sensors detected"
		else
			info "sensors-detect found no supported chips on this machine"
		fi
	else
		warn "sensors-detect failed -- temperatures will be unavailable"
	fi
	return 0
}

# A kernel upgrade on Alpine replaces /lib/modules/<old> outright, so "the
# running kernel's modules are gone" is exactly "a reboot is required" --
# the Alpine reading of Ubuntu's /var/run/reboot-required.
reboot_required() {
	_in_container && return 1
	[[ -d "/lib/modules/$(uname -r)" ]] && return 1
	# no modules directory at all is a kernel built without modules, not an upgrade
	compgen -G "/lib/modules/*" >/dev/null 2>&1
}

# The base system and every W3BS package, through the w3bs CLI: `w3bs os
# update` once the CLI ships it, `w3bs dist-upgrade` until then (apk update +
# apk upgrade --available, then `w3bs update` for every W3BS package), and
# plain apk where there is no w3bs at all.
system_upgrade() {
	local bin
	if bin="$(w3bs_bin)"; then
		if "$bin" os --help >/dev/null 2>&1; then
			"$bin" os update --yes --non-interactive
			return
		fi
		"$bin" dist-upgrade --yes --non-interactive
		return
	fi
	apk update -q && apk upgrade --available -q
}

# The unattended half, the Alpine stand-in for unattended-upgrades: a daily
# periodic script (busybox crond runs /etc/periodic/daily at 02:00). Within a
# stable branch every apk upgrade is a fix, so the whole upgrade is the safe
# set; moving to a new release is `w3bs os upgrade`, never this.
install_auto_upgrade() {
	local f=/etc/periodic/daily/w3bs-os-update
	if [[ "$AUTO_UPGRADE" != 1 ]]; then
		[[ -e "$f" ]] && { rm -f "$f"; note "daily unattended upgrade removed (AUTO_UPGRADE=0)"; }
		return 0
	fi
	install -d -m 0755 /etc/periodic/daily
	write_if_changed "$f" 0755 <<'EOF' && note "daily unattended upgrade ($f)"
#!/bin/sh
# Managed by cli-tools/root-w3bs-os.sh (AUTO_UPGRADE=0 removes it).
# The base system and every W3BS package, through the w3bs CLI when it is here.
exec >>/var/log/w3bs-os-update.log 2>&1
echo "== $(date)"
w3bs=""
for c in /usr/local/bin/w3bs /usr/bin/w3bs /root/.local/bin/w3bs; do
	[ -x "$c" ] && { w3bs="$c"; break; }
done
if [ -n "$w3bs" ]; then
	if "$w3bs" os --help >/dev/null 2>&1; then
		exec "$w3bs" os update --yes --non-interactive
	fi
	exec "$w3bs" dist-upgrade --yes --non-interactive
fi
apk update -q && exec apk upgrade --available -q
EOF
	svc_enable crond 2>/dev/null
	svc_start crond 2>/dev/null || true
	return 0
}

apk_stage() {
	log "system upgrade (w3bs)"
	local before after
	before="$(apk info -v 2>/dev/null | sha256sum)"
	try "system upgrade" system_upgrade
	after="$(apk info -v 2>/dev/null | sha256sum)"
	[[ "$before" != "$after" ]] && note "apk packages changed"

	log "installing base packages"
	local missing=() p
	for p in "${BASE_PACKAGES[@]}"; do
		apk_has "$p" || missing+=("$p")
	done
	# The OpenRC service scripts for crond and syslog live in busybox-openrc,
	# which a minimal image with openrc added after the fact can lack.
	if command -v openrc >/dev/null 2>&1 && ! apk_has busybox-openrc; then
		missing+=(busybox-openrc)
	fi
	if [[ ${#missing[@]} -gt 0 ]]; then
		note "installing: ${missing[*]}"
		apk_add "${missing[@]}" || warn "some base packages did not install (listed above)"
	else
		info "all base packages already installed"
	fi

	# sshd at boot, so the accounts this creates can actually log in. Not
	# started in a container: the runtime decides what runs there.
	if [[ "$(detect_init)" != none ]] && ! _in_container; then
		svc_enable sshd 2>/dev/null && svc_start sshd 2>/dev/null || true
	fi

	log "detecting hardware sensors"
	try "sensors" configure_sensors

	log "enabling the daily unattended upgrade"
	try "auto upgrade" install_auto_upgrade
	return 0
}

# The hostname. A stock image names the box after the image ("localhost",
# "alpine"), and every shell prompt, log line and mail header on it repeats
# that. /etc/hosts maps the full name (and the short one) to 127.0.1.1 so
# doas and anything else resolving its own name does not stall on DNS.
valid_hostname() {
	[[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ && ${#1} -le 253 ]]
}

set_box_hostname() {
	local current want short hosts
	current="$(hostname -f 2>/dev/null || hostname)"
	want="$BOX_HOSTNAME"
	if [[ -z "$want" ]] && interactive; then
		read -r -p "Hostname for this box, its full DNS name (e.g. box1.example.com) [$current]: " want
	fi
	want="${want:-$current}"
	want="${want,,}"
	valid_hostname "$want" || { warn "not a hostname: $want -- keeping $current"; return 1; }
	short="${want%%.*}"

	# A container's hostname is the runtime's: it is reset on every start and
	# a write to /etc/hostname there only confuses the next person to look.
	if _in_container; then
		[[ -n "$BOX_HOSTNAME" ]] && info "in a container -- the hostname is the runtime's (docker run --hostname)"
		[[ -n "$TS_HOSTNAME_GIVEN" ]] || TS_HOSTNAME="$short"
		return 0
	fi

	if [[ "$(hostname)" != "$want" ]]; then
		if command -v hostnamectl >/dev/null 2>&1 && [[ "$(detect_init)" == systemd ]]; then
			hostnamectl set-hostname "$want" || return 1
		else
			# OpenRC's hostname service reads /etc/hostname at boot.
			printf '%s\n' "$want" >/etc/hostname && hostname "$want" || return 1
		fi
		note "hostname $want"
	fi

	hosts="$(grep -v '^127\.0\.1\.1[[:space:]]' /etc/hosts)"
	{
		printf '%s\n' "$hosts"
		if [[ "$short" != "$want" ]]; then
			printf '127.0.1.1\t%s %s\n' "$want" "$short"
		else
			printf '127.0.1.1\t%s\n' "$want"
		fi
	} | write_if_changed /etc/hosts && note "/etc/hosts names $want"

	# cloud-init (Alpine cloud images use it too) sets the hostname back on
	# every boot unless told the box owns it now.
	if [[ -d /etc/cloud/cloud.cfg.d ]]; then
		printf 'preserve_hostname: true\n' | write_if_changed /etc/cloud/cloud.cfg.d/99-preserve-hostname.cfg \
			&& note "cloud-init keeps the hostname"
	fi

	[[ -n "$TS_HOSTNAME_GIVEN" ]] || TS_HOSTNAME="$short"
	return 0
}

try "hostname" set_box_hostname

# w3bs before the upgrade: it is what does the upgrade.
log "w3bs CLI"
try "w3bs" ensure_w3bs

if [[ "$SKIP_APK" == 1 ]]; then
	log "skipping apk (--skip-apk)"
else
	apk_stage
fi

# Now that git exists, work out where the dotfiles are coming from -- see
# resolve_dotfiles for the order it tries.
log "resolving dotfiles source"
resolve_dotfiles
resolve_keys_dir

# ------------------------------------------------------------------- ufw ---
#
# ufw, because Alpine packages it (community) and it keeps every rule this
# script and its sandboxes add sayable in one line. It drives iptables-nft
# underneath, so it coexists with nftables, and /etc/default/ufw IPV6=yes
# makes every rule dual-stack.
configure_firewall() {
	command -v ufw >/dev/null 2>&1 || { apk_add ufw || return 1; }

	# The -n guard is not redundant with the -f test: with no dotfiles checkout
	# the path collapses to /etc/default/ufw, which is the very file being
	# written, and the comparison would be a file against itself.
	if [[ -n "$DOTFILES_DIR" && -f "$DOTFILES_DIR/etc/default/ufw" ]] \
		&& ! cmp -s "$DOTFILES_DIR/etc/default/ufw" /etc/default/ufw; then
		try "install /etc/default/ufw" install -m 0644 "$DOTFILES_DIR/etc/default/ufw" /etc/default/ufw \
			&& note "/etc/default/ufw"
	fi
	# Dual-stack is not optional: Caddy listens on both, and a firewall that
	# only knows v4 leaves v6 wide open or shut depending on the default.
	if grep -q '^IPV6=no' /etc/default/ufw 2>/dev/null; then
		sed -i 's/^IPV6=no/IPV6=yes/' /etc/default/ufw && note "ufw: IPV6=yes"
	fi

	_ufw_quiet --force default deny incoming
	_ufw_quiet --force default allow outgoing

	# ssh first -- opening it before enabling is what stops you locking yourself out
	_ufw_rule allow "${SSH_PORT}/tcp"
	_ufw_rule allow 80/tcp
	_ufw_rule allow 443/tcp
	# HTTP/3: Caddy serves QUIC on 443/udp
	_ufw_rule allow 443/udp
	# mosh picks a UDP port in this range per session; without it mosh cannot connect
	_ufw_rule allow 60000:61000/udp

	# 'ufw enable' on an already-active firewall reloads the whole ruleset,
	# which briefly drops packets on a box people are logged into. Only enable
	# it when it is actually off.
	if ufw status 2>/dev/null | head -1 | grep -q 'inactive'; then
		ufw --force enable >/dev/null 2>&1 || { warn "ufw enable failed (no netfilter in this kernel/container?)"; return 1; }
		note "ufw enabled"
	else
		info "ufw already active"
	fi
	svc_enable ufw boot 2>/dev/null || svc_enable ufw 2>/dev/null || true
	return 0
}

# Run ufw for a policy change, silently: it prints the same line whether or not
# anything changed, so its own output says nothing worth keeping.
_ufw_quiet() { ufw "$@" >/dev/null 2>&1 || warn "ufw $* failed"; }

if [[ "$SKIP_FIREWALL" == 1 ]]; then
	log "skipping the firewall (--skip-firewall)"
else
	log "configuring ufw"
	try "ufw" configure_firewall
	ufw status verbose 2>/dev/null || true
fi

# ------------------------------------------------------------------ swap ---
#
# A box with no swap has no slack. The kernel's only answer to a memory spike
# is the OOM killer, and what it picks is whatever was biggest -- on these
# boxes, the build, the language server, or the editor someone was working in.
# 2G of swap does not make a small box a big one; it turns "the process died"
# into "that got slow for a moment", which is the difference between losing an
# afternoon and noticing nothing.
#
# Deliberately a swap FILE and not a partition: provider images arrive with the
# whole disk given to /, so there is no partition to make, and a file can be
# resized or removed on a live box.
SWAP_SIZE="${SWAP_SIZE:-2G}"          # 0 disables; the box keeps whatever it has
SWAP_FILE="${SWAP_FILE:-/swapfile}"
# 60 (the default) treats swap as another tier of memory and pages out things
# that are still being used. 10 keeps it as the safety net it is meant to be.
SWAPPINESS="${SWAPPINESS:-10}"

# 2G / 2048M / 2 (G assumed) -> megabytes
_size_mb() {
	local s="${1^^}"
	[[ "$s" =~ ^([0-9]+)([GM]?)$ ]] || return 1
	case "${BASH_REMATCH[2]}" in
		M) printf '%s' "${BASH_REMATCH[1]}" ;;
		*) printf '%s' "$(( BASH_REMATCH[1] * 1024 ))" ;;
	esac
}

_swap_sysctl() {
	write_if_changed /etc/sysctl.d/60-profullstack-swap.conf <<EOF || return 0
# Managed by root-w3bs-os.sh. Swap here is headroom for spikes, not a memory
# tier -- page out late, and only under real pressure.
vm.swappiness = $SWAPPINESS
EOF
	sysctl -q -p /etc/sysctl.d/60-profullstack-swap.conf 2>/dev/null || true
	note "vm.swappiness=$SWAPPINESS"
}

configure_swap() {
	local file="$SWAP_FILE" dir want_mb avail_mb fstype virt name type size _rest

	if [[ -z "$SWAP_SIZE" || "$SWAP_SIZE" == 0 ]]; then
		info "swap disabled (SWAP_SIZE=$SWAP_SIZE) -- leaving this box as it is"
		return 0
	fi

	# Containers share the host kernel, and its swap is the host's business --
	# and so is vm.swappiness: a privileged container that writes it writes the
	# HOST's (measured: the swap check below sees the host's swapfile and zram,
	# and would have gone on to set swappiness=10 on the host). So this comes
	# before anything else.
	if _in_container; then
		info "inside a container -- swap (and vm.swappiness) belong to the host"
		return 0
	fi

	# Somebody else's swap counts. A swapfile stacked on top of a swap
	# partition or a zram device is not extra safety, it is a file nobody
	# remembers making.
	if swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then
		while read -r name type size _rest; do
			info "swap already active: $name ($type, $size)"
		done < <(swapon --show=NAME,TYPE,SIZE --noheadings 2>/dev/null)
		_swap_sysctl
		return 0
	fi

	# Containers share the host kernel, and its swap is the host's business.
	# swapon in here either fails outright or is refused by the cgroup after
	# the file has already been written.
	if _in_container; then
		info "inside a container -- swap belongs to the host"
		return 0
	fi

	dir="$(dirname "$file")"
	fstype="$(df --output=fstype "$dir" 2>/dev/null | tail -1)"
	case "$fstype" in
		btrfs)
			warn "no swapfile: btrfs needs one built its own way (chattr +C, no compression, no snapshots)"
			return 0 ;;
		zfs)
			warn "no swapfile: a swapfile on zfs can deadlock the box -- use a zvol"
			return 0 ;;
	esac

	want_mb="$(_size_mb "$SWAP_SIZE")" || {
		warn "swap: cannot read SWAP_SIZE=$SWAP_SIZE (want something like 2G or 2048M)"
		return 1
	}

	# Filling the root disk to buy memory headroom is a bad trade: a full /
	# breaks things a memory spike would not have touched.
	avail_mb="$(df -BM --output=avail "$dir" 2>/dev/null | tail -1 | tr -dc '0-9')"
	if [[ -n "$avail_mb" ]] && (( avail_mb < want_mb + 2048 )); then
		warn "swap: ${avail_mb}M free on $dir, need ${want_mb}M plus headroom -- skipping"
		return 0
	fi

	[[ -e "$file" && ! -f "$file" ]] && { warn "swap: $file exists and is not a file"; return 1; }

	log "creating ${SWAP_SIZE} of swap at $file"
	# fallocate is instant, but on some filesystems it leaves unwritten extents
	# that mkswap then refuses. dd always works and is only slow the once, so
	# it is both the fallback and the retry.
	rm -f "$file"
	fallocate -l "${want_mb}M" "$file" 2>/dev/null \
		|| dd if=/dev/zero of="$file" bs=1M count="$want_mb" status=none \
		|| { warn "swap: could not allocate $file"; rm -f "$file"; return 1; }
	# World-readable swap is every secret the machine has ever paged out, so
	# the mode goes on first and on its own -- chained behind a chown, one
	# failure there would leave the file readable and mkswap would still be
	# happy with it.
	chmod 0600 "$file"
	chown root:root "$file"
	if ! mkswap "$file" >/dev/null 2>&1; then
		# the unwritten-extents case: write the bytes for real, then try once more
		dd if=/dev/zero of="$file" bs=1M count="$want_mb" status=none
		chmod 0600 "$file"
		if ! mkswap "$file" >/dev/null 2>&1; then
			warn "swap: mkswap failed on $file"
			rm -f "$file"
			return 1
		fi
	fi
	swapon "$file" || { warn "swap: swapon failed on $file"; rm -f "$file"; return 1; }
	note "${SWAP_SIZE} swap at $file"

	# ...and again after a reboot. Matched on the path, so an entry someone has
	# since edited (different options, a different priority) is left alone.
	if awk -v f="$file" '$1 == f && $3 == "swap" { found = 1 } END { exit !found }' /etc/fstab; then
		info "fstab already brings $file up at boot"
	else
		printf '%-16s none            swap    sw              0       0\n' "$file" >>/etc/fstab \
			&& note "fstab: $file"
	fi

	# OpenRC brings fstab swap up through its swap service, which is not in a
	# runlevel on every image.
	svc_enable swap boot 2>/dev/null || true

	_swap_sysctl
	return 0
}

log "configuring swap"
try "swap" configure_swap

# ------------------------------------------------------- zram + earlyoom ---
#
# Swap buys time. It does not decide what dies when the time runs out, and on
# its own it buys that time in the most expensive currency the box has: disk.
#
#   zram      a compressed block device in RAM, used as swap AHEAD of the file.
#             On Alpine that is zram-init (OpenRC), configured in
#             /etc/conf.d/zram-init; under systemd, zram-generator as on Ubuntu.
#
#   earlyoom  a daemon that watches free memory and swap and kills the biggest
#             consumer while the box is still responsive, rather than at the
#             wall. Alpine packages it with an OpenRC service.
#
# Ordered after configure_swap on purpose: that function returns early if any
# swap is already active, so zram first would suppress the swapfile entirely.
EARLYOOM_ENABLE="${EARLYOOM_ENABLE:-1}"   # 0 leaves the box's OOM behaviour alone
ZRAM_ENABLE="${ZRAM_ENABLE:-1}"           # 0 skips zram, keeping only the swapfile
# MiB. Empty: half of RAM, capped at 8 GiB -- what root-ubuntu.sh's
# 'min(ram / 2, 8192)' zram-generator expression works out to, computed here
# because zram-init takes a number, not an expression.
ZRAM_SIZE_MB="${ZRAM_SIZE_MB:-}"
ZRAM_ALGO="${ZRAM_ALGO:-zstd}"
ZRAM_SWAPPINESS="${ZRAM_SWAPPINESS:-100}"
# Kill at 10% free (SIGTERM) and 5% (SIGKILL), of memory AND swap together.
EARLYOOM_MEM="${EARLYOOM_MEM:-10,5}"
EARLYOOM_SWAP="${EARLYOOM_SWAP:-10,5}"
# Never pick these. Losing sshd or init to the thing that was supposed to save
# the box is how a recoverable incident becomes a console-only one.
EARLYOOM_AVOID="${EARLYOOM_AVOID:-^(sshd|init|openrc|supervise-daemon|crond|tmux|zsh|bash|login|tailscaled|dockerd|containerd|caddy|postgres|redis)$}"
EARLYOOM_PREFER="${EARLYOOM_PREFER:-}"

configure_earlyoom() {
	local changed=0

	if [[ -z "$EARLYOOM_ENABLE" || "$EARLYOOM_ENABLE" == 0 ]]; then
		info "earlyoom disabled (EARLYOOM_ENABLE=$EARLYOOM_ENABLE)"
		return 0
	fi
	if _in_container; then
		info "inside a container -- the host decides what gets killed"
		return 0
	fi

	apk_has earlyoom || { try "install earlyoom" apk_add earlyoom || return 0; }

	if [[ "$(detect_init)" == systemd ]]; then
		write_if_changed /etc/default/earlyoom <<EOF && changed=1
# Managed by root-w3bs-os.sh. Kill the biggest consumer while the box can still
# be typed at, instead of at the wall where the kernel would have done it.
EARLYOOM_ARGS="-m $EARLYOOM_MEM -s $EARLYOOM_SWAP -r 3600 --avoid $EARLYOOM_AVOID${EARLYOOM_PREFER:+ --prefer $EARLYOOM_PREFER}"
EOF
	else
		# Alpine's /etc/conf.d/earlyoom: one variable per flag, and the init
		# script quotes them itself -- so unlike EnvironmentFile there is no
		# quote-stripping trap for the regexes here.
		write_if_changed /etc/conf.d/earlyoom <<EOF && changed=1
# Managed by root-w3bs-os.sh. Kill the biggest consumer while the box can still
# be typed at, instead of at the wall where the kernel would have done it.
mem_min_percent="$EARLYOOM_MEM"
swap_min_percent="$EARLYOOM_SWAP"
avoid_cmds="$EARLYOOM_AVOID"
prefer_cmds="$EARLYOOM_PREFER"
command_args="-r 3600"
EOF
	fi
	svc_enable earlyoom 2>/dev/null || true
	[[ "$(detect_init)" == none ]] && return 0

	if (( changed )) || ! svc_is_active earlyoom; then
		try "earlyoom" svc_restart earlyoom || return 0
		note "earlyoom watching (TERM at ${EARLYOOM_MEM%%,*}% free, KILL at ${EARLYOOM_MEM##*,}%)"
	else
		info "earlyoom already watching"
	fi
}

_zram_size_mb() {
	local kb mb
	[[ -n "$ZRAM_SIZE_MB" ]] && { printf '%s' "$ZRAM_SIZE_MB"; return; }
	kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
	[[ -n "$kb" ]] || { printf '1024'; return; }
	mb=$(( kb / 1024 / 2 ))
	(( mb > 8192 )) && mb=8192
	printf '%s' "$mb"
}

configure_zram() {
	local changed=0 active=0 algo size

	if [[ -z "$ZRAM_ENABLE" || "$ZRAM_ENABLE" == 0 ]]; then
		info "zram disabled (ZRAM_ENABLE=$ZRAM_ENABLE)"
		return 0
	fi
	if _in_container; then
		info "inside a container -- zram belongs to the host"
		return 0
	fi

	if ! modprobe zram 2>/dev/null && [[ ! -e /sys/class/zram-control ]]; then
		warn "zram: no zram module for $(uname -r) -- the swapfile stays the only tier"
		return 0
	fi

	# zstd gets ~3:1 where lzo manages ~2:1, but only if this kernel built it
	# in; asking for one it does not have fails the device setup outright.
	algo="$ZRAM_ALGO"
	if [[ -r /sys/block/zram0/comp_algorithm ]] && ! grep -qw "$algo" /sys/block/zram0/comp_algorithm; then
		warn "zram: $algo unavailable on this kernel -- falling back to lzo"
		algo=lzo
	fi
	size="$(_zram_size_mb)"

	if [[ "$(detect_init)" == systemd ]]; then
		apk_has zram-generator || apk_add zram-generator || { warn "zram: no zram-generator"; return 0; }
		write_if_changed /etc/systemd/zram-generator.conf <<EOF && changed=1
# Managed by root-w3bs-os.sh. Compressed swap in RAM, ahead of any swapfile.
[zram0]
zram-size = $size
compression-algorithm = $algo
swap-priority = 100
fs-type = swap
EOF
	else
		apk_has zram-init || { try "install zram-init" apk_add zram-init || return 0; }
		# The whole file, not an edit: zram-init's shipped default sets up
		# three devices (swap, /tmp, a btrfs scratch), and only the swap one is
		# wanted here.
		write_if_changed /etc/conf.d/zram-init <<EOF && changed=1
# Managed by root-w3bs-os.sh. Compressed swap in RAM, ahead of any swapfile.
load_on_start=yes
unload_on_stop=yes
num_devices=1
type0=swap
flag0=100        # swap priority: ahead of the swapfile
size0=$size      # MiB
mlim0=
back0=
icmp0=
idle0=
wlim0=
notr0=
algo0=$algo
para0=
labl0=zram_swap
uuid0=
args0=
EOF
	fi

	swapon --show=NAME --noheadings 2>/dev/null | grep -qx /dev/zram0 && active=1

	if (( active )) && (( ! changed )); then
		info "zram already active: $(zramctl --noheadings --output DISKSIZE,ALGORITHM /dev/zram0 2>/dev/null | tr -s ' ')"
	elif [[ "$(detect_init)" == systemd ]]; then
		systemctl daemon-reload
		if [[ -b /dev/zram0 ]]; then
			swapoff /dev/zram0 2>/dev/null || true
			echo 1 >/sys/block/zram0/reset 2>/dev/null || true
		fi
		try "zram swap device" systemctl restart systemd-zram-setup@zram0.service || return 0
		note "zram swap (${size}M, $algo) ahead of $SWAP_FILE"
	elif [[ "$(detect_init)" == openrc ]]; then
		svc_enable zram-init boot 2>/dev/null || true
		# zram-init's stop resets the device, which is what a changed size or
		# algorithm needs (a zram0 with a disksize refuses reconfiguration).
		try "zram swap device" svc_restart zram-init || return 0
		note "zram swap (${size}M, $algo) ahead of $SWAP_FILE"
	fi

	write_if_changed /etc/sysctl.d/61-profullstack-zram.conf <<EOF || return 0
# Managed by root-w3bs-os.sh. Overrides the swapfile's conservative swappiness:
# paging to zram is a compress-and-memcpy, not a disk write, so the kernel
# should reach for it early instead of evicting page cache it still wants.
vm.swappiness = $ZRAM_SWAPPINESS
vm.watermark_scale_factor = 125
EOF
	sysctl -q -p /etc/sysctl.d/61-profullstack-zram.conf 2>/dev/null || true
	note "vm.swappiness=$ZRAM_SWAPPINESS (zram is cheap to page to)"
}

log "configuring OOM protection"
try "earlyoom" configure_earlyoom
try "zram" configure_zram

# ------------------------------------------------------------- logrotate ---

# Alpine runs logrotate from /etc/periodic/daily. maxsize only helps if
# logrotate looks more than once a day, so the same script also goes into
# /etc/periodic/hourly; `daily` in a stanza still means daily for every log
# that stays small. Caddy's access logs roll themselves (roll_size in the
# Caddyfile), so they need no stanza here.
LOGROTATE_ENABLE="${LOGROTATE_ENABLE:-1}"
LOGROTATE_MAXSIZE="${LOGROTATE_MAXSIZE:-200M}"
LOGROTATE_KEEP="${LOGROTATE_KEEP:-14}"

configure_logrotate() {
	if [[ -z "$LOGROTATE_ENABLE" || "$LOGROTATE_ENABLE" == 0 ]]; then
		info "logrotate left alone (LOGROTATE_ENABLE=$LOGROTATE_ENABLE)"
		return 0
	fi
	command -v logrotate >/dev/null 2>&1 || { try "install logrotate" apk_add logrotate || return 0; }

	# The messages file busybox syslogd writes is the one log every Alpine box
	# has and nothing caps by size.
	write_if_changed /etc/logrotate.d/w3bs-os-messages <<EOF && note "/var/log/messages rotates daily or past $LOGROTATE_MAXSIZE"
# Managed by root-w3bs-os.sh (LOGROTATE_MAXSIZE, LOGROTATE_KEEP).
/var/log/messages /var/log/root-w3bs-os.log /var/log/w3bs-os-update.log {
    daily
    maxsize $LOGROTATE_MAXSIZE
    missingok
    rotate $LOGROTATE_KEEP
    compress
    delaycompress
    notifempty
    copytruncate
}
EOF

	if [[ "$(detect_init)" == systemd ]]; then
		mkdir -p /etc/systemd/system/logrotate.timer.d
		write_if_changed /etc/systemd/system/logrotate.timer.d/hourly.conf <<'EOF' && { systemctl daemon-reload; note "logrotate runs hourly"; }
# Managed by root-w3bs-os.sh: hourly, so maxsize is checked more than once a day.
[Timer]
OnCalendar=
OnCalendar=hourly
EOF
	else
		install -d -m 0755 /etc/periodic/hourly
		write_if_changed /etc/periodic/hourly/logrotate 0755 <<'EOF' && note "logrotate runs hourly"
#!/bin/sh
# Managed by root-w3bs-os.sh: hourly, so maxsize is checked more than once a day.
exec /usr/sbin/logrotate /etc/logrotate.conf
EOF
		svc_enable crond 2>/dev/null; svc_start crond 2>/dev/null || true
	fi

	# -d parses every config without rotating anything. A broken stanza
	# anywhere in /etc/logrotate.d stops ALL rotation, so say so loudly.
	if ! logrotate -d /etc/logrotate.conf >/dev/null 2>&1; then
		warn "logrotate -d /etc/logrotate.conf reports errors; rotation may be stalled"
	fi
}

# -------------------------------------------------------------- fail2ban ---

# Bans an address that keeps failing SSH logins. Alpine's package ships an
# alpine-ssh.conf jail reading /var/log/messages; this replaces its sshd jail
# with ours in a file that sorts after it: repeat offenders are banned longer each time
# (bantime.increment doubles it, capped at FAIL2BAN_MAXTIME), and the
# addresses that must never be locked out are written into ignoreip.
FAIL2BAN_ENABLE="${FAIL2BAN_ENABLE:-1}"       # 0 leaves fail2ban off the box
FAIL2BAN_BANTIME="${FAIL2BAN_BANTIME:-1h}"    # first ban; doubles on each repeat
FAIL2BAN_MAXTIME="${FAIL2BAN_MAXTIME:-1w}"    # ceiling for the doubling
FAIL2BAN_FINDTIME="${FAIL2BAN_FINDTIME:-10m}"
FAIL2BAN_MAXRETRY="${FAIL2BAN_MAXRETRY:-5}"
# Space-separated addresses or CIDRs that are never banned, on top of loopback,
# the tailnet range and whoever is connected over SSH while this runs. Put the
# boxes you administer from here.
FAIL2BAN_IGNOREIP="${FAIL2BAN_IGNOREIP:-}"

# Addresses logged in over SSH right now: the operator running this script.
# Banning them is a lockout, so they go in ignoreip. "Connected" is not enough:
# a brute-forcer mid-attempt holds an established connection too, and would be
# exempted for good. So a peer counts only if sshd also logged a successful
# login from it (auth.log, or the journal on a box without one).
_fail2ban_ssh_peers() {
	local peer accepted
	[[ -n "${SSH_CLIENT:-}" ]] && printf '%s\n' "${SSH_CLIENT%% *}"
	command -v ss >/dev/null 2>&1 || return 0
	if [[ -f /var/log/auth.log ]]; then
		accepted="$(tail -n 20000 /var/log/auth.log 2>/dev/null)"
	elif [[ -f /var/log/messages ]]; then
		# busybox syslogd, Alpine's default: everything lands in messages
		accepted="$(tail -n 20000 /var/log/messages 2>/dev/null)"
	else
		accepted="$(journalctl -q --no-pager --since -2d -t sshd -t sshd-session 2>/dev/null | tail -n 20000)"
	fi
	accepted="$(printf '%s\n' "$accepted" | sed -n 's/.*Accepted [^ ]* for [^ ]* from \([^ ]*\) port.*/\1/p' | sort -u)"
	[[ -n "$accepted" ]] || return 0
	ss -tnH state established "( sport = :${SSH_PORT:-22} )" 2>/dev/null \
		| awk '{print $4}' | while read -r peer; do
			peer="${peer%:*}"; peer="${peer#[}"; peer="${peer%]}"
			[[ -n "$peer" ]] && grep -qxF -- "$peer" <<<"$accepted" && printf '%s\n' "$peer"
		done
	return 0
}

# ignoreip, deduplicated: loopback, the tailnet, the operator's list, and the
# SSH peers connected right now.
_fail2ban_ignoreip() {
	local list
	# shellcheck disable=SC2086,SC2046  # both are space-separated lists, split on purpose
	list="$(printf '%s\n' 127.0.0.1/8 ::1 100.64.0.0/10 $FAIL2BAN_IGNOREIP $(_fail2ban_ssh_peers) \
		| awk 'NF && !seen[$0]++' | tr '\n' ' ')"
	printf '%s' "${list% }"
}

configure_fail2ban() {
	local changed=0 ignore backend

	if [[ -z "$FAIL2BAN_ENABLE" || "$FAIL2BAN_ENABLE" == 0 ]]; then
		info "fail2ban disabled (FAIL2BAN_ENABLE=$FAIL2BAN_ENABLE)"
		return 0
	fi

	if ! apk_has fail2ban; then
		try "install fail2ban" apk_add fail2ban || return 0
	fi

	ignore="$(_fail2ban_ignoreip)"

	# Where sshd's lines land. busybox syslogd writes /var/log/messages (what
	# Alpine's own jail reads); rsyslog may give an auth.log; a systemd box may
	# have only the journal. The stock sshd filter matches the line format in
	# all three, so only the source changes.
	local logpath="" banaction
	backend=auto
	if [[ -f /var/log/auth.log ]]; then
		logpath=/var/log/auth.log
	elif [[ -f /var/log/messages ]] || [[ "$(detect_init)" != systemd ]]; then
		logpath=/var/log/messages
		# syslog has to be running for there to be anything to read
		svc_enable syslog boot 2>/dev/null; svc_start syslog 2>/dev/null || true
	else
		backend=systemd
	fi
	# ufw drives iptables(-nft); fail2ban's own iptables actions sit beside
	# its chains without touching them.
	banaction=iptables-multiport

	mkdir -p /etc/fail2ban/jail.d
	write_if_changed /etc/fail2ban/jail.d/zz-root-w3bs-os.local <<EOF && changed=1
# Managed by root-w3bs-os.sh (FAIL2BAN_*). Loaded after alpine-ssh.conf.
[DEFAULT]
ignoreip = $ignore
bantime = $FAIL2BAN_BANTIME
findtime = $FAIL2BAN_FINDTIME
maxretry = $FAIL2BAN_MAXRETRY
bantime.increment = true
bantime.maxtime = $FAIL2BAN_MAXTIME
banaction = $banaction

[sshd]
enabled = true
port = ${SSH_PORT:-22}
backend = $backend
${logpath:+logpath = $logpath}
EOF
	svc_enable fail2ban 2>/dev/null || true
	[[ "$(detect_init)" == none ]] && { info "no init -- fail2ban configured, not started"; return 0; }

	if (( changed )) || ! svc_is_active fail2ban; then
		try "fail2ban" svc_restart fail2ban || return 0
		note "fail2ban guarding sshd (ban $FAIL2BAN_BANTIME, doubling to $FAIL2BAN_MAXTIME; never: $ignore)"
	else
		info "fail2ban already guarding sshd"
	fi

	# A jail that failed to load leaves the service running and nothing banned.
	# The socket takes a moment after a restart, so wait before calling it.
	local i
	for i in 1 2 3 4 5 6 7 8 9 10; do
		fail2ban-client status sshd >/dev/null 2>&1 && return 0
		sleep "${FAIL2BAN_WAIT:-1}"
	done
	warn "fail2ban is running but the sshd jail is not loaded: fail2ban-client status sshd"
}

log "configuring log rotation"
try "logrotate" configure_logrotate

log "configuring fail2ban"
try "fail2ban" configure_fail2ban

# (root-ubuntu.sh quiets networkd-dispatcher here. Alpine has no systemd-networkd
# and so no dispatcher: nothing to port.)

# ------------------------------------------------------------------ motd ---

# Fetched into a cache file; login just cats it, so a slow/dead endpoint can
# never hang an ssh login. Alpine prints /etc/motd itself (sshd PrintMotd);
# ours comes from /etc/profile.d, which every login shell reads -- zsh too,
# through Alpine's /etc/zsh/zprofile.
install_motd() {
	local units_changed=0
	write_if_changed /usr/local/bin/profullstack-motd 0755 <<EOF && note "motd refresher"
#!/bin/sh
# refresh the cached motd from ${MOTD_URL}
umask 022
tmp="\$(mktemp)" || exit 0
if curl -fsSL --max-time 10 '${MOTD_URL}' -o "\$tmp" && [ -s "\$tmp" ]; then
	mv "\$tmp" '${MOTD_CACHE}'
else
	rm -f "\$tmp"
fi
EOF

	install -d -m 0755 /etc/profile.d
	write_if_changed /etc/profile.d/99-profullstack-motd.sh 0644 <<EOF
# managed by root-w3bs-os.sh -- the cached profullstack motd, at login only
case "\$-" in *i*) [ -s '${MOTD_CACHE}' ] && cat '${MOTD_CACHE}' ;; esac
EOF

	if [[ "$(detect_init)" == systemd ]]; then
		write_if_changed /etc/systemd/system/profullstack-motd.service <<'EOF' && units_changed=1
[Unit]
Description=Refresh the profullstack motd
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/profullstack-motd
EOF
		write_if_changed /etc/systemd/system/profullstack-motd.timer <<'EOF' && units_changed=1
[Unit]
Description=Refresh the profullstack motd daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
		[[ "$units_changed" == 1 ]] && { systemctl daemon-reload; note "motd timer units"; }
		systemctl is-enabled profullstack-motd.timer >/dev/null 2>&1 \
			|| systemctl enable --now profullstack-motd.timer
	else
		# busybox crond runs /etc/periodic/daily at 02:00. run-parts skips
		# names with a dot, so the link is named without one.
		install -d -m 0755 /etc/periodic/daily
		if [[ "$(readlink /etc/periodic/daily/profullstack-motd 2>/dev/null)" != /usr/local/bin/profullstack-motd ]]; then
			ln -sfn /usr/local/bin/profullstack-motd /etc/periodic/daily/profullstack-motd
			note "motd refreshes daily (/etc/periodic/daily)"
		fi
		svc_enable crond 2>/dev/null; svc_start crond 2>/dev/null || true
	fi

	# populate the cache now so the very first login already shows it
	/usr/local/bin/profullstack-motd
	[[ -s "$MOTD_CACHE" ]] || { warn "could not fetch ${MOTD_URL} (will retry daily)"; return 1; }
	return 0
}

log "configuring motd from ${MOTD_URL}"
try "motd" install_motd

# --------------------------------------------------------------- dotfiles ---

# Plain copies. .tmux.conf / .irssi are handled by their own installers below.
DOTFILES=(
	.zshrc .zshenv .zsh_aliases
	.bashrc .bash_profile .bash_aliases .bash_aliases_linux .bash_env .bash_env_linux
	.vimrc .ackrc .htoprc .gitconfig .screenrc
)

install_ssh() {
	local home="$1" owner="$2" f
	local src=""
	[[ -n "$DOTFILES_DIR" && -d "$DOTFILES_DIR/.ssh" ]] && src="$DOTFILES_DIR/.ssh"

	# NOT gated on there being a dotfiles tree. This function does two separate
	# jobs -- authorise the key filed for this account, and install the ssh
	# config that came with the dotfiles -- and only the second one needs a
	# checkout. Returning early when there is no $src (which is what an earlier
	# version did) meant a box with no dotfiles repo silently authorised nobody,
	# so accounts were created that could not log in.
	[[ -d "$home/.ssh" ]] || install -d -m 0700 -o "$owner" -g "$owner" "$home/.ssh"

	# authorized_keys belongs to the user. FULL STOP.
	#
	# This used to merge the repo's own .ssh/authorized_keys -- the admin's
	# keys -- into every account on every run, and rewrite the file with
	# sort -u while it was at it. That is not this script's file to edit:
	# who may log in as someone is their decision, re-adding keys they have
	# removed defeats the point of removing them, and rewriting the file at
	# all risks the access it is supposed to protect.
	#
	# The ONLY thing written here is an explicit per-user key you have put in
	# ssh-keys/<login>.pub, appended if it is not already present. No file in
	# ssh-keys means nothing is touched.
	local ukey="$KEYS_DIR/$owner.pub"
	if [[ -s "$ukey" ]]; then
		local ak="$home/.ssh/authorized_keys" keydata
		# compare on the key body, so a changed comment is not a new key
		keydata="$(awk '{print $1" "$2}' "$ukey" | head -1)"
		if [[ -s "$ak" ]] && awk '{print $1" "$2}' "$ak" | grep -qxF "$keydata"; then
			: # already authorised
		else
			# append on a line of its own: if the existing file has no trailing
			# newline, a bare >> would graft this key onto the last one and
			# destroy both
			[[ -s "$ak" && -n "$(tail -c1 "$ak" 2>/dev/null)" ]] && printf '\n' >>"$ak"
			cat "$ukey" >>"$ak"
			note "authorised ssh-keys/$owner.pub for $owner"
		fi
		chown "$owner:$owner" "$ak" 2>/dev/null
		chmod 0600 "$ak" 2>/dev/null
	fi

	# Everything below comes OUT of a dotfiles checkout, so it only runs when
	# there is one. Without it the account keeps whatever ssh config it had,
	# which is the right answer -- this script has no config of its own to put
	# there and inventing one would overwrite theirs with nothing.
	if [[ -n "$src" ]]; then
		# ~/.ssh/config is personal (host aliases, ProxyJump, per-host keys), so
		# it gets the same treatment as any other dotfile: ours until they edit it.
		install_managed "$src/config" "$home/.ssh/config" "$owner" 0600 .ssh/config

		# known_hosts is append-only by nature -- overwriting it throws away every
		# host the user has accepted since, and then ssh starts asking again.
		if [[ -s "$src/known_hosts" ]]; then
			touch "$home/.ssh/known_hosts"
			if ! sort -u "$src/known_hosts" "$home/.ssh/known_hosts" \
				| cmp -s - "$home/.ssh/known_hosts"; then
				sort -u "$src/known_hosts" "$home/.ssh/known_hosts" \
					>"$home/.ssh/known_hosts.new" \
					&& mv "$home/.ssh/known_hosts.new" "$home/.ssh/known_hosts"
			fi
		fi

		# Handing your own private keys to other accounts is never something to
		# do by accident, so there is no prompt for it -- it happens only if
		# COPY_SSH_PRIVATE_KEYS=1 is set in the environment on purpose, and even
		# then never over a key the user already has.
		if [[ "$COPY_SSH_PRIVATE_KEYS" == 1 ]]; then
			warn "COPY_SSH_PRIVATE_KEYS=1: copying $src's PRIVATE keys into $home/.ssh"
			for f in "$src"/id_*; do
				[[ -f "$f" && ! -e "$home/.ssh/$(basename "$f")" ]] \
					&& cp -f "$f" "$home/.ssh/$(basename "$f")"
			done
		fi
	fi

	# Permissions only, and only on what we may have created. sshd StrictModes
	# needs 0700 on ~/.ssh and 0600 on private files, but chown -R over the
	# whole directory would also rewrite files this script never wrote.
	chmod 0700 "$home/.ssh"
	chown "$owner:$owner" "$home/.ssh"
	[[ -e "$home/.ssh/authorized_keys" ]] && chmod 0600 "$home/.ssh/authorized_keys"
	return 0
}

# oh-my-tmux. The .tmux.conf vendored in this repo is an OLD oh-my-tmux with no
# tpm support, while our .tmux.conf.local sets '@plugin tmux-yank' -- so the
# plugin never loaded. Clone upstream and keep only our .local overrides, which
# is the layout oh-my-tmux actually supports.
install_tmux() {
	local home="$1" owner="$2"

	# This clones two repos AS the owner and then runs tpm's installer. For a
	# tenant that is host-side code execution under their own uid, off the back
	# of files they control -- exactly what they are in a container to avoid.
	# oh-my-tmux is installed inside their instance instead.
	_is_tenant "$owner" && return 0

	# a ~/.tmux that is not our checkout is the user's own tmux setup; leave
	# the whole thing alone rather than half-converting it to oh-my-tmux
	if [[ -d "$home/.tmux" && ! -d "$home/.tmux/.git" ]]; then
		info "$owner has their own ~/.tmux -- left alone"
		return 0
	fi

	if clone_or_pull "$owner" https://github.com/gpakosz/.tmux.git "$home/.tmux"; then
		# only (re)point the symlink -- if the user replaced ~/.tmux.conf with
		# a real file of their own, that is their config now
		if [[ -L "$home/.tmux.conf" || ! -e "$home/.tmux.conf" ]]; then
			as_user "$owner" "ln -sfn '$home/.tmux/.tmux.conf' '$home/.tmux.conf'"
		else
			info "$owner has their own ~/.tmux.conf -- left alone"
		fi
	elif [[ -n "$DOTFILES_DIR" && -f "$DOTFILES_DIR/.tmux.conf" ]]; then
		warn "oh-my-tmux clone failed -- falling back to the dotfiles .tmux.conf"
		install_managed "$DOTFILES_DIR/.tmux.conf" "$home/.tmux.conf" "$owner" 0644 .tmux.conf
	else
		warn "no tmux config available for $owner"
		return 1
	fi

	# .tmux.conf.local is THE file oh-my-tmux expects you to customise, so it
	# is the one most likely to have been edited. install_managed keeps theirs.
	[[ -n "$DOTFILES_DIR" ]] \
		&& install_managed "$DOTFILES_DIR/.tmux.conf.local" "$home/.tmux.conf.local" \
			"$owner" 0644 .tmux.conf.local

	# our .tmux.conf.local enables tpm plugins; pre-seed tpm so the first
	# tmux launch works even with no network.
	if [[ -f "$home/.tmux.conf.local" ]] \
		&& grep -qE '^[[:space:]]*set -g @plugin' "$home/.tmux.conf.local"; then
		clone_or_pull "$owner" https://github.com/tmux-plugins/tpm.git \
			"$home/.tmux/plugins/tpm" || warn "tpm clone failed for $owner"
		as_user "$owner" "'$home/.tmux/plugins/tpm/bin/install_plugins' >/dev/null 2>&1" || true
	fi

	chown -h "$owner:$owner" "$home/.tmux.conf" 2>/dev/null
	chown -R "$owner:$owner" "$home/.tmux" "$home/.tmux.conf.local" 2>/dev/null
	return 0
}

# irssi: configs + perl scripts. autorun/ holds relative symlinks into
# scripts/, so copy with -a to keep them intact.
install_irssi() {
	local home="$1" owner="$2" f
	[[ -n "$DOTFILES_DIR" ]] || return 0
	local src="$DOTFILES_DIR/.irssi"
	[[ -d "$src" ]] || return 0

	install -d -m 0700 -o "$owner" -g "$owner" "$home/.irssi"
	# irssi rewrites its own config on /save -- servers, channels, nickserv
	# passwords. Clobbering it on a re-run would sign people out of their
	# networks, so these are managed files like any other.
	install_managed "$src/config"        "$home/.irssi/config"        "$owner" 0600 .irssi/config
	install_managed "$src/config-tor"    "$home/.irssi/config-tor"    "$owner" 0600 .irssi/config-tor
	install_managed "$src/default.theme" "$home/.irssi/default.theme" "$owner" 0644 .irssi/default.theme

	# scripts/ is ours: perl we ship, plus autorun/ symlinks into it. -a keeps
	# the symlinks; -u leaves anything the user has since made newer.
	[[ -d "$src/scripts" ]] && cp -au "$src/scripts" "$home/.irssi/"

	chown -R "$owner:$owner" "$home/.irssi"
	return 0
}

# oh-my-zsh. KEEP_ZSHRC is essential -- the installer would otherwise replace
# the .zshrc we just installed with its template.
# A ~/.oh-my-zsh with no oh-my-zsh.sh and no .git is wreckage from a run that
# failed partway: the plugin mkdir below builds the tree even when the
# installer died. The installer then refuses to touch an existing $ZSH folder
# ("The $ZSH folder already exists"), so the account can never heal itself --
# which is how one bad run left ubuntu without oh-my-zsh permanently.
#
# custom/ is the only part worth keeping: it is where a user's own themes and
# plugins live. Salvage it, clear the rest, let the installer run.
_repair_partial_omz() {
	local login="$1" home="$2"
	[[ -d "$home/.oh-my-zsh" ]] || return 0
	[[ -f "$home/.oh-my-zsh/oh-my-zsh.sh" ]] && return 0
	[[ -d "$home/.oh-my-zsh/.git" ]] && return 0

	warn "$login has a half-installed ~/.oh-my-zsh -- repairing"
	rm -rf "$home/.oh-my-zsh.salvage"
	[[ -d "$home/.oh-my-zsh/custom" ]] \
		&& mv "$home/.oh-my-zsh/custom" "$home/.oh-my-zsh.salvage"
	rm -rf "$home/.oh-my-zsh"
	return 0
}

_restore_omz_custom() {
	local login="$1" home="$2"
	[[ -d "$home/.oh-my-zsh.salvage" ]] || return 0
	if [[ -d "$home/.oh-my-zsh" ]]; then
		install -d -m 0755 -o "$login" -g "$login" "$home/.oh-my-zsh/custom"
		# -n: never overwrite what the fresh install just put there
		cp -an "$home/.oh-my-zsh.salvage/." "$home/.oh-my-zsh/custom/" 2>/dev/null
		rm -rf "$home/.oh-my-zsh.salvage"
		chown -R "$login:$login" "$home/.oh-my-zsh"
	fi
	return 0
}

install_omz() {
	local login="$1" home; home="$(user_home "$login")"

	_repair_partial_omz "$login" "$home"

	if [[ ! -f "$home/.oh-my-zsh/oh-my-zsh.sh" ]]; then
		# Do not abort on a non-zero exit here: the installer can clone
		# ~/.oh-my-zsh successfully and still fail on a later step, and
		# bailing out skipped the plugin clones below -- which is exactly how
		# 'plugin zsh-autosuggestions not found' survived a "successful" run.
		# ZSH= and ZDOTDIR= are pinned, not left to the environment: the
		# installer prefers whatever it finds there over $HOME, and getting
		# that wrong clones into somebody else's home. as_user already starts
		# from a clean environment; this keeps it right even if that changes.
		as_user "$login" "ZSH='$home/.oh-my-zsh' ZDOTDIR='$home' RUNZSH=no CHSH=no KEEP_ZSHRC=yes sh -c \"\$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)\"" \
			|| warn "oh-my-zsh installer exited non-zero for $login -- checking result anyway"
	elif [[ -d "$home/.oh-my-zsh/.git" ]]; then
		# already installed: this run is an update. Reset rather than pull --
		# omz is a full clone people sometimes edit in place, and a dirty tree
		# would make every future run fail on "local changes would be lost".
		#
		# FETCH_HEAD, not origin/HEAD: the omz installer sets the repo up with
		# git init + remote add + a shallow fetch, which leaves no
		# refs/remotes/origin/HEAD on the git in 22.04/24.04.
		as_user "$login" "git -C '$home/.oh-my-zsh' fetch --quiet --depth 1 origin HEAD \
			&& git -C '$home/.oh-my-zsh' reset --quiet --hard FETCH_HEAD" \
			|| warn "could not update oh-my-zsh for $login"
	fi

	_restore_omz_custom "$login" "$home"

	local rc=0 pdir="$home/.oh-my-zsh/custom/plugins"
	if [[ ! -f "$home/.oh-my-zsh/oh-my-zsh.sh" ]]; then
		warn "oh-my-zsh missing for $login"
		rc=1
	fi

	# external plugins our .zshrc references. Verify afterwards rather than
	# trusting the clone: a missing plugin only shows up as an [oh-my-zsh]
	# warning at login, long after this script has said it succeeded.
	as_user "$login" "mkdir -p '$pdir'"

	clone_or_pull "$login" https://github.com/zsh-users/zsh-autosuggestions.git \
		"$pdir/zsh-autosuggestions" || true
	if [[ ! -f "$pdir/zsh-autosuggestions/zsh-autosuggestions.plugin.zsh" ]]; then
		warn "zsh-autosuggestions missing for $login (plugins=() in .zshrc references it)"
		rc=1
	fi

	clone_or_pull "$login" https://github.com/lukechilds/zsh-nvm.git "$home/.zsh-nvm" || true
	if [[ ! -f "$home/.zsh-nvm/zsh-nvm.plugin.zsh" ]]; then
		warn "zsh-nvm missing for $login (.zshrc sources it)"
		rc=1
	fi

	chown -R "$login:$login" "$home/.oh-my-zsh" "$home/.zsh-nvm" 2>/dev/null
	return $rc
}

install_dotfiles() {
	local home="$1" owner="$2" f
	[[ -d "$home" ]] || { warn "no home dir $home"; return 1; }

	if [[ -n "$DOTFILES_DIR" ]]; then
		for f in "${DOTFILES[@]}"; do
			# install_managed handles "not there", "same file" (repo cloned to
			# /root) and "the user has since edited it"
			install_managed "$DOTFILES_DIR/$f" "$home/$f" "$owner" 0644 "$f"
		done
	fi

	# These three run either way. install_ssh authorises the account's own key,
	# and install_tmux installs oh-my-tmux from upstream -- neither needs a
	# dotfiles checkout, and skipping them without one is how an account ends up
	# provisioned but unable to log in.
	install_ssh   "$home" "$owner"
	install_tmux  "$home" "$owner"
	install_irssi "$home" "$owner"
}

# chsh refuses any shell that is not listed in /etc/shells, and it fails
# quietly enough to leave a user on bash. Register zsh, switch, then confirm
# from the passwd entry rather than trusting the exit status.
ensure_zsh_shell() {
	local login="$1" zsh_bin actual
	zsh_bin="$(command -v zsh)" || { warn "zsh is not installed"; return 1; }
	grep -qxF "$zsh_bin" /etc/shells 2>/dev/null || echo "$zsh_bin" >>/etc/shells

	actual="$(getent passwd "$login" | cut -d: -f7)"
	[[ "$actual" == "$zsh_bin" ]] && return 0

	# Only convert from the distro defaults -- on Alpine that is busybox ash
	# (/bin/ash, and /bin/sh for accounts made with adduser). If someone has
	# deliberately moved to fish or dash, a maintenance run has no business
	# dragging them back -- that is precisely the kind of "it broke my account"
	# a re-run must avoid.
	case "$actual" in
		*/zsh) return 0 ;;
		*/bash|*/sh|*/ash|"") ;;
		*) info "$login chose $actual as their shell -- left alone"; return 0 ;;
	esac

	chsh -s "$zsh_bin" "$login" 2>/dev/null || warn "chsh failed for $login"
	actual="$(getent passwd "$login" | cut -d: -f7)"
	[[ "$actual" == "$zsh_bin" ]] || { warn "$login login shell is $actual, not $zsh_bin"; return 1; }
	note "$login login shell -> zsh"
	return 0
}

# sshd runs with StrictModes yes by default and silently IGNORES
# authorized_keys when the home or .ssh is writable by group or other -- giving
# the same "Permission denied" as having no key at all, which is miserable to
# debug. Caddy separately needs to traverse the home to reach public_html. So the
# target is: owned by the user, group/other write stripped, o+x kept.
fix_home_permissions() {
	local home="$1" login="$2" oct
	[[ -d "$home" ]] || { warn "no home dir $home"; return 1; }

	chown "$login:$login" "$home"
	if _confine_on; then
		_confine_home_mode "$home" "$login"
	else
		chmod g-w,o-w "$home"
		chmod o+x "$home"
	fi

	if [[ -d "$home/.ssh" ]]; then
		chown -R "$login:$login" "$home/.ssh"
		chmod 0700 "$home/.ssh"
		find "$home/.ssh" -type f ! -name '*.pub' -exec chmod 0600 {} +
		find "$home/.ssh" -type f -name '*.pub' -exec chmod 0644 {} +
	fi

	# Caddy (user caddy) has to be able to read these. a+rX adds what it needs
	# without flattening modes the user set deliberately -- a blanket 0644
	# would, for instance, strip the +x off anything they keep in there.
	if [[ -d "$home/public_html" ]]; then
		chown -R "$login:$login" "$home/public_html"
		chmod -R a+rX,go-w "$home/public_html"
	fi
	# ~/share holds symlinks to /mnt mountpoints (_share_link). Someone who
	# publishes ~/public_html/done -> ~/share/seed means for Caddy to follow it,
	# and no x here breaks that whatever the mountpoint allows. Hand the x to
	# $WEB_GROUP rather than to the world: Caddy is the only thing that needs to
	# walk through. No r, so it still cannot list which shares exist, and what
	# may actually be reached is still decided in /mnt.
	#
	# Only the shortcut directory itself -- never the mounts under it, which
	# would push a chmod out over NFS.
	if [[ -d "$home/share" ]] && getent group "$WEB_GROUP" >/dev/null; then
		chgrp "$WEB_GROUP" "$home/share" && chmod 0710 "$home/share"
	fi

	# Dev apps: only open up what is actually published. An app is published
	# when it has a public/ or a .port -- everything else under ~/apps is
	# private work that Caddy never serves and must stay that way.
	if [[ -d "$home/apps" ]]; then
		chmod o+x "$home/apps"
		for _app in "$home"/apps/*/; do
			[[ -d "$_app" ]] || continue
			[[ -d "$_app/public" || -f "$_app/.port" ]] || continue
			chmod o+x "$_app"
			[[ -d "$_app/public" ]] && chmod -R a+rX "$_app/public"
		done
		unset _app
	fi

	# report, and complain if sshd would still refuse the keys
	oct="$(stat -c '%a' "$home")"
	info "$home  mode=$oct owner=$(stat -c '%U:%G' "$home")"
	if (( (8#$oct & 8#022) != 0 )); then
		warn "$home is group/other writable -- sshd StrictModes will ignore authorized_keys"
		return 1
	fi
	if [[ "$(stat -c '%U' "$home")" != "$login" ]]; then
		warn "$home is not owned by $login -- sshd StrictModes will ignore authorized_keys"
		return 1
	fi
	return 0
}

install_mise() { as_user "$1" 'curl -fsSL https://mise.run | sh'; }

# The catalog tools, each through `w3bs install <id>` for the account (see
# w3bs_tool): one receipt per tool per account, `w3bs update` keeps them
# current, and the publisher's curl installer is only the fallback for a box
# where w3bs cannot be used. Re-running either path is the supported update.

# moshcode itself. The installer replaces ~/.moshcode/pkg wholesale, which is
# what heals a partial install.
install_moshcode() {
	w3bs_tool "$1" "$W3BS_ID_MOSHCODE" 'curl -fsSL https://moshcode.sh/install.sh | sh'
}

# The ThreatCrush security-agent CLI. This installs the CLI only: the daemon
# that actually enforces is ONE per box, as root -- see
# enable_threatcrush_daemon.
install_threatcrush() {
	w3bs_tool "$1" "$W3BS_ID_THREATCRUSH" 'curl -fsSL https://threatcrush.com/install.sh | sh'
}

# hqterm + hqsh (https://hqterm.sh): `hqterm connect HOST` reaches a box over
# plain ssh, which runs `hqsh server attach` here. There is no service, port or
# unit to manage, so a per-login install is all a box needs. The catalog
# package carries both commands.
install_hqsh() {
	# hqsh 0.3+ runs each session as a systemd user unit, which logind stops at
	# the user's last logout unless lingering is on. Only meaningful under
	# systemd; under OpenRC the per-user daemon is a plain process and nothing
	# stops it at logout.
	if [[ "$(detect_init)" == systemd ]] && command -v loginctl >/dev/null 2>&1 \
		&& [[ ! -e "${SYSTEMD_LINGER_DIR:-/var/lib/systemd/linger}/$1" ]]; then
		loginctl enable-linger "$1" 2>/dev/null && note "lingering on for $1 (hqsh sessions survive logout)"
	fi
	w3bs_tool "$1" "$W3BS_ID_HQTERM" 'curl -fsSL https://hqterm.sh/install | sh -s -- --server --bin="$HOME/.local/bin"'
}

# sh1pt (https://sh1pt.com), opt-in with --with-sh1pt.
install_sh1pt() {
	w3bs_tool "$1" "$W3BS_ID_SH1PT" 'curl -fsSL https://sh1pt.com/install.sh | sh'
}

# Enables the ONE per-box enforcing daemon, as root. `threatcrush
# install-service` writes a systemd unit, so this runs only where systemd is
# the init; on OpenRC it is skipped and said so, rather than half-installed.
# No-ops if threatcrush is absent, so a failed install never breaks
# provisioning.
enable_threatcrush_daemon() {
	if [[ "$(detect_init)" != systemd ]]; then
		info "threatcrush daemon: its installer writes a systemd unit -- not enabled under $(detect_init)"
		return 0
	fi
	as_user root 'PATH="$HOME/.local/bin:$PATH"; command -v threatcrush >/dev/null 2>&1 && threatcrush install-service'
}

# ...and this updates the engines and workflow CLIs moshcode manages.
#
# The two are NOT the same command, which is the trap. The wrapper at
# ~/.local/bin/moshcode intercepts `upgrade` and re-runs the installer, so
# `moshcode upgrade` only ever refreshes moshcode/node/bun and reports
# "Update complete" -- while gh, supabase, doctl and friends quietly rot. The
# CLI's real upgrade, the one that walks the installed tools, is reachable
# only by calling bin/moshcode.mjs directly.
#
# node comes from mise and is not on the default PATH, so the shims directory
# has to be prepended exactly as the wrapper does.
update_moshcode_tools() {
	local login="$1" home out failed rc=0
	home="$(user_home "$login")"
	[[ -f "$home/.moshcode/pkg/bin/moshcode.mjs" ]] || return 0

	out="$(as_user "$login" \
		"PATH=\"\$HOME/.local/share/mise/shims:\$HOME/.local/bin:\$PATH\" \
		 node '$home/.moshcode/pkg/bin/moshcode.mjs' upgrade" 2>&1)"

	# show the per-tool lines, not the whole download log
	printf '%s\n' "$out" | grep -aE '^(⬆|✓ upgraded|✗ upgraded)' | sed 's/^/        /'

	# tailscale is the expected casualty: `tailscale update` refuses to run as
	# anyone but root, and on this box tailscale comes from apk and is
	# upgraded by the system upgrade anyway. Failing the whole step over it would mean
	# every run ends with a red mark nobody can act on.
	failed="$(printf '%s\n' "$out" | grep -a 'failed:' \
		| sed 's/.*failed: //; s/🤘.*//' \
		| tr ',' '\n' | tr -d ' ' | grep -v '^$' | grep -vx tailscale)"

	# Reported, never fatal. moshcode installs from the tip of main, so the box
	# tracks whatever is on that branch -- including half-finished refactors,
	# where a tool this ran fine against yesterday becomes an "unknown upgrade
	# target" today. None of that is something this script can act on, and a
	# provisioned box is not broken because a third-party updater had a bad
	# day. Same call as tailscale, for the same reason.
	if [[ -n "$failed" ]]; then
		warn "$login: moshcode could not upgrade: $(printf '%s' "$failed" | tr '\n' ' ')"
		info "      (moshcode tracks moshcoder/moshcode@main -- retry later, or pin MOSHCODE_REF)"
	fi
	return 0
}

# ------------------------------------------------------------- ssh agent ---

# One ssh-agent per user, on a socket path that is the same at every login.
#
# Why not a line in .zshrc that starts one: the usual snippet ("start an agent
# if $SSH_AUTH_SOCK looks dead") starts a NEW agent per shell, so every tmux
# pane and every reconnect gets its own, a key added in one is invisible to the
# next, and the dead ones pile up until reboot.
#
# Under systemd it is a user unit, enabled --global, exactly as root-ubuntu.sh
# does it. Under OpenRC there is no user manager, so it is the login shell's
# job -- but with the property that matters kept: ONE agent per account, on a
# fixed socket (~/.ssh/agent.sock), started by whichever login finds none
# alive and found by every login after it. Nothing stops it at logout (there
# is no logind to), which is the lingering root-ubuntu.sh turns on by hand.
#
# NOTHING here loads a key. Use `ssh-add` on first login, or AddKeysToAgent in
# your own ~/.ssh/config.
install_ssh_agent() {
	local agent unit=/etc/systemd/user/ssh-agent.service
	local snippet=/etc/profile.d/ssh-agent.sh

	agent="$(command -v ssh-agent)" || { apk_add openssh-client-default >/dev/null 2>&1; agent="$(command -v ssh-agent)"; } \
		|| { warn "ssh-agent is not installed"; return 1; }
	install -d -m 0755 /etc/profile.d

	if [[ "$(detect_init)" == systemd ]]; then
		install -d -m 0755 /etc/systemd/user
		write_if_changed "$unit" <<-EOF && note "ssh-agent user unit"
			# managed by root-w3bs-os.sh
			[Unit]
			Description=SSH authentication agent
			Documentation=man:ssh-agent(1)

			[Service]
			Type=simple
			Environment=SSH_AUTH_SOCK=%t/ssh-agent.socket
			ExecStartPre=-/bin/rm -f %t/ssh-agent.socket
			ExecStart=$agent -D -a %t/ssh-agent.socket
			Restart=on-failure
			RestartSec=2

			[Install]
			WantedBy=default.target
		EOF
		systemctl --global enable ssh-agent.service >/dev/null 2>&1 \
			|| warn "could not enable ssh-agent.service globally"
		write_if_changed "$snippet" <<-'EOF' && note "ssh-agent profile snippet"
			# managed by root-w3bs-os.sh -- point this shell at the systemd ssh-agent.
			if [ -z "${SSH_AUTH_SOCK:-}" ] || [ ! -S "${SSH_AUTH_SOCK:-}" ]; then
			    _agent_sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/ssh-agent.socket"
			    if [ -S "$_agent_sock" ]; then
			        SSH_AUTH_SOCK="$_agent_sock"
			        export SSH_AUTH_SOCK
			    fi
			    unset _agent_sock
			fi
		EOF
		return 0
	fi

	# OpenRC (or no init): the login shell keeps one agent per account alive.
	# POSIX sh on purpose -- Alpine's /etc/profile sources it for ash and bash,
	# and zsh reads /etc/profile through /etc/zsh/zprofile.
	write_if_changed "$snippet" <<-'EOF' && note "ssh-agent profile snippet (one agent per account)"
		# managed by root-w3bs-os.sh -- one long-lived ssh-agent per account.
		#
		# An inherited, working SSH_AUTH_SOCK is left alone: it is usually a
		# forwarded one (ssh -A), and replacing it would swap the keys you
		# brought for the ones on this box. Set-but-dead (a reattached tmux) is
		# fair game. ssh-add -l exits 2 only when it cannot reach an agent.
		if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
		    if [ -z "${SSH_AUTH_SOCK:-}" ] || [ ! -S "${SSH_AUTH_SOCK:-}" ]; then
		        _agent_sock="$HOME/.ssh/agent.sock"
		        SSH_AUTH_SOCK="$_agent_sock"
		        export SSH_AUTH_SOCK
		        ssh-add -l >/dev/null 2>&1
		        if [ $? -eq 2 ]; then
		            [ -d "$HOME/.ssh" ] || mkdir -m 0700 "$HOME/.ssh" 2>/dev/null
		            rm -f "$_agent_sock"
		            ssh-agent -a "$_agent_sock" >/dev/null 2>&1
		        fi
		        unset _agent_sock
		    fi
		fi
	EOF
	return 0
}

# Under systemd, the user manager stops when the last session ends and takes
# the agent with it unless lingering is on. Under OpenRC the agent above is a
# plain process and outlives the session on its own.
enable_ssh_agent_for() {
	local login="$1"
	[[ "$(detect_init)" == systemd ]] || return 0
	command -v loginctl >/dev/null || return 0
	[[ "$(loginctl show-user "$login" -p Linger --value 2>/dev/null)" == yes ]] && return 0
	loginctl enable-linger "$login" >/dev/null 2>&1 \
		|| { warn "could not enable linger for $login"; return 1; }
	note "$login: ssh-agent now persists between logins"
	return 0
}

# ------------------------------------------------------------- tailscale ---

# Joining a tailnet needs a credential. With TS_AUTHKEY it is unattended;
# without one, tailscale up prints a URL to approve in a browser -- so this
# reports what to run rather than hanging on an interactive login. Alpine
# packages tailscale (community), so it is apk, not the curl installer.
install_tailscale() {
	if ! command -v tailscale >/dev/null; then
		apk_add tailscale || return 1
		note "installed tailscale"
	fi
	svc_enable tailscale 2>/dev/null || true
	if [[ "$(detect_init)" == none ]]; then
		info "no init -- tailscaled is installed but not started"
		return 0
	fi
	# a container needs /dev/net/tun handed to it; without one tailscaled
	# cannot start and that is the runtime's call, not ours
	if [[ ! -c /dev/net/tun ]]; then
		warn "no /dev/net/tun -- tailscaled cannot run here (docker run --device /dev/net/tun)"
		return 1
	fi
	svc_start tailscale 2>/dev/null || { warn "tailscaled would not start"; return 1; }

	# tailscale ip only succeeds once the node is actually logged in
	if tailscale ip -4 >/dev/null 2>&1; then
		info "already on the tailnet as $(tailscale ip -4 | head -1)"
	elif [[ -n "$TS_AUTHKEY" ]]; then
		tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" \
			|| { warn "tailscale up failed (bad or expired auth key?)"; return 1; }
	else
		warn "not joined to a tailnet: no TS_AUTHKEY set"
		info "  unattended:  doas env TS_AUTHKEY=tskey-auth-... $0"
		info "  or by hand:  doas tailscale up --hostname=$TS_HOSTNAME"
		return 1
	fi

	# Tailnet traffic is trusted; without this the default deny-incoming
	# policy drops it. 41641/udp lets peers connect directly instead of
	# relaying through DERP.
	_ufw_rule allow in on tailscale0
	_ufw_rule allow 41641/udp
	return 0
}

# ----------------------------------------------------------- user web dirs ---

# The default page this script ships. A file that matches it byte for byte has
# never been edited by its owner, so rewriting it is safe; anything else is the
# user's page and is left alone. Add a revision rather than editing this one --
# the old text is what lets a provisioned box recognise its own default.
#
# (root-ubuntu.sh's revisions 2 and 3 carry an nginx SSI token for the sponsor
# ad, which is not ported; revision 1 is the same page on both scripts.)
_public_html_default_page() {
	local login="$1" rev="$2"

	[[ "$rev" == 1 ]] && cat <<EOF
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${login}</title>
<h1>${login}</h1>
<p>Default page for ${login} on ${WEB_DOMAIN}.
<p>Email: <a href="mailto:${login}@${MAIL_DOMAIN}">${login}@${MAIL_DOMAIN}</a>
<p>Edit <code>~/public_html/index.html</code> to replace it.
EOF
	return 0
}

_public_html_current_rev() { echo 1; }

# ~/public_html served at https://$WEB_DOMAIN/~user and https://user.$WEB_DOMAIN
install_public_html() {
	local home="$1" login="$2" doc="$1/public_html" rev want cur

	# create if absent; an existing one keeps whatever mode its owner chose
	[[ -d "$doc" ]] || install -d -m 0755 -o "$login" -g "$login" "$doc"
	_confine_on || chmod o+x "$home"

	cur="$(_public_html_current_rev)"
	want=0
	if [[ ! -e "$doc/index.html" ]]; then
		want=1
	else
		# Still one of our OLDER defaults? Then it is ours to update. Anything
		# the user has touched fails every comparison and is never clobbered.
		# (Only revision 1 exists so far; a revision 2 adds itself here.)
		for rev in $(seq 1 "$cur"); do
			[[ "$rev" == "$cur" ]] && continue
			if cmp -s <(_public_html_default_page "$login" "$rev") "$doc/index.html"; then
				want=1
				break
			fi
		done
	fi

	if [[ "$want" == 1 ]]; then
		_public_html_default_page "$login" "$cur" >"$doc/index.html"
		chown "$login:$login" "$doc/index.html"
		chmod 0644 "$doc/index.html"
		note "$login: default ~/public_html/index.html"
	fi
	return 0
}

# ~/apps/<name> becomes https://<name>.<user>.$WEB_DOMAIN
#
# Static: files in ~/apps/<name>/public. Dynamic: put the port in
# ~/apps/<name>/.port and listen on 127.0.0.1:<port> -- Caddy proxies to it,
# so nothing extra has to be opened in ufw.
install_dev_apps_dir() {
	local home="$1" login="$2" dir="$1/apps" fresh=0
	[[ "$DEV_APPS" == 1 ]] || return 0

	# ~/apps is a common enough name that an adopted account may already have
	# one full of private work. Create it if it is absent, but never restat an
	# existing one -- 'install -d -m 0755' would relax a 0700 directory.
	if [[ ! -d "$dir" ]]; then
		install -d -m 0755 -o "$login" -g "$login" "$dir"
		fresh=1
	fi
	_confine_on || chmod o+x "$home"
	chmod o+x "$dir"

	if [[ "$fresh" == 1 && ! -e "$dir/README" ]]; then
		cat >"$dir/README" <<EOF
Each directory here is published at  https://<dir>.${login}.${WEB_DOMAIN}

Static site -- files go in public/:
    mkdir -p ~/apps/blog/public
    echo hello > ~/apps/blog/public/index.html
    -> https://blog.${login}.${WEB_DOMAIN}

Running app (anything that listens on 127.0.0.1):
    mkdir -p ~/apps/api
    echo 3000 > ~/apps/api/.port
    # start your server on 127.0.0.1:3000
    -> https://api.${login}.${WEB_DOMAIN}

Names must be lowercase letters, digits and dashes. New apps are picked up
within a minute (profullstack-devapps, from cron); no root, no restart, no
re-provision. Bind to 127.0.0.1, not 0.0.0.0 -- the firewall blocks the port
directly and Caddy is what terminates TLS for you.
EOF
		chown "$login:$login" "$dir/README"
	fi
	return 0
}

# users with a home we actually serve something from
web_users() {
	local d u
	for d in /home/*; do
		[[ -d "$d" ]] || continue
		u="$(basename "$d")"
		id -u "$u" >/dev/null 2>&1 || continue
		[[ -d "$d/public_html" || -d "$d/apps" ]] || continue
		printf '%s\n' "$u"
	done
}

# ------------------------------------------------------------------ caddy ---
#
# Caddy replaces root-ubuntu.sh's nginx, certbot and acme.sh in one binary:
#
#   * every hostname a site block names gets its own certificate, issued and
#     renewed by Caddy itself over HTTP-01/TLS-ALPN -- so there is no wildcard,
#     no DNS-01 provider plugin, and no renewal job to keep alive
#   * it listens dual-stack (IPv4 and IPv6) and serves HTTP/3
#   * the admin API is on loopback only ($CADDY_ADMIN), and a reload through it
#     is graceful: in-flight websockets to people's dev servers survive
#
# Layout, all under $CADDY_DIR:
#
#   Caddyfile        ours: global options, the shared snippets, the landing
#                    site and the port-80 catch-all; imports the two below
#   users/<login>.caddy
#                    one per account with something to serve: its page and
#                    each of its dev apps. Written by profullstack-devapps,
#                    which cron runs every minute, so `mkdir ~/apps/x` goes
#                    live with no root and no re-provision
#   conf.d/*.caddy   yours: anything else this box serves. Never touched.

# The site address prefix: Caddy's default for a bare name is https, so the
# only case that needs spelling out is plain http.
_caddy_scheme() { [[ "$WEB_TLS" == off ]] && printf 'http://' || printf ''; }

# The AI crawler list as one case-insensitive alternation, for header_regexp.
_caddy_badbot_regex() {
	local ua out=""
	for ua in "${AI_CRAWLER_AGENTS[@]}"; do
		out+="${out:+|}${ua// /\\s}"
	done
	printf '(?i)(%s)' "$out"
}

write_caddyfile() {
	local scheme global_tls="" tld
	scheme="$(_caddy_scheme)"
	case "$WEB_TLS" in
		auto) global_tls="" ;;
		internal)
			# Caddy's own CA. skip_install_trust: it runs as `caddy` and cannot
			# touch the system trust store, and trying fills the log with that.
			global_tls=$'\tlocal_certs\n\tskip_install_trust' ;;
		off) global_tls=$'\tauto_https off' ;;
		*) warn "WEB_TLS='$WEB_TLS' is not auto|internal|off -- using auto"; WEB_TLS=auto ;;
	esac

	cat <<EOF
# managed by cli-tools/root-w3bs-os.sh -- per-user pages and dev apps on $WEB_DOMAIN
# https://$WEB_DOMAIN/~user  https://user.$WEB_DOMAIN  https://app.user.$WEB_DOMAIN
#
# Edits here are overwritten on the next run. Put your own sites in
# $CADDY_CONF_DIR/*.caddy, which is imported below and never touched.
{
	admin $CADDY_ADMIN
${ACME_EMAIL:+	email $ACME_EMAIL
}${global_tls:+$global_tls
}	log {
		output file $CADDY_LOG_DIR/caddy.log {
			roll_size 50MiB
			roll_keep 5
		}
	}
}

# Every site: refuse the AI crawlers, hide version-control metadata (404, not
# 403, so a probe cannot tell a blocked repo from none), answer robots.txt.
# Inside each site's route block, so it runs before anything that serves files.
(w3bs_guard) {
EOF
	if [[ "$BLOCK_AI_BOTS" == 1 ]]; then
		printf '\t@w3bs_badbot header_regexp User-Agent "%s"\n' "$(_caddy_badbot_regex)"
		printf '\trespond @w3bs_badbot "blocked" 403\n'
	fi
	cat <<'EOF'
	@w3bs_vcs path_regexp /\.(git|svn|hg|bzr)(/|$)
	respond @w3bs_vcs 404
	@w3bs_robots path /robots.txt
	header @w3bs_robots Content-Type "text/plain; charset=utf-8"
	respond @w3bs_robots `User-agent: GPTBot
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: ClaudeBot
User-agent: anthropic-ai
User-agent: Claude-Web
User-agent: PerplexityBot
User-agent: CCBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: Bytespider
User-agent: Amazonbot
User-agent: meta-externalagent
User-agent: cohere-ai
User-agent: Diffbot
Disallow: /
` 200
}

# Access logs, rolled by size so a busy box cannot fill the disk with them.
(w3bs_log) {
	log {
		output file /var/log/caddy/access.log {
			roll_size 200MiB
			roll_keep 14
		}
	}
	header -Server
}

EOF
	cat <<EOF
# The landing page, and every account's page at /~<login>.
${scheme}${WEB_DOMAIN} {
	import w3bs_log
	route {
		import w3bs_guard
		# /~user without a trailing slash: redirect so relative links resolve
		@tildebare path_regexp tildebare ^/~[a-z_][a-z0-9_-]*\$
		redir @tildebare {path}/ 301
		@tilde path_regexp tilde ^/~([a-z_][a-z0-9_-]*)(/.*)\$
		handle @tilde {
			root * /home/{re.tilde.1}/public_html
			rewrite * {re.tilde.2}
			file_server browse
		}
		handle {
			root * /var/www/userdirs
			file_server
		}
	}
}

# Each account's page and dev apps (profullstack-devapps), then your own.
import $CADDY_USERS_DIR/*.caddy
import $CADDY_CONF_DIR/*.caddy

EOF

	# Port 80, every name nothing else claimed. A Moshpit name nobody has
	# pointed anywhere resolves here (the registry answers every unpointed
	# name with this box), so it is parked: 302 to the Pit's page for it.
	# Everything else is upgraded to https -- or, with WEB_TLS=off, answered
	# with a 404, since there is no https to upgrade to.
	printf '# Port 80 catch-all: Moshpit parking for unpointed names, https for the rest.\n'
	printf 'http:// {\n'
	if [[ -n "$MOSHPIT_PARKING_URL" ]]; then
		printf '\t# the ending of the name, then whether that ending is a clearnet TLD\n'
		printf '\tmap {host} {moshpit_tld} {\n'
		printf '\t\t~^[0-9.]+$ ""\n'
		printf '\t\t~^\\[ ""\n'
		printf '\t\t~(?i)\\.([a-z0-9-]+)\\.?$ "${1}"\n'
		printf '\t\tdefault ""\n'
		printf '\t}\n'
		printf '\tmap {moshpit_tld} {moshpit_parked} {\n'
		printf '\t\t"" 0\n'
		for tld in $IANA_TLDS; do printf '\t\t%s 0\n' "$tld"; done
		printf '\t\tdefault 1\n'
		printf '\t}\n'
		printf '\t@parked vars {moshpit_parked} 1\n'
		# 302, not 301: the owner can point the name at a real site at any
		# moment, and a cached permanent redirect would outlive that.
		printf '\tredir @parked %s/{host} 302\n' "$MOSHPIT_PARKING_URL"
	fi
	if [[ "$WEB_TLS" == off ]]; then
		printf '\trespond 404\n'
	else
		printf '\tredir https://{host}{uri} 301\n'
	fi
	printf '}\n'
}

# The generator that turns ~/public_html and ~/apps into
# $CADDY_USERS_DIR/<login>.caddy. A file of its own, because cron runs it
# every minute without the rest of this script.
write_devapps_generator() {
	local units_changed=0 scheme
	scheme="$(_caddy_scheme)"

	write_if_changed /usr/local/bin/profullstack-devapps 0755 <<EOF && note "devapps generator"
#!/bin/sh
# Regenerate $CADDY_USERS_DIR/<login>.caddy from ~/public_html and ~/apps/*.
# Generated by cli-tools/root-w3bs-os.sh -- edits here are overwritten.
#
#   profullstack-devapps              regenerate; reload Caddy if anything changed
#   profullstack-devapps --no-reload  regenerate only; prints "changed" if it did
umask 022
domain='${WEB_DOMAIN}'
scheme='${scheme}'
dev_apps='${DEV_APPS}'
users_dir='${CADDY_USERS_DIR}'
caddyfile='${CADDYFILE}'
admin='${CADDY_ADMIN}'
tenants='${SANDBOX_TENANTS}'
port_base=${SANDBOX_PORT_BASE}
port_span=${SANDBOX_PORT_SPAN}

# Who may publish which port. A tenant's app runs on their own loopback inside
# their instance and is forwarded onto this box's loopback on the same number,
# so the band is the only thing separating tenants: without this check alice
# could put bob's port in her own ~/apps/x/.port and serve his work.
#
#   a tenant    -> only the band their own slot owns
#   anyone else -> anything except a band that is ALLOCATED to a tenant
port_allowed() {
	_user="\$1"; _port="\$2"; _slot=""
	[ -s "\$tenants" ] || return 0
	_slot="\$(awk -F'\t' -v u="\$_user" '\$1==u { print \$2 }' "\$tenants")"
	if [ -n "\$_slot" ]; then
		_lo=\$(( port_base + _slot * port_span ))
		_hi=\$(( _lo + port_span - 1 ))
		[ "\$_port" -ge "\$_lo" ] && [ "\$_port" -le "\$_hi" ]
		return \$?
	fi
	[ "\$_port" -lt "\$port_base" ] && return 0
	_owner=\$(( (_port - port_base) / port_span ))
	! awk -F'\t' -v s="\$_owner" '\$2==s { found=1 } END { exit !found }' "\$tenants"
}

site() {
	# \$1 address, then the body lines
	_addr="\$1"; shift
	printf '%s%s {\n\timport w3bs_log\n\troute {\n\t\timport w3bs_guard\n' "\$scheme" "\$_addr"
	for _l in "\$@"; do printf '\t\t%s\n' "\$_l"; done
	printf '\t}\n}\n\n'
}

tmpd="\$(mktemp -d)" || exit 1
trap 'rm -rf "\$tmpd"' EXIT
mkdir -p "\$tmpd/new" "\$tmpd/prev"

for home in /home/*; do
	[ -d "\$home" ] || continue
	user="\${home##*/}"
	# a login is what Caddy will put in a hostname and a path: nothing else
	case "\$user" in *[!a-z0-9_-]*|''|[0-9-]*) continue ;; esac
	id -u "\$user" >/dev/null 2>&1 || continue
	[ -d "\$home/public_html" ] || [ -d "\$home/apps" ] || continue
	{
		echo "# generated by profullstack-devapps for \$user -- do not edit"
		echo
		if [ -d "\$home/public_html" ]; then
			site "\$user.\$domain" "root * \$home/public_html" "file_server browse"
		fi
		if [ "\$dev_apps" = 1 ] && [ -d "\$home/apps" ]; then
			for appdir in "\$home"/apps/*/; do
				[ -d "\$appdir" ] || continue
				appdir="\${appdir%/}"
				app="\${appdir##*/}"
				case "\$app" in *[!a-z0-9-]*|-*|'') continue ;; esac
				port=""
				if [ -f "\$appdir/.port" ]; then
					port="\$(tr -cd '0-9' <"\$appdir/.port" | head -c 5)"
					# a user must not be able to point us at someone else's
					# service, and the low ports are root's
					if [ -z "\$port" ] || [ "\$port" -lt 1024 ] || [ "\$port" -gt 65535 ] \\
						|| ! port_allowed "\$user" "\$port"; then
						port=""
					fi
				fi
				if [ -n "\$port" ]; then
					# websockets and HMR pass through reverse_proxy as-is
					site "\$app.\$user.\$domain" "reverse_proxy 127.0.0.1:\$port"
				elif [ -d "\$appdir/public" ]; then
					site "\$app.\$user.\$domain" "root * \$appdir/public" "file_server"
				fi
			done
		fi
	} >"\$tmpd/new/\$user.caddy"
done

mkdir -p "\$users_dir"
cp -a "\$users_dir/." "\$tmpd/prev/" 2>/dev/null
changed=0
for f in "\$tmpd"/new/*.caddy; do
	[ -e "\$f" ] || continue
	dst="\$users_dir/\${f##*/}"
	cmp -s "\$f" "\$dst" || { install -m 0644 "\$f" "\$dst"; changed=1; }
done
for f in "\$users_dir"/*.caddy; do
	[ -e "\$f" ] || continue
	[ -e "\$tmpd/new/\${f##*/}" ] || { rm -f "\$f"; changed=1; }
done
[ "\$changed" = 1 ] || exit 0

# Never leave a config behind that Caddy would refuse at its next start: a
# generated file that does not validate is rolled back to what was there.
# Validated AS caddy: validate opens the log files, and run as root it would
# create them root-owned 0600 -- which the real server, running as caddy,
# then cannot open, and it exits.
validate() {
	if id caddy >/dev/null 2>&1; then
		su caddy -s /bin/sh -c "caddy validate --config '\$caddyfile' --adapter caddyfile" >/dev/null 2>&1
	else
		caddy validate --config "\$caddyfile" --adapter caddyfile >/dev/null 2>&1
	fi
}
if ! validate; then
	rm -f "\$users_dir"/*.caddy
	cp -a "\$tmpd/prev/." "\$users_dir/" 2>/dev/null
	logger -t profullstack-devapps "generated config did not validate -- rolled back" 2>/dev/null
	echo "profullstack-devapps: generated config did not validate -- rolled back" >&2
	exit 1
fi
if [ "\${1:-}" = --no-reload ]; then
	echo changed
	exit 0
fi
caddy reload --config "\$caddyfile" --adapter caddyfile --address "\$admin" >/dev/null 2>&1 || true
EOF

	if [[ "$(detect_init)" == systemd ]]; then
		write_if_changed /etc/systemd/system/profullstack-devapps.service <<'EOF' && units_changed=1
[Unit]
Description=Compile per-user pages and dev apps for Caddy
After=caddy.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/profullstack-devapps
EOF
		write_if_changed /etc/systemd/system/profullstack-devapps.timer <<'EOF' && units_changed=1
[Unit]
Description=Pick up new per-user dev apps

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=15s

[Install]
WantedBy=timers.target
EOF
		[[ "$units_changed" == 1 ]] && { systemctl daemon-reload; note "devapps timer units"; }
		systemctl is-enabled profullstack-devapps.timer >/dev/null 2>&1 \
			|| systemctl enable --now profullstack-devapps.timer
	else
		_crontab_ensure profullstack-devapps "* * * * * /usr/local/bin/profullstack-devapps >/dev/null 2>&1"
		svc_enable crond 2>/dev/null; svc_start crond 2>/dev/null || true
	fi
	return 0
}

# caddy, run as the caddy user when there is one -- see configure_caddy.
_caddy_as_caddy() {
	if id caddy >/dev/null 2>&1; then
		su caddy -s /bin/sh -c "$(printf '%q ' caddy "$@")"
	else
		caddy "$@"
	fi
}

# Up means answering on the admin API, not "the supervisor started a process":
# supervise-daemon reports success for a child that exits a second later.
_caddy_up() {
	local i
	for i in 1 2 3 4 5 6 7 8 9 10; do
		curl -fsS --max-time 2 "http://$CADDY_ADMIN/config/" >/dev/null 2>&1 && return 0
		sleep 1
	done
	return 1
}

# Caddy is reloaded through its admin API when it is running (graceful: open
# connections survive), started when it is not, and left alone when nothing
# changed -- a maintenance run should be invisible to anyone using the box.
_caddy_apply() {
	local changed="$1"
	svc_enable caddy 2>/dev/null || true
	if [[ "$(detect_init)" == none ]]; then
		info "no init -- Caddy is configured but not started (caddy run --config $CADDYFILE)"
		return 0
	fi
	if ! svc_is_active caddy || ! _caddy_up; then
		svc_restart caddy >/dev/null 2>&1
		_caddy_up || { warn "caddy would not start -- see $CADDY_LOG_DIR/caddy.log"; return 1; }
		note "caddy started"
	elif [[ "$changed" == 1 ]]; then
		caddy reload --config "$CADDYFILE" --adapter caddyfile --address "$CADDY_ADMIN" >/dev/null 2>&1 \
			|| svc_reload caddy \
			|| { warn "caddy reload failed"; return 1; }
		note "caddy config reloaded"
	else
		info "caddy config unchanged -- not reloading"
	fi
	return 0
}

configure_caddy() {
	local changed=0 backup out

	apk_has caddy || apk_add caddy || { warn "could not install caddy"; return 1; }
	[[ "$(detect_init)" == openrc ]] && { apk_has caddy-openrc || apk_add caddy-openrc; }
	command -v caddy >/dev/null 2>&1 || { warn "caddy is not on PATH"; return 1; }

	install -d -m 0755 "$CADDY_DIR" "$CADDY_USERS_DIR" "$CADDY_CONF_DIR" /var/www/userdirs
	install -d -m 0750 -o caddy -g caddy "$CADDY_LOG_DIR" 2>/dev/null \
		|| install -d -m 0750 "$CADDY_LOG_DIR"

	# The packaged Caddyfile is a placeholder; keep it once, beside ours.
	if [[ -f "$CADDYFILE" && ! -e "$CADDYFILE.apk-orig" ]] \
		&& ! grep -q 'managed by cli-tools/root-w3bs-os.sh' "$CADDYFILE"; then
		cp -p "$CADDYFILE" "$CADDYFILE.apk-orig"
	fi

	backup="$(mktemp)"
	[[ -f "$CADDYFILE" ]] && cp -f "$CADDYFILE" "$backup"
	write_caddyfile | write_if_changed "$CADDYFILE" 0644 && changed=1

	write_devapps_generator
	# Regenerate the per-account files now rather than waiting a minute.
	# --no-reload: one reload at the end covers both, and only if needed.
	out="$(/usr/local/bin/profullstack-devapps --no-reload 2>&1)" || warn "profullstack-devapps: $out"
	[[ "$out" == *changed* ]] && changed=1

	fetch_logo || warn "could not fetch $LOGO_URL (landing page will link to it instead)"
	write_landing_page

	# Validated before anything is reloaded; a config Caddy refuses is put
	# back the way it was, so a bad run never takes the sites down. As the
	# caddy user, for the reason in the generator: validate opens the log
	# files, and root would leave them unopenable for the real server.
	if ! out="$(_caddy_as_caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1)"; then
		warn "caddy validate failed:"
		printf '%s\n' "$out" | tail -5 | sed 's/^/        /' >&2
		if [[ -s "$backup" ]]; then
			install -m 0644 "$backup" "$CADDYFILE"
			warn "restored the previous $CADDYFILE"
		fi
		rm -f "$backup"
		return 1
	fi
	rm -f "$backup"
	# Anything an older run (or a root `caddy validate` by hand) left behind
	# root-owned in the log directory would stop Caddy at its next start.
	chown -R caddy:caddy "$CADDY_LOG_DIR" 2>/dev/null || true
	[[ "$changed" == 1 ]] && note "caddy config"

	[[ -n "$SPONSOR_AD_SLOT" ]] \
		&& info "SPONSOR_AD_SLOT is set, but the sponsor ad is an nginx feature that root-w3bs-os.sh does not port"

	_caddy_apply "$changed"
}

# ---- Porkbun DNS ----------------------------------------------------------
#
# Caddy can only get a certificate for a name that resolves here, and every
# dev app is a name of its own -- nobody wants to add those records by hand.
PORKBUN_DOMAIN="${PORKBUN_DOMAIN:-$(printf '%s' "$WEB_DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')}"
PORKBUN_API=https://api.porkbun.com/api/json/v3

_porkbun_call() {
	local path="$1" body="$2"
	# no -f: a 4xx body carries the API's own error message, which is worth
	# more than curl's exit code
	curl -sS --max-time 30 -H 'Content-Type: application/json' \
		-d "$body" "$PORKBUN_API/$path" 2>/dev/null
}

_spf_txt() {
	dig +short TXT "$1" 2>/dev/null | tr -d '"' | grep -m1 '^v=spf1' || true
}

# Recursively count the DNS-querying mechanisms in an SPF record.
#
# RFC 7208 4.6.4 caps this at 10, and going over is a permerror -- the exact
# failure mode as having two records. So a merge can happily fix one bug and
# introduce the other: two includes that each pull in the same four nested
# includes cost eight lookups between them, not four.
spf_lookup_count() {
	local rec="$1" depth="${2:-0}" n=0 t sub add
	[[ "$depth" -gt 8 ]] && { printf 0; return; }
	for t in $rec; do
		case "${t,,}" in
			include:*|redirect=*)
				n=$((n+1))
				sub="$(_spf_txt "${t#*[:=]}")"
				if [[ -n "$sub" ]]; then
					add="$(spf_lookup_count "$sub" $((depth+1)))"
					n=$((n+add))
				fi
				;;
			a|a:*|mx|mx:*|ptr|ptr:*|exists:*) n=$((n+1)) ;;
		esac
	done
	printf '%s' "$n"
}

# Consolidate the apex SPF record.
#
# RFC 7208 allows exactly one "v=spf1" TXT record per name. A second one is a
# permerror, not a merge -- receivers stop evaluating and the domain fails SPF
# outright. Combined with "DMARC p=reject" that is a live deliverability bug,
# and it is easy to end up with because every service that wants SPF tells you
# to "add a TXT record".
#
# Detection always runs and warns. Rewriting only happens with FIX_SPF=1,
# because silently editing mail DNS during a provisioning run is not something
# this script should do on its own.
#
# The merge is a union of every term except the trailing "all", in first-seen
# order, so nothing that was authorised before stops being authorised. Two
# includes that happen to cover the same hosts are left alone -- deciding they
# are redundant needs a human who knows what still sends mail.
porkbun_fix_spf() {
	local auth records spf_json count merged first_id terms all_q
	[[ -n "$PORKBUN_API_KEY" && -n "$PORKBUN_SECRET_API_KEY" ]] || return 1
	auth="$(printf '{"apikey":"%s","secretapikey":"%s"}' "$PORKBUN_API_KEY" "$PORKBUN_SECRET_API_KEY")"

	records="$(_porkbun_call "dns/retrieve/$PORKBUN_DOMAIN" "$auth")"
	[[ "$(printf '%s' "$records" | jq -r '.status? // "ERROR"')" == "SUCCESS" ]] || {
		warn "could not read DNS for $PORKBUN_DOMAIN -- leaving SPF alone"
		return 1
	}

	# apex TXT records only, and only the SPF ones: the same name also carries
	# site-verification strings that must not be touched.
	spf_json="$(printf '%s' "$records" | jq -c \
		--arg d "$PORKBUN_DOMAIN" \
		'[.records[] | select(.type=="TXT" and .name==$d)
		  | {id, content: (.content | gsub("^\"|\"$";""))}
		  | select(.content | test("^v=spf1\\b"))]')"
	count="$(printf '%s' "$spf_json" | jq 'length')"

	if [[ "$count" -le 1 ]]; then
		[[ "$count" == 1 ]] && note "SPF on $PORKBUN_DOMAIN: 1 record (correct)"
		return 0
	fi

	warn "$PORKBUN_DOMAIN has $count SPF records -- RFC 7208 permits one; this is a permerror"
	printf '%s' "$spf_json" | jq -r '.[] | "    " + .content' >&2

	# strictest qualifier wins: if any record hard-failed before, keep doing so
	all_q="$(printf '%s' "$spf_json" | jq -r \
		'if any(.[].content; test("(^| )-all( |$)")) then "-all" else "~all" end')"
	terms="$(printf '%s' "$spf_json" | jq -r \
		'[.[].content | split(" ")[]] | map(select(. != "v=spf1" and (test("all$") | not)))
		 | unique_by(ascii_downcase) | join(" ")')"
	merged="v=spf1 $terms $all_q"

	local lookups
	lookups="$(spf_lookup_count "$terms")"
	if [[ "${lookups:-0}" -gt 10 ]]; then
		warn "the union of those records needs $lookups DNS lookups (RFC 7208 caps it at 10)"
		warn "applying it would swap one permerror for another -- overlapping includes"
		warn "have to be reduced by hand, by someone who knows what still sends mail:"
		warn "  $merged"
		return 1
	fi

	note "merged SPF ($lookups/10 lookups): $merged"
	if [[ "${FIX_SPF:-0}" != 1 ]]; then
		note "re-run with FIX_SPF=1 to apply it (this edits mail DNS)"
		return 0
	fi

	first_id="$(printf '%s' "$spf_json" | jq -r '.[0].id')"
	if ! _porkbun_call "dns/edit/$PORKBUN_DOMAIN/$first_id" \
		"${auth%\}},\"name\":\"\",\"type\":\"TXT\",\"content\":\"$merged\",\"ttl\":\"600\"}" \
		| grep -q '"status":"SUCCESS"'; then
		warn "could not rewrite the SPF record -- nothing deleted, zone unchanged"
		return 1
	fi
	note "SPF rewritten: $merged"

	# only now that one good record exists is it safe to drop the others
	local id
	for id in $(printf '%s' "$spf_json" | jq -r '.[1:][].id'); do
		if _porkbun_call "dns/delete/$PORKBUN_DOMAIN/$id" "$auth" | grep -q '"status":"SUCCESS"'; then
			note "removed duplicate SPF record $id"
		else
			warn "could not remove duplicate SPF record $id -- still a permerror, fix by hand"
		fi
	done
}

# Create <name>.<PORKBUN_DOMAIN> -> $2 if it is not already there.
#
# Porkbun happily stores two A records with the same name, so "I could not
# read the zone" must never be treated as "the record is missing" -- one
# timeout would otherwise add a duplicate on every run.
porkbun_ensure_record() {
	local name="$1" ip="$2" auth existing path
	[[ -n "$PORKBUN_API_KEY" && -n "$PORKBUN_SECRET_API_KEY" && -n "$ip" ]] || return 1
	auth="$(printf '{"apikey":"%s","secretapikey":"%s"' "$PORKBUN_API_KEY" "$PORKBUN_SECRET_API_KEY")"

	# the apex record has an empty name; that endpoint wants the name omitted
	# entirely rather than a trailing empty path segment
	path="dns/retrieveByNameType/$PORKBUN_DOMAIN/A"
	[[ -n "$name" ]] && path="$path/$name"

	existing="$(_porkbun_call "$path" "$auth}")"
	if ! printf '%s' "$existing" | grep -q '"status":"SUCCESS"'; then
		warn "could not read DNS for ${name:+$name.}$PORKBUN_DOMAIN -- not creating anything"
		return 1
	fi

	if printf '%s' "$existing" | grep -q '"content"'; then
		# -F: an IP is full of dots, which are wildcards to a basic regex
		if printf '%s' "$existing" | grep -qF "\"content\":\"$ip\""; then
			return 0            # already correct
		fi
		warn "DNS ${name:+$name.}$PORKBUN_DOMAIN points somewhere else -- not touching it"
		return 1
	fi

	if _porkbun_call "dns/create/$PORKBUN_DOMAIN" \
		"$auth,\"type\":\"A\",\"name\":\"$name\",\"content\":\"$ip\",\"ttl\":\"600\"}" \
		| grep -q '"status":"SUCCESS"'; then
		note "DNS A ${name:+$name.}$PORKBUN_DOMAIN -> $ip"
		return 0
	fi
	warn "could not create DNS record ${name:+$name.}$PORKBUN_DOMAIN (API access enabled on the domain?)"
	return 1
}

# Is this an address the public internet can actually reach? Publishing a
# NAT address into DNS breaks the zone, and the "points somewhere else" guard
# above would then refuse to correct it.
is_public_ip() {
	local ip="$1"
	[[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
	case "$ip" in
		10.*|127.*|169.254.*|192.168.*|0.*|255.*) return 1 ;;
		172.1[6-9].*|172.2[0-9].*|172.3[01].*)    return 1 ;;
		100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 1 ;;  # CGNAT/tailscale
	esac
	return 0
}

# the records this box needs: the base name, the user wildcard, and one
# wildcard per user for their dev apps
ensure_dns_records() {
	local ip="$1" sub u rc=0
	[[ -n "$PORKBUN_API_KEY" && -n "$PORKBUN_SECRET_API_KEY" ]] || return 1
	[[ -n "$ip" ]] || { warn "no public IP found -- skipping DNS"; return 1; }
	is_public_ip "$ip" || {
		warn "$ip is not a public address -- refusing to publish it as DNS"
		return 1
	}

	# dev.profullstack.com -> "dev" relative to the zone
	sub="${WEB_DOMAIN%".$PORKBUN_DOMAIN"}"
	[[ "$sub" == "$WEB_DOMAIN" ]] && sub=""

	porkbun_ensure_record "$sub" "$ip" || rc=1
	porkbun_ensure_record "*${sub:+.$sub}" "$ip" || rc=1
	if [[ "$DEV_APPS" == 1 ]]; then
		while read -r u; do
			porkbun_ensure_record "*.$u${sub:+.$sub}" "$ip" || rc=1
		done < <(web_users)
	fi

	# Not about this host's records, but this is the one place we already hold
	# Porkbun credentials -- and a second SPF record breaks mail for the whole
	# zone silently. Detect-only unless FIX_SPF=1.
	porkbun_fix_spf || rc=1
	return $rc
}
LANDING=/var/www/userdirs/index.html
LANDING_MARKER="generated by cli-tools/root-w3bs-os.sh"

# The company blog is one person's userdir rather than its own vhost, so the
# landing page has to be told whose to link. No default, because whose it is
# differs per box and guessing a login would produce a link to a 404; with
# BLOG_USER unset the landing page simply has no blog section.
BLOG_USER="${BLOG_USER:-}"
BLOG_TITLE="${BLOG_TITLE:-the team blog}"
BLOG_DIR="${BLOG_DIR:-${BLOG_USER:+/home/$BLOG_USER/public_html/blog}}"

# Staff landing page for https://$WEB_DOMAIN -- people, company links, stack.
# Regenerated each run so new users appear, but only if the file is still the
# generated one; a hand-edited page is left alone.
# Cached locally so the landing page still has a logo when profullstack.com is
# unreachable, and so it does not make an off-box request on every view.
fetch_logo() {
	local tmp
	install -d -m 0755 "$(dirname "$LOGO_FILE")"
	# a logo that is already there and less than a week old is good enough
	[[ -s "$LOGO_FILE" ]] && [[ -z "$(find "$LOGO_FILE" -mtime +7 2>/dev/null)" ]] && return 0
	tmp="$(mktemp)" || return 1
	if curl -fsSL --max-time 10 "$LOGO_URL" -o "$tmp" && [[ -s "$tmp" ]]; then
		cmp -s "$tmp" "$LOGO_FILE" || { install -m 0644 "$tmp" "$LOGO_FILE"; note "logo"; }
		rm -f "$tmp"
		return 0
	fi
	rm -f "$tmp"
	return 1
}

write_landing_page() {
	install -d -m 0755 /var/www/userdirs

	# Replaceable if we generated it. The extra patterns are every marker this
	# script has ever stamped a page with -- the placeholder from before the
	# marker existed, and the one from when this lived in the dotfiles repo.
	# Renaming the marker without keeping the old one means every already
	# provisioned box decides its own landing page was hand-edited and refuses
	# to touch it again, which is a one-way door: nothing later can tell the
	# difference between that page and a real one somebody wrote.
	if [[ -e "$LANDING" ]] \
		&& ! grep -q "$LANDING_MARKER" "$LANDING" \
		&& ! grep -q 'generated by dottemplates/root-w3bs-os.sh' "$LANDING" \
		&& ! grep -q 'User pages are at' "$LANDING"; then
		info "$LANDING was edited by hand -- leaving it alone"
		return 0
	fi

	local proto=http u _mail_host _logo _blog
	[[ "$WEB_TLS" != off ]] && proto=https
	_mail_host="${MAIL_URL#*://}"; _mail_host="${_mail_host%/}"

	# prefer the local copy; fall back to the canonical URL if the fetch failed
	if [[ -s "$LOGO_FILE" ]]; then
		_logo="/assets/logo.svg"
	else
		_logo="$LOGO_URL"
	fi

	# The write-ups, linked from the moshcode section. Emitted as a variable
	# rather than inlined in the heredoc so it can be skipped: on a box with no
	# such blog it would otherwise be a link to a 404, which is worse than no
	# link at all. Needs BOTH a configured BLOG_USER and the directory actually
	# being there -- a name alone is a promise the box may not keep.
	_blog=""
	if [[ -n "$BLOG_USER" && -n "$BLOG_DIR" && -d "$BLOG_DIR" ]]; then
		_blog="  <p class=\"sub\">The long version is written up on
     <a href=\"$proto://$WEB_DOMAIN/~$BLOG_USER/blog/\">$BLOG_TITLE</a>.</p>"
	fi

	{
		cat <<EOF
<!doctype html>
<!-- $LANDING_MARKER -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>$WEB_DOMAIN</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#e5e5e5; --card:#fafafa }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --dim:#9a9a9a; --line:#2a2a2a; --card:#161616 }
  }
  * { box-sizing:border-box }
  body { margin:0; padding:3rem 1.25rem; color:var(--fg);
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif }
  .wrap { max-width:56rem; margin:0 auto }
  .logo { display:block; height:2.5rem; width:auto; margin:0 0 1.25rem }
  h1 { margin:0; font-size:1.4rem; letter-spacing:-.01em }
  .sub { color:var(--dim); margin:.25rem 0 2.5rem }
  h2 { font-size:.75rem; text-transform:uppercase; letter-spacing:.08em;
       color:var(--dim); margin:2.5rem 0 .75rem; font-weight:600 }
  ul { list-style:none; padding:0; margin:0; display:grid; gap:.5rem;
       grid-template-columns:repeat(auto-fill,minmax(15rem,1fr)) }
  li a { display:block; padding:.7rem .9rem; border:1px solid var(--line);
         border-radius:.5rem; background:var(--card); color:inherit;
         text-decoration:none }
  li a:hover { border-color:var(--dim) }
  li a small { display:block; color:var(--dim); font-size:.8rem }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em }
  pre { position:relative; background:var(--card); border:1px solid var(--line);
        border-radius:.5rem;
        padding:.9rem; overflow-x:auto; font:.85rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace }
  /* Always visible, not hover-only: half the people reading this are on a
     phone, where there is no hover and a hidden button may as well not exist.
     It is anchored to the pre rather than a wrapper, so on a block wide enough
     to scroll it travels with the content instead of covering the first line. */
  pre button.copy { position:absolute; top:.4rem; right:.4rem; padding:.15rem .5rem;
        border:1px solid var(--line); border-radius:.35rem; background:var(--card);
        color:var(--dim); font:inherit; font-size:.75rem; line-height:1.4;
        cursor:pointer }
  pre button.copy:hover { color:var(--fg); border-color:var(--dim) }
  footer { margin-top:3rem; color:var(--dim); font-size:.85rem }
</style>
<div class="wrap">
  <a href="https://profullstack.com"><img class="logo" src="$_logo" alt="Profullstack"></a>
  <h1>$WEB_DOMAIN</h1>
  <p class="sub">Profullstack dev box (W3BS OS) &mdash; staff links and user pages.</p>

  <h2>Company</h2>
  <ul>
    <li><a href="$MAIL_URL">Mail<small>${_mail_host}</small></a></li>
    <li><a href="${WEBMAIL_URL//&/&amp;}">Inbox<small>straight to your $MAIL_DOMAIN inbox</small></a></li>
    <li><a href="https://github.com/profullstack">GitHub<small>github.com/profullstack</small></a></li>
    <li><a href="https://www.npmjs.com/search?q=%40profullstack">npm packages<small>the @profullstack scope</small></a></li>
    <li><a href="https://github.com/profullstack/cli-tools">cli-tools<small>gh-prs, gh-prs-merge, tcfeed, domainjson &middot; install onto PATH</small></a></li>
    <li><a href="https://profullstack.com">Website<small>profullstack.com</small></a></li>
  </ul>

  <h2>Comms &mdash; AgentBBS</h2>
  <p class="sub">Our comms network runs over SSH. First time, connect as
     <code>join</code> &mdash; your SSH key becomes your account and you get a
     username, a Linux pod and a homepage. After that, sign in as your BBS name.</p>
  <pre>ssh join@$BBS_DOMAIN          # first time: registers your key
ssh &lt;your-bbs-name&gt;@$BBS_DOMAIN   # sign in -- arcade, chat, news, mail, pod
ssh bbs@$BBS_DOMAIN           # look around as a guest</pre>
  <p class="sub">Once signed in the hub reaches everything without separate logins.
     Handy direct entrances:</p>
  <pre>ssh mail@$BBS_DOMAIN          # your BBS mailbox
ssh irc@$BBS_DOMAIN           # members' IRC from your terminal
ssh -t news@$BBS_DOMAIN       # Usenet-style newsreader
ssh pod@$BBS_DOMAIN           # your Linux pod</pre>
  <ul>
    <li><a href="https://$BBS_DOMAIN/">AgentBBS<small>$BBS_DOMAIN</small></a></li>
    <li><a href="https://git.profullstack.com">AgentGit<small>git.profullstack.com/&lt;name&gt;</small></a></li>
    <li><a href="https://irc.profullstack.com">IRC<small>irc.profullstack.com:6697 TLS &middot; SASL as your BBS name</small></a></li>
  </ul>

  <h2>People</h2>
  <ul>
EOF

		# one card per user that actually has a public_html
		for u in /home/*/public_html; do
			[[ -d "$u" ]] || continue
			u="$(basename "$(dirname "$u")")"
			printf '    <li><a href="%s://%s.%s/">%s<small>%s.%s</small><small>%s@%s</small><small>ssh %s@%s</small></a></li>\n' \
				"$proto" "$u" "$WEB_DOMAIN" "$u" "$u" "$WEB_DOMAIN" \
				"$u" "$MAIL_DOMAIN" "$u" "$BBS_DOMAIN"
		done

		cat <<EOF
  </ul>

  <h2>moshcode</h2>
  <p class="sub"><strong>All dev work on this box goes through moshcode.</strong> It is
     already installed for every account &mdash; it is the wrapper that installs and
     drives the coding agents, so you do not set them up yourself. Run
     <code>moshcode</code> with no arguments for the TUI, which we call the pit. That
     is where the day starts, and its slash commands are also how you reach people
     and how you bill &mdash; see below.</p>
  <pre>moshcode                      # the pit, then /agents &lt;engine&gt;
moshcode engines              # what is installed: claude, codex, gemini, opencode, aider
moshcode install claude       # add an engine
moshcode claude               # launch one directly
moshcode agents claude        # autonomous mode -- auto-approves, use in trusted dirs only</pre>
  <p class="sub">On your own machine &mdash; source at
     <a href="https://github.com/moshcoder/moshcode">github.com/moshcoder/moshcode</a>.
     Never run it with <code>sudo</code>: it re-runs its own root steps where it
     needs them, and <code>sudo moshcode</code> installs into <code>/root</code>
     instead of your account.</p>
  <pre>curl -fsSL https://moshcoding.com/install.sh | sh
moshcode upgrade              # once installed, this is how it updates itself</pre>
  <p class="sub">It also fronts the workflow CLIs. Each keeps its own auth, so
     signing in to one signs you in to nothing else:</p>
  <pre>moshcode tools                # gh, supabase, railway, doppler, doctl, ugig, coinpay, …
moshcode gh pr list           # passthrough -- same as running gh yourself
moshcode upgrade              # update moshcode and everything it installed</pre>

  <p class="sub">Run it under <strong>tmux</strong>, which is installed here and works
     well with the pit &mdash; a dropped connection then costs you nothing, and you
     can leave an agent running while you go and do something else. <code>mosh</code>
     above survives the same drop; tmux is what survives you closing the laptop.</p>
  <pre>tmux new -s work              # start a named session
tmux attach -t work           # come back to it, from anywhere
# ctrl-b d detaches and leaves everything running</pre>
$_blog

  <h2>Comms &mdash; slash commands</h2>
  <p class="sub"><strong>Employees and contractors talk to us through the pit.</strong>
     Not email, not a private DM somewhere we cannot see it &mdash; open
     <code>moshcode</code> and use the slash commands. It keeps the conversation next
     to the work and reachable by everyone who needs it, and it means you do not need
     another account or another app to reach your lead.</p>
  <pre>/chat                         # the room -- ambient, where the team is
/message &lt;who&gt; &lt;text&gt;         # reach one person
/msg &lt;who&gt; &lt;text&gt;             # same thing, shorter</pre>
  <p class="sub">Type <code>/help</code> in the pit for the current list &mdash; it is
     the authority, and it grows. The SSH side of the network (rooms, IRC, Usenet,
     BBS mail) is <a href="https://$BBS_DOMAIN/">AgentBBS</a>, described above; the
     slash commands are the shortest path from where you are already working.</p>

  <h2>Billing</h2>
  <p class="sub">Contractors bill through the pit too, and it lands in
     <strong>CoinPay</strong> &mdash; so an invoice, its payment and its history are one
     record rather than a thread and a spreadsheet. Raise it against the work you did;
     do not send an invoice by email.</p>
  <pre>/invoice                      # raise an invoice
/payment                      # pay one, or check a payment
/billing                      # your account -- invoices, status, history</pre>
  <p class="sub">These front <a href="https://coinpayportal.com">CoinPay</a>, which is
     also wrapped as a tool if you would rather drive it directly:</p>
  <pre>moshcode tools coinpay        # or /tools coinpay from inside the pit</pre>

  <p class="sub">Two <strong>separate</strong> logins, and this trips everyone up.
     Both need <code>--device</code> here: there is no browser on this box, so the
     loopback flow has nothing to open. You approve the code from your laptop.</p>
  <pre>moshcode login --device       # app.moshcode.sh -- lets notify()/ask() reach you
moshcode whoami

moshcode secrets login --device   # LogicSRC -- team vaults. NOT the same account.
moshcode secrets whoami</pre>
  <p class="sub">Team secrets, once <code>secrets login</code> has been done &mdash;
     <code>&lt;team&gt;</code> and <code>&lt;vault&gt;</code> are your own names, run
     <code>teams list</code> and <code>teams vaults</code> to see them:</p>
  <pre>moshcode secrets teams list
moshcode secrets teams vaults &lt;team&gt;
moshcode secrets teams pull &lt;team&gt; &lt;vault&gt;   # decrypt into a local .env
moshcode secrets teams push &lt;team&gt; &lt;vault&gt;   # encrypt a local .env back up</pre>

  <h2>Your dev apps</h2>
  <p class="sub">Anything in <code>~/apps/&lt;name&gt;</code> is published at
     <code>https://&lt;name&gt;.&lt;you&gt;.$WEB_DOMAIN</code> with TLS. New apps go
     live within a minute &mdash; no root, no restart, no ticket.</p>
  <pre># a static site
mkdir -p ~/apps/blog/public &amp;&amp; echo hi &gt; ~/apps/blog/public/index.html

# a running app: declare the port, then listen on it
mkdir -p ~/apps/api &amp;&amp; echo 3000 &gt; ~/apps/api/.port
node server.js            # bind 127.0.0.1:3000, not 0.0.0.0</pre>
  <p class="sub">Websockets and HMR are proxied through, so vite/next dev servers
     work as-is. Bind to <code>127.0.0.1</code> &mdash; the firewall blocks the port
     directly and Caddy is what terminates TLS for you.</p>

  <h2>Stack</h2>
  <ul>
    <li><a href="https://nodejs.org/docs/latest/api/">Node.js<small>nodejs.org</small></a></li>
    <li><a href="https://pnpm.io/motivation">pnpm<small>pnpm.io</small></a></li>
    <li><a href="https://docs.deno.com/">Deno<small>docs.deno.com</small></a></li>
    <li><a href="https://bun.sh/docs">Bun<small>bun.sh/docs</small></a></li>
    <li><a href="https://mise.jdx.dev/">mise<small>mise.jdx.dev</small></a></li>
    <li><a href="https://supabase.com/docs">Supabase<small>supabase.com/docs</small></a></li>
    <li><a href="https://docs.turso.tech/">Turso<small>turso.tech &middot; SQLite in the cloud</small></a></li>
    <li><a href="https://caddyserver.com/docs/">Caddy<small>caddyserver.com</small></a></li>
    <li><a href="https://w3bs.org/packages">w3bs<small>w3bs.org/packages &middot; w3bs install &lt;tool&gt;</small></a></li>
    <li><a href="https://tailscale.com/kb">Tailscale<small>tailscale.com/kb</small></a></li>
  </ul>

  <h2>Access</h2>
  <p class="sub">Straight away, no setup:</p>
  <pre>ssh &lt;your-username&gt;@$WEB_DOMAIN
mosh &lt;your-username&gt;@$WEB_DOMAIN   # survives a dropped connection</pre>
  <p class="sub">Or add this to <code>~/.ssh/config</code> on your laptop and it becomes
     just <code>ssh dev</code>:</p>
  <pre>Host dev
    HostName $WEB_DOMAIN
    User &lt;your-username&gt;
    Port ${SSH_PORT}
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60</pre>
  <p class="sub">Send your public key (<code>~/.ssh/id_ed25519.pub</code>) to get added.</p>

  <h2>Tailscale on your phone or laptop</h2>
  <p class="sub">Optional, and it changes nothing today &mdash; the ssh above
     already works from anywhere. It only starts to matter if public ssh is ever
     closed. <strong>You cannot add your laptop from a shell on this box.</strong>
     Enrolling a device is something that device does, so it happens on the laptop
     or the phone; nothing you type here reaches it. Do not reach for
     <code>sudo</code> either &mdash; <code>tailscale up</code> run here
     re-authenticates <em>this box</em>, not your laptop, and takes it out from
     under everyone else logged in. Ask for a share link instead:</p>
  <pre># on your laptop or phone -- not here
# 1. install tailscale, sign in, make your own (free) tailnet.
#    that is where your devices get added: to yours, not ours.
# 2. open the share link you were sent and accept it. this box
#    then shows up in your tailnet, and nothing else of ours does.
ssh &lt;your-username&gt;@dev.&lt;tailnet&gt;.ts.net   # exact name is in the share link</pre>

  <footer>
    Your page lives in <code>~/public_html/index.html</code>.
    Reachable at <code>$proto://&lt;user&gt;.$WEB_DOMAIN</code> or <code>$proto://$WEB_DOMAIN/~&lt;user&gt;</code>.
  </footer>
</div>
<script>
// Copy buttons on the command blocks. Vanilla and inline on purpose: this page
// is written out by a shell script and served as a plain file, so there is no
// bundler to hang a dependency off, and one script tag costs nothing.
document.querySelectorAll('pre').forEach(function (pre) {
  // Read the text before the button is appended, or the button's own label
  // lands in the clipboard along with the commands.
  var text = pre.textContent;
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy';
  b.textContent = 'copy';
  b.setAttribute('aria-label', 'Copy to clipboard');
  b.addEventListener('click', function () {
    // The clipboard API needs a secure context; this vhost is https-only, so
    // the realistic failure is the user refusing permission. Say so rather
    // than leaving a button that looks like it worked.
    navigator.clipboard.writeText(text).then(function () {
      b.textContent = 'copied';
    }, function () {
      b.textContent = 'ctrl+c';
    });
    setTimeout(function () { b.textContent = 'copy'; }, 1400);
  });
  pre.appendChild(b);
});
</script>
EOF
	} | write_if_changed "$LANDING" 0644 && note "landing page"

	return 0
}
# Every top-level domain IANA delegates, from moshcoder/moshcode
# src/iana-tlds.mjs (Version 2026083000). Moshpit refuses to sell any of these,
# so "is the ending on this list" is exactly "could this be a clearnet name".
# Refresh by copying that file's list when it is regenerated.
IANA_TLDS="
aaa aarp abb abbott abbvie abc able abogado abudhabi ac academy accenture accountant accountants aco
actor ad ads adult ae aeg aero aetna af afl africa ag agakhan agency ai aig airbus airforce airtel
akdn al alibaba alipay allfinanz allstate ally alsace alstom am amazon americanexpress
americanfamily amex amfam amica amsterdam analytics android anquan anz ao aol apartments app apple
aq aquarelle ar arab aramco archi army arpa art arte as asda asia associates at athleta attorney au
auction audi audible audio auspost author auto autos aw aws ax axa az azure ba baby baidu banamex
band bank bar barcelona barclaycard barclays barefoot bargains baseball basketball bauhaus bayern bb
bbc bbt bbva bcg bcn bd be beats beauty beer berlin best bestbuy bet bf bg bh bharti bi bible bid
bike bing bingo bio biz bj black blackfriday blockbuster blog bloomberg blue bm bms bmw bn
bnpparibas bo boats boehringer bofa bom bond boo book booking bosch bostik boston bot boutique box
br bradesco bridgestone broadway broker brother brussels bs bt build builders business buy buzz bv
bw by bz bzh ca cab cafe cal call calvinklein cam camera camp canon capetown capital capitalone car
caravan cards care career careers cars casa case cash casino cat catering catholic cba cbn cbre cc
cd center ceo cern cf cfa cfd cg ch chanel channel charity chase chat cheap chintai christmas chrome
church ci cipriani circle cisco citadel citi citic city ck cl claims cleaning click clinic clinique
clothing cloud club clubmed cm cn co coach codes coffee college cologne com commbank community
company compare computer comsec condos construction consulting contact contractors cooking cool coop
corsica country coupon coupons courses cpa cr credit creditcard creditunion cricket crown crs cruise
cruises cu cuisinella cv cw cx cy cymru cyou cz dad dance data date dating datsun day dclk dds de
deal dealer deals degree delivery dell deloitte delta democrat dental dentist desi design dev dhl
diamonds diet digital direct directory discount discover dish diy dj dk dm dnp do docs doctor dog
domains dot download drive dtv dubai dupont durban dvag dvr dz earth eat ec eco edeka edu education
ee eg email emerck energy engineer engineering enterprises epson equipment er ericsson erni es esq
estate et eu eurovision eus events exchange expert exposed express extraspace fage fail fairwinds
faith family fan fans farm farmers fashion fast fedex feedback ferrari ferrero fi fidelity
fido film final finance financial fire firestone firmdale fish fishing fit fitness fj fk flickr
flights flir florist flowers fly fm fo foo food football ford forex forsale forum foundation fox fr
free fresenius frl frogans frontier ftr fujitsu fun fund furniture futbol fyi ga gal gallery gallo
gallup game games gap garden gay gb gbiz gd gdn ge gea gent genting george gf gg ggee gh gi gift
gifts gives giving gl glass gle global globo gm gmail gmbh gmo gmx gn godaddy gold goldpoint golf
goodyear goog google gop got gov gp gq gr grainger graphics gratis green gripe grocery group gs gt
gu gucci guge guide guitars guru gw gy hair hamburg hangout haus hbo hdfc hdfcbank health healthcare
help helsinki here hermes hiphop hisamitsu hitachi hiv hk hkt hm hn hockey holdings holiday
homedepot homegoods homes homesense honda horse hospital host hosting hot hotels hotmail house how
hr hsbc ht hu hughes hyatt hyundai ibm icbc ice icu id ie ieee ifm ikano il im imamat imdb immo
immobilien in inc industries infiniti info ing ink institute insurance insure int international
intuit investments io ipiranga iq ir irish is ismaili ist istanbul it itau itv jaguar java jcb je
jeep jetzt jewelry jio jll jm jmp jnj jo jobs joburg jot joy jp jpmorgan jprs juegos juniper kaufen
kddi ke kerryhotels kerryproperties kfh kg kh ki kia kids kim kindle kitchen kiwi km kn koeln
komatsu kosher kp kpmg kpn kr krd kred kuokgroup kw ky kyoto kz la lacaixa lamborghini lamer land
landrover lanxess lasalle lat latino latrobe law lawyer lb lc lds lease leclerc lefrak legal lego
lexus lgbt li lidl life lifeinsurance lifestyle lighting like lilly limited limo lincoln link live
living lk llc llp loan loans locker locus lol london lotte lotto love lpl lplfinancial lr ls lt ltd
ltda lu lundbeck luxe luxury lv ly ma madrid maif maison makeup man management mango map market
marketing markets marriott marshalls mattel mba mc mckinsey md me med media meet melbourne meme
memorial men menu merck merckmsd mg mh miami microsoft mil mini mint mit mitsubishi mk ml mlb mls mm
mma mn mo mobi mobile moda moe moi mom monash money monster mormon mortgage moscow moto motorcycles
mov movie mp mq mr ms msd mt mtn mtr mu museum music mv mw mx my mz na nab nagoya name navy nba nc
ne nec net netbank netflix network neustar new news next nextdirect nexus nf nfl ng ngo nhk ni nico
nike nikon ninja nissan nissay nl no nokia norton now nowruz nowtv np nr nra nrw ntt nu nyc nz obi
observer office okinawa olayan olayangroup ollo om omega one ong onl online ooo open oracle orange
org organic origins osaka otsuka ott ovh pa page panasonic paris pars partners parts party pay pccw
pe pet pf pfizer pg ph pharmacy phd philips phone photo photography photos physio pics pictet
pictures pid pin ping pink pioneer pizza pk pl place play playstation plumbing plus pm pn pnc pohl
poker politie porn post pr praxi press prime pro prod productions prof progressive promo properties
property protection pru prudential ps pt pub pw pwc py qa qpon quebec quest racing radio re read
realestate realtor realty recipes red redumbrella rehab reise reisen reit reliance ren rent rentals
repair report republican rest restaurant review reviews rexroth rich richardli ricoh ril rio rip ro
rocks rodeo rogers room rs rsvp ru rugby ruhr run rw rwe ryukyu sa saarland safe safety sakura sale
salon samsclub samsung sandvik sandvikcoromant sanofi sap sarl sas save saxo sb sbi sbs sc scb
schaeffler schmidt scholarships school schule schwarz science scot sd se search seat secure security
seek select sener services seven sew sex sexy sfr sg sh shangrila sharp shell shia shiksha shoes
shop shopping shouji show si silk sina singles site sj sk ski skin sky skype sl sling sm smart smile
sn sncf so soccer social softbank software sohu solar solutions song sony soy spa space sport spot
sr srl ss st stada staples star statebank statefarm stc stcgroup stockholm storage store stream
studio study style su sucks supplies supply support surf surgery suzuki sv swatch swiss sx sy sydney
systems sz tab taipei talk taobao target tatamotors tatar tattoo tax taxi tc tci td tdk team tech
technology tel temasek tennis teva tf tg th thd theater theatre tiaa tickets tienda tips tires tirol
tj tjmaxx tjx tk tkmaxx tl tm tmall tn to today tokyo tools top toray toshiba total tours town
toyota toys tr trade trading training travel travelers travelersinsurance trust trv tt tube tui
tunes tushu tv tvs tw tz ua ubank ubs ug uk unicom university uno uol ups us uy uz va vacations vana
vanguard vc ve vegas ventures verisign
versicherung vet vg vi viajes video vig viking villas vin vip virgin visa vision viva vivo
vlaanderen vn vodka volvo vote voting voto voyage vu wales walmart walter wang wanggou watch watches
weather weatherchannel web webcam weber website wed wedding weibo weir wf whoswho wien wiki
williamhill win windows wine winners wme woodside work works world wow ws wtc wtf xbox xerox xihuan
xin xn--11b4c3d xn--1ck2e1b xn--1qqw23a xn--2scrj9c xn--30rr7y xn--3bst00m xn--3ds443g xn--3e0b707e
xn--3hcrj9c xn--3pxu8k xn--42c2d9a xn--45br5cyl xn--45brj9c xn--45q11c xn--4dbrk0ce xn--4gbrim
xn--54b7fta0cc xn--55qw42g xn--55qx5d xn--5su34j936bgsg xn--5tzm5g xn--6frz82g xn--6qq986b3xl
xn--80adxhks xn--80ao21a xn--80aqecdr1a xn--80asehdb xn--80aswg xn--8y0a063a xn--90a3ac xn--90ae
xn--90ais xn--9dbq2a xn--9et52u xn--9krt00a xn--b4w605ferd xn--bck1b9a5dre4c xn--c1avg xn--c2br7g
xn--cck2b3b xn--cckwcxetd xn--cg4bki xn--clchc0ea0b2g2a9gcd xn--czr694b xn--czrs0t xn--czru2d
xn--d1acj3b xn--d1alf xn--e1a4c xn--eckvdtc9d xn--efvy88h xn--fct429k xn--fhbei xn--fiq228c5hs
xn--fiq64b xn--fiqs8s xn--fiqz9s xn--fjq720a xn--flw351e xn--fpcrj9c3d xn--fzc2c9e2c
xn--fzys8d69uvgm xn--g2xx48c xn--gckr3f0f xn--gecrj9c xn--gk3at1e xn--h2breg3eve xn--h2brj9c
xn--h2brj9c8c xn--hxt814e xn--i1b6b1a6a2e xn--imr513n xn--io0a7i xn--j1aef xn--j1amh xn--j6w193g
xn--jlq480n2rg xn--jvr189m xn--kcrx77d1x4a xn--kprw13d xn--kpry57d xn--kput3i xn--l1acc
xn--lgbbat1ad8j xn--mgb9awbf xn--mgba3a3ejt xn--mgba3a4f16a xn--mgba7c0bbn0a xn--mgbaam7a8h
xn--mgbab2bd xn--mgbah1a3hjkrd xn--mgbai9azgqp6j xn--mgbayh7gpa xn--mgbbh1a xn--mgbbh1a71e
xn--mgbc0a9azcg xn--mgbca7dzdo xn--mgbcpq6gpa1a xn--mgberp4a5d4ar xn--mgbgu82a xn--mgbi4ecexp
xn--mgbpl2fh xn--mgbt3dhd xn--mgbtx2b xn--mgbx4cd0ab xn--mix891f xn--mk1bu44c xn--mxtq1m
xn--ngbc5azd xn--ngbe9e0a xn--ngbrx xn--node xn--nqv7f xn--nqv7fs00ema xn--nyqy26a xn--o3cw4h
xn--ogbpf8fl xn--otu796d xn--p1acf xn--p1ai xn--pgbs0dh xn--pssy2u xn--q7ce6a xn--q9jyb4c
xn--qcka1pmc xn--qxa6a xn--qxam xn--rhqv96g xn--rovu88b xn--rvc1e0am3e xn--s9brj9c xn--ses554g
xn--t60b56a xn--tckwe xn--tiq49xqyj xn--unup4y xn--vermgensberater-ctb xn--vermgensberatung-pwb
xn--vhquv xn--vuq861b xn--w4r85el8fhu5dnra xn--w4rs40l xn--wgbh1c xn--wgbl6a xn--xhq521b
xn--xkc2al3hye2a xn--xkc2dl3a5ee0h xn--y9a3aq xn--yfro4i67o xn--ygbi2ammx xn--zfr164b xxx xyz yachts
yahoo yamaxun yandex ye yodobashi yoga yokohama you youtube yt yun za zappos zara zero zip zm zone
zuerich zw
"
# ------------------------------------------------------------------ users ---

# A key-only account's password field is '*', NOT the '!' useradd and
# passwd -l leave. OpenSSH built without PAM -- Alpine's default sshd --
# treats a '!' password as a locked ACCOUNT and refuses even a valid key
# ("User alice not allowed because account is locked"); with PAM, as on
# Ubuntu, it never looks. '*' matches no password and locks nothing else.
_key_only() { usermod -p '*' "$1" >/dev/null 2>&1; }

create_user() {
	local spec="$1" groups="$2" login home pass g shell
	shell="$(command -v zsh 2>/dev/null || echo /bin/zsh)"
	login="$(user_login "$spec")"

	# A tenant's shell on THIS box is nologin, and their password is locked.
	# Their real shell is inside their own instance, reached on their own port;
	# there is deliberately no path from here into anything of ours.
	[[ "$SANDBOX" == 1 ]] && shell="$SANDBOX_NOLOGIN"

	if id -u "$login" >/dev/null 2>&1; then
		info "user $login already exists"
	else
		info "creating user $login"
		useradd -m -s "$shell" -c "$spec" "$login" || { warn "useradd $login failed"; return 1; }
		if [[ "$SANDBOX" == 1 ]]; then
			passwd -l "$login" >/dev/null
		elif interactive; then
			read -r -s -p "    password for ${login} (blank = key-only login): " pass; echo
			if [[ -n "$pass" ]]; then
				printf '%s:%s\n' "$login" "$pass" | chpasswd
			else
				_key_only "$login"
			fi
			unset pass
		else
			_key_only "$login"
		fi
	fi

	# sshd here has PasswordAuthentication off, so a user with no key of their
	# own simply cannot log in -- ask for it now rather than let that surprise
	# them later. Stored in the repo so re-runs and rebuilds keep working.
	if interactive && [[ ! -s "$KEYS_DIR/$login.pub" ]]; then
		echo "    ${login} needs their own public key to log in (password auth is off)."
		read -r -p "    paste ${login}'s ssh public key (blank to skip): " pubkey
		if [[ -n "${pubkey// }" ]]; then
			if [[ "$pubkey" =~ ^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-ssh-|sk-ecdsa-) ]]; then
				install -d -m 0755 "$KEYS_DIR"
				printf '%s\n' "$pubkey" >"$KEYS_DIR/$login.pub"
				info "saved ssh-keys/$login.pub"
			else
				warn "that does not look like an ssh public key -- skipped"
			fi
		fi
		unset pubkey
	fi

	[[ "$SANDBOX" == 1 ]] || ensure_zsh_shell "$login" \
		|| warn "$login may still be on bash"

	for g in ${groups//,/ }; do
		getent group "$g" >/dev/null || groupadd "$g" || { warn "cannot create group $g"; continue; }
		usermod -aG "$g" "$login" || warn "could not add $login to $g"
	done
	info "$login groups: $(id -nG "$login")"

	refresh_user "$login"
	remember_user "$login"

	# Last, because the instance mounts the home this run has just finished
	# writing into -- dotfiles, and above all ~/.ssh/authorized_keys, which is
	# how the tenant gets into their own machine.
	if [[ "$SANDBOX" == 1 ]]; then
		create_sandbox "$login" "$SANDBOX_KIND" \
			|| warn "$login has an account but no instance yet (try: $0 sandbox create $login)"
	fi
	return 0
}

# What a re-run does to an account that already exists: no useradd, no
# password, no group changes, no questions -- just bring the files we own up
# to date and re-assert the permissions sshd and Caddy depend on.
refresh_user() {
	local login="$1" home
	home="$(user_home "$login")"
	[[ -n "$home" && -d "$home" ]] || { warn "no home dir for $login"; return 1; }

	# Adopted accounts arrive on whatever shell the cloud image gave them --
	# /home/ubuntu is the usual one. Without this a refresh left them on bash
	# forever while installing a zsh setup around them. ensure_zsh_shell only
	# converts from bash/sh, so a deliberate choice of anything else stands.
	# Not for a tenant: their login shell here is nologin on purpose, and
	# ensure_zsh_shell would leave a "chose nologin -- left alone" line on every
	# run for something that is not a choice at all.
	_is_tenant "$login" || ensure_zsh_shell "$login" \
		|| warn "$login may still be on bash"

	install_dotfiles "$home" "$login"
	install_public_html "$home" "$login"
	install_dev_apps_dir "$home" "$login"
	# An ssh-agent for an account that cannot open a session is a unit that
	# will never start.
	_is_tenant "$login" || enable_ssh_agent_for "$login"
	# last word on permissions, after everything has written into the home
	fix_home_permissions "$home" "$login" || warn "$login home permissions need attention"

	# The instance last: it mounts this home, so everything above has to have
	# landed first.
	if [[ "$SKIP_SANDBOX" != 1 ]] && _is_tenant "$login"; then
		refresh_sandbox "$login" || warn "$login's instance needs attention"
	fi
	return 0
}

# Before the accounts: creating a tenant needs a pool, a bridge and a profile
# to exist, and reconciling one needs the daemon up. A box with no tenants and
# SANDBOX=0 does none of this and never installs incus.
if [[ "$SKIP_SANDBOX" == 1 ]]; then
	log "skipping sandboxes (--skip-sandbox)"
elif _sandbox_configured; then
	log "configuring sandboxed tenants"
	if try "incus" install_incus; then
		try "sandbox init" sandbox_init
	fi
fi

# Before the accounts, so that the unit is already in place by the time
# refresh_user turns on lingering for each of them.
log "installing the ssh-agent user service"
try "ssh-agent" install_ssh_agent

if [[ ${#USERS[@]} -gt 0 ]]; then
	log "creating users"
	for i in "${!USERS[@]}"; do
		try "user ${USERS[$i]}" create_user "${USERS[$i]}" "${USER_GROUPS[$i]}"
	done
fi

if [[ ${#KNOWN_USERS[@]} -gt 0 ]]; then
	log "refreshing existing users"
	for _l in "${KNOWN_USERS[@]}"; do
		try "refresh $_l" refresh_user "$_l"
		remember_user "$_l"
	done
	unset _l
fi

# After every account exists and has its groups, because who is confined is
# decided by group membership -- and before the tools, so that anything the
# rest of the run installs into a home lands under the new umask.
if [[ "$CONFINE" == 1 ]]; then
	log "confining accounts (confine)"
	try "confine" configure_confinement
else
	log "confine is OFF (CONFINE=0) -- accounts are not confined"
fi

log "installing dotfiles for root"
try "root dotfiles" install_dotfiles /root root
# our .zshrc has a dedicated root prompt, so root runs zsh too
try "root login shell -> zsh" ensure_zsh_shell root
# root does not go through refresh_user, so it needs its own linger
enable_ssh_agent_for root

if [[ "$SKIP_TOOLS" == 1 ]]; then
	log "skipping oh-my-zsh/mise/moshcode (--skip-tools)"
else
	log "installing/updating oh-my-zsh, mise and the w3bs catalog tools"
	# these installers are all "fetch the current version and put it in place",
	# so running them again is exactly how the box picks up new releases
	while read -r login; do
		[[ -n "$login" ]] || continue
		id -u "$login" >/dev/null 2>&1 || continue
		# These are curl|sh installers that read the account's own dotfiles.
		# For a tenant they run inside their instance (_sandbox_tools), never
		# out here -- running them here would give a customer host-side code
		# execution under their own uid, which is the one thing the container
		# is for.
		if _is_tenant "$login"; then
			info "$login is a tenant -- tools installed inside their instance"
			continue
		fi
		try "oh-my-zsh ($login)" install_omz "$login"
		try "mise ($login)"      install_mise "$login"
		if [[ "$WITH_MOSHCODE" == 1 ]]; then
			try "moshcode ($login)"  install_moshcode "$login"
			# separate step: installing moshcode does not update what it manages
			try "moshcode tools ($login)" update_moshcode_tools "$login"
		fi
		try "threatcrush ($login)" install_threatcrush "$login"
		try "hqterm/hqsh ($login)" install_hqsh "$login"
		[[ "$WITH_SH1PT" == 1 ]] && try "sh1pt ($login)" install_sh1pt "$login"
	done < <(printf 'root\n'; all_logins)

	# One enforcing daemon per box, once, as root -- not per login. Explicit
	# fleet-wide opt-in (see enable_threatcrush_daemon). Runs only on the host;
	# tenants get the CLI inside their own instance, never a root daemon on shared
	# infrastructure.
	try "threatcrush daemon (root)" enable_threatcrush_daemon
fi

# ---------------------------------------------------------------- wrap up ---

if [[ "$SKIP_TAILSCALE" == 1 ]]; then
	log "skipping tailscale (--skip-tailscale)"
else
	log "installing tailscale"
	try "tailscale" install_tailscale
fi

PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
	|| ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4; exit}')"

if [[ "$SKIP_WEB" == 1 ]]; then
	log "skipping web/TLS (--skip-web)"
else
	log "configuring per-user web hosting on $WEB_DOMAIN"

	# DNS first: Caddy asks for a certificate for every name it serves, and
	# the CA can only issue one for a name that already resolves here.
	if [[ -n "$PORKBUN_API_KEY" && -n "$PORKBUN_SECRET_API_KEY" ]]; then
		try "dns records at porkbun" ensure_dns_records "$PUBLIC_IP"
	fi

	try "caddy" configure_caddy
fi

# only when it is actually wrong -- otherwise this is noise on every run
# Alpine with no /etc/localtime is already UTC; a box set to anything else
# gets the link back, from tzdata (a bootstrap package).
if [[ -e /etc/localtime && "$(readlink -f /etc/localtime 2>/dev/null)" != */UTC ]] && ! _in_container; then
	if [[ -e /usr/share/zoneinfo/UTC ]]; then
		ln -sfn /usr/share/zoneinfo/UTC /etc/localtime && note "timezone -> UTC"
	fi
fi

touch "$STATE_DIR/provisioned"

echo
if [[ ${#FAILED[@]} -gt 0 ]]; then
	warn "${#FAILED[@]} step(s) failed:"
	printf '       - %s\n' "${FAILED[@]}" >&2
else
	log "all steps completed"
fi

# What a re-run actually did. On a settled box this list should be empty --
# that is the point.
echo
if [[ ${#CHANGED[@]} -gt 0 ]]; then
	log "changed this run (${#CHANGED[@]})"
	printf '       - %s\n' "${CHANGED[@]}"
else
	log "nothing changed -- the box was already up to date"
fi

# Files we would have updated but did not, because someone had edited them.
if [[ ${#PRESERVED[@]} -gt 0 ]]; then
	echo
	warn "${#PRESERVED[@]} file(s) kept as the user left them; the new version is beside them as .new:"
	printf '       - %s\n' "${PRESERVED[@]}" >&2
	info "      diff them, or re-run with --force-dotfiles to overwrite (a .bak is kept)"
fi

echo
info "w3bs: $("$(w3bs_bin 2>/dev/null || echo w3bs)" --version 2>/dev/null || echo 'MISSING')"
info "init: $(detect_init)"
info "ufw:  $(ufw status 2>/dev/null | head -1 || echo 'not installed')"
info "open: $(ufw status 2>/dev/null | awk '/ALLOW/ && !/\(v6\)/ {printf "%s ", $1}')"
info "web:  caddy $(caddy version 2>/dev/null | awk '{print $1}') -- $( svc_is_active caddy && echo running || echo 'not running') (TLS: $WEB_TLS)"
info "mosh: $(command -v mosh-server >/dev/null && echo "$(mosh-server --version 2>&1 | head -1)" || echo 'MISSING')"
info "tail: $(tailscale ip -4 2>/dev/null | head -1 || echo 'not joined to a tailnet')"
info "motd: $([[ -s $MOTD_CACHE ]] && echo "cached ($(wc -l <"$MOTD_CACHE") lines)" || echo 'empty')"
info "ram:  $(free -h 2>/dev/null | awk '/^Mem:/{printf "%s total, %s available", $2, $7}')"
info "swap: $(swapon --show=NAME,SIZE --noheadings 2>/dev/null | awk '{printf "%s (%s) ", $1, $2}' | grep . || echo 'NONE -- one memory spike from the OOM killer')"
echo
printf '    %-12s %-6s %-6s %-9s %-6s %-5s %s\n' USER OMZ MISE MOSHCODE TMUX APPS SHELL
while read -r login; do
	[[ -n "$login" ]] || continue
	id -u "$login" >/dev/null 2>&1 || continue
	h="$(user_home "$login")"
	printf '    %-12s %-6s %-6s %-9s %-6s %-5s %s\n' "$login" \
		"$([[ -d "$h/.oh-my-zsh" ]]        && echo ok || echo MISS)" \
		"$([[ -x "$h/.local/bin/mise" ]]   && echo ok || echo MISS)" \
		"$([[ "$WITH_MOSHCODE" != 1 ]] && echo off || { [[ -e "$h/.local/bin/moshcode" || -e "$h/.moshcode" ]] && echo ok || echo '?'; })" \
		"$([[ -e "$h/.tmux.conf" ]]        && echo ok || echo MISS)" \
		"$(find "$h/apps" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)" \
		"$(getent passwd "$login" | cut -d: -f7)"
done < <(printf 'root\n'; all_logins)

if [[ -s "$SANDBOX_TENANTS" ]]; then
	echo
	log "sandboxed tenants"
	_sandbox_list
	info "their shell is inside their own instance -- none of them can run anything out here"
fi

# Flag anyone who cannot actually get in. With sshd refusing passwords, a
# locked password plus no personal key means no login at all -- which otherwise
# only shows up when they try and get "Permission denied".
_pwauth="$(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
echo
info "sshd passwordauthentication: ${_pwauth:-unknown}"
while read -r l; do
	[[ -n "$l" ]] || continue
	id -u "$l" >/dev/null 2>&1 || continue
	h="$(user_home "$l")"
	_pw="$(passwd -S "$l" 2>/dev/null | awk '{print $2}')"   # P=set L=locked NP=none
	# Report on the file that actually decides whether they can get in, not on
	# what this script would have put there. Nothing is added to
	# authorized_keys unless ssh-keys/<login>.pub exists, so an empty file
	# really does mean no way in.
	_nkeys=0
	[[ -s "$h/.ssh/authorized_keys" ]] \
		&& _nkeys="$(grep -cvE '^[[:space:]]*(#|$)' "$h/.ssh/authorized_keys" 2>/dev/null || echo 0)"
	# The Alpine-only trap (see _key_only): a '!' password on a sshd without
	# PAM refuses the account outright, keys and all.
	if ! _is_tenant "$l" && [[ -n "$_pwauth" ]] && ! _sshd_uses_pam \
		&& [[ "$(getent shadow "$l" 2>/dev/null | cut -d: -f2)" == '!'* ]]; then
		warn "$l has a '!' (locked) password: this sshd (no PAM) refuses even their keys -- usermod -p '*' $l"
	fi
	if [[ "$_nkeys" -eq 0 ]]; then
		if [[ "$_pwauth" == no ]]; then
			warn "$l has NO keys in ~/.ssh/authorized_keys and sshd refuses passwords -- they cannot log in"
		elif [[ "$_pw" == L ]]; then
			# passwd -S says L for '*' (key-only, on purpose) as well as '!'
			warn "$l has no keys and no usable password"
		fi
		info "      fix: put their public key in ssh-keys/$l.pub and re-run, or"
		info "           echo '<their key>' >> $h/.ssh/authorized_keys"
	elif _is_tenant "$l"; then
		# Same file, read by the sshd inside their instance: the home is shared,
		# so authorising a key here authorises it there.
		read -r _sp _al _ah _ml _mh < <(_tenant_ports "$(_tenant_slot "$l")")
		info "$l: $_nkeys key(s) authorised -- ssh -p $_sp $l@$WEB_DOMAIN (tenant)"
	else
		info "$l: $_nkeys key(s) authorised"
	fi
done < <(all_logins)

echo
info "DNS records required for $WEB_DOMAIN (point at this host):"
info "    A    $WEB_DOMAIN      ->  ${PUBLIC_IP:-<this server ip>}"
info "    A    *.$WEB_DOMAIN    ->  ${PUBLIC_IP:-<this server ip>}"
if [[ "$DEV_APPS" == 1 ]]; then
	# DNS wildcards match ONE label, so *.dev.example.com does not answer for
	# api.alice.dev.example.com. Each user needs their own.
	while read -r l; do
		info "    A    *.$l.$WEB_DOMAIN  ->  ${PUBLIC_IP:-<this server ip>}   (${l}'s dev apps)"
	done < <(web_users)
fi
case "$WEB_TLS" in
	auto)     info "tls:  Caddy issues and renews a certificate per name, once its DNS points here" ;;
	internal) info "tls:  Caddy's local CA (WEB_TLS=internal) -- browsers warn until it is trusted" ;;
	off)      info "tls:  off (WEB_TLS=off) -- plain http" ;;
esac
while read -r l; do
	info "    https://$WEB_DOMAIN/~$l  |  https://$l.$WEB_DOMAIN"
	if [[ "$DEV_APPS" == 1 ]]; then
		info "        dev apps: mkdir ~/apps/<name>  ->  https://<name>.$l.$WEB_DOMAIN"
		# A tenant's .port is only honoured inside their own band, so the band
		# belongs next to the instruction rather than in a manual somewhere.
		if _is_tenant "$l"; then
			read -r _sp _al _ah _ml _mh < <(_tenant_ports "$(_tenant_slot "$l")")
			info "        ...on a port in $_al-$_ah (theirs); anything else is ignored"
		fi
	fi
done < <(all_logins)

# ---------------------------------------------------------------- reboot ---
#
# This script is re-run on a live box, so a reboot is never the default. Even
# when one is genuinely required, someone may be mid-session -- so say who is
# logged in and let a human decide.
echo
_reboot_required=0
reboot_required && _reboot_required=1
if [[ "$_reboot_required" == 1 ]]; then
	warn "a reboot is required: the running kernel $(uname -r) has no modules left (the kernel was upgraded)"
else
	info "no reboot required"
fi

_sessions="$(who 2>/dev/null | wc -l)"
[[ "$_sessions" -gt 0 ]] && info "logged in right now: $(who 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"

if [[ "$REBOOT_POLICY" == 0 ]]; then
	[[ "$_reboot_required" == 1 ]] && info "not rebooting (--no-reboot); do it when it suits you"
elif [[ "$_reboot_required" == 0 && "$REBOOT_POLICY" != 2 ]]; then
	: # nothing to do
elif ! interactive; then
	# an unattended maintenance run must never take the box down by itself
	warn "reboot required, but this run is unattended -- not rebooting"
	info "      run 'doas reboot' when the box is free"
elif confirm "Reboot now? ${_sessions:+($_sessions session(s) open) }[y/N]" n; then
	info "rebooting in 5s..."
	sleep 5
	reboot
fi
