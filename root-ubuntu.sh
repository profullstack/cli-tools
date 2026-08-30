#!/usr/bin/env bash
#
# root-ubuntu.sh -- bootstrap AND maintain an Ubuntu/Debian server as root.
#
# Sets up the standard dev environment and manages the accounts on the box.
# One file, no dependencies beyond what a stock Ubuntu image already has, so it
# can be curled onto a machine that has nothing on it yet:
#
#   curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/root-ubuntu.sh | bash -s -- --refresh
#
# bash, NOT sh. /bin/sh on Ubuntu is dash, this script is bash throughout, and
# piping it into sh fails on the first [[ with a syntax error that names a line
# nobody typed. There is a guard below that says so in one sentence instead.
#
# Piping it gives a NON-INTERACTIVE run: stdin is the script, so there is no
# terminal to prompt at, and every prompt in here is guarded on one (see
# `interactive`). That is the safe direction to fail -- an unattended run takes
# defaults rather than reading answers out of its own source. To be asked the
# questions, download it and run it as a file:
#
#   curl -fsSLO https://raw.githubusercontent.com/profullstack/cli-tools/master/root-ubuntu.sh
#   chmod +x root-ubuntu.sh && ./root-ubuntu.sh          # as root
#
# Safe to re-run, and re-running is the supported way to pick up updates: it
# upgrades packages and tooling, refreshes anything it owns, and leaves anything
# a user has since edited alone (see install_managed below).
#
# Deliberately minimal. Language runtimes/tools come from mise, not apt.
#   1. accounts + groups; users provisioned by an earlier run are picked up
#      automatically and refreshed
#   2. apt update/upgrade + unattended security updates
#   3. ufw
#   4. a 2G swapfile, if the box has no swap at all
#   5. dotfiles (.zsh*, .bash*, .ssh*, ...) from $DOTFILES_REPO, if you have one
#   6. oh-my-zsh + plugins, oh-my-tmux, irssi configs
#   7. mise      (curl https://mise.run | sh)
#   8. moshcode  (curl https://moshcode.sh/install.sh | sh)
#   9. a per-user ssh-agent as a systemd user service
#  10. motd from $MOTD_URL
#  11. nginx per-user pages, per-user dev apps, TLS
#
# Usage, as root:
#   ./root-ubuntu.sh                        # first run, or a refresh
#   ./root-ubuntu.sh alice bob              # ...and provision two accounts
#   ./root-ubuntu.sh alice --groups sudo,docker
#   ./root-ubuntu.sh --refresh              # update everything, ask nothing
#
# Remote shares (see "remote shares" below for the full options):
#   ./root-ubuntu.sh mount user@host:~/data --via peer
#   ./root-ubuntu.sh mounts                 # list what is mounted, and who can reach it
#   ./root-ubuntu.sh umount host
#   ./root-ubuntu.sh share /mnt/volume -R   # open an existing volume
#   ./root-ubuntu.sh share /mnt/volume --group www-data -R
#                                           # ...to a second group as well (acl)
#
# Accounts and groups (see "accounts" below, or `groups --help`):
#   ./root-ubuntu.sh groups                 # every account, and the groups it is in
#   ./root-ubuntu.sh groups add alice docker
#   ./root-ubuntu.sh groups rm alice docker
#   ./root-ubuntu.sh groups set alice sudo,admin,users
#   ./root-ubuntu.sh groups create|delete|members <group>...
#
# Mounts land at /mnt/<how>.<host>/<remote/path> -- e.g.
# /mnt/tailscale.host/data -- so a remote share is never mistaken for local
# disk, and are persisted to /etc/fstab. They are reachable at the short path
# ~/share/<name>.
#
# Mounts are shared (2775 root:users, 0664 files): every human account can write
# to them. These are team boxes, and a volume only the person who ran the mount
# can write to is the failure that keeps happening -- provider-attached block
# volumes especially, which arrive root:root 0755 and stay that way. Use
# `share` to fix one that is already mounted, and mount --private for a share
# that really does belong to one account.
#
# Flags:
#   --refresh          non-interactive update pass over the existing box
#   --groups LIST      groups for the accounts named on this run (no prompt)
#   --force-dotfiles   overwrite user-edited dotfiles (a .bak is kept)
#   --no-reboot        never reboot, whatever apt says
#   --reboot           reboot at the end if the kernel/libc asked for one
#   --skip-apt / --skip-web / --skip-tailscale / --skip-tools / --skip-dotfiles
#   -h | --help
#
# Configuration, in order of precedence: the environment, then $SERVER_CONFIG
# (default /etc/cli-tools/server.conf). The file is KEY=value, one per line, #
# for comments -- read rather than sourced, so nothing in it executes and the
# environment still wins. Deliberately not JSON, because this runs before apt
# has put jq on the box and a bootstrap script that cannot read its own config
# until it has installed a parser is a bootstrap script with a hole in it.
# Every value below can go in it, and a re-run then needs no environment at all:
#
#   WEB_DOMAIN=dev.example.com
#   ACME_EMAIL=ops@example.com
#   DOTFILES_REPO=git@github.com:example/dotfiles.git
#
# Env overrides:
#   SSH_PORT=22    port to open in ufw
#   SWAP_SIZE=2G   swapfile to create when the box has no swap (0 = never)
#   SWAP_FILE=/swapfile   where that file goes
#   SWAPPINESS=10  vm.swappiness once there is swap to speak of
#   ASSUME_YES=1   don't prompt (defaults: $DEFAULT_GROUPS; no privkey copy)
#   DEFAULT_GROUPS=... groups an account lands in when --groups is not passed
#                  (default sudo,admin). An unattended run never prompts, so
#                  this is what every account it creates gets.
#   NO_REBOOT=1    skip the reboot at the end
#   MOTD_URL=...   override the motd endpoint
#   TS_AUTHKEY=... tailscale auth key, to join the tailnet unattended
#   TS_HOSTNAME=.. name this node takes on the tailnet (default: short hostname)
#   WEB_DOMAIN=... domain for the per-user pages
#   DEV_APPS=0     turn off <app>.<user>.$WEB_DOMAIN hosting
#   DOTFILES_REPO=... git URL of the dotfiles to install (optional)
#   SPONSOR_AD_SLOT=... ad slot id; the ad is off until one is set
#   PORKBUN_API_KEY=... PORKBUN_SECRET_API_KEY=...
#                  DNS-01 credentials for the wildcard cert. Without them:
#                  http only, no wildcard.
#   CLOUDFLARE_API_TOKEN=...  same, for zones hosted at Cloudflare instead
#
# --- on being re-runnable -----------------------------------------------
# Every step is written to converge, not to assume a blank machine:
#   * files we own are rewritten only when the content actually changes, so
#     nginx is not reloaded and services are not restarted for nothing
#   * files a USER owns (.zshrc, .gitconfig, .irssi/config, ~/public_html)
#     are never clobbered once they have diverged from what we shipped
#   * no reboot unless the box says one is required AND you agree to it
#   * a lock file makes two concurrent runs impossible
#
# --- on secrets ---------------------------------------------------------
# There are none in this file and there must never be. It is public, it is
# curled onto machines by strangers, and every credential it can use is read
# from the environment or from $SERVER_CONFIG. In particular there is no
# default ad slot: a shared slot bills every install's impressions to one
# account, which is somebody else's bill.

# Deliberately POSIX so that dash can parse and run it: this is the one thing in
# the file that has to work in the wrong shell, because its whole job is to say
# so. Everything past it is bash.
if [ -z "${BASH_VERSION:-}" ]; then
	echo "root-ubuntu.sh: this is a bash script and you are running it under sh." >&2
	echo "  curl -fsSL <url>/root-ubuntu.sh | bash -s -- --refresh" >&2
	echo "  ...or: bash root-ubuntu.sh" >&2
	exit 1
fi

set -uo pipefail

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
# Without that record a re-run cannot tell "we wrote this" from "the user
# wrote this", and the only safe answer would be to never update anything.
STATE_DIR="${STATE_DIR:-/var/lib/profullstack}"
USERS_STATE="$STATE_DIR/users"
LOCK_FILE=/var/lock/root-ubuntu.lock
LOG_FILE="${LOG_FILE:-/var/log/root-ubuntu.log}"

FORCE_DOTFILES="${FORCE_DOTFILES:-0}"
SKIP_APT="${SKIP_APT:-0}"
SKIP_WEB="${SKIP_WEB:-0}"
SKIP_TAILSCALE="${SKIP_TAILSCALE:-0}"
SKIP_TOOLS="${SKIP_TOOLS:-0}"
SKIP_DOTFILES="${SKIP_DOTFILES:-0}"
# 0 = never, 1 = only if the box says a reboot is required, 2 = always ask
REBOOT_POLICY=1

# Dotfiles are OPTIONAL and they are not in this repository.
#
# They cannot be: a dotfiles tree carries ssh config, known_hosts, sometimes
# keys, and this file is public. So the shell/editor/tmux/irssi configuration a
# team wants on its boxes lives in that team's own repo, and this clones it if
# you name one. With no DOTFILES_REPO the box still gets everything else --
# packages, firewall, accounts, zsh, oh-my-zsh, mise, moshcode, nginx, TLS --
# and simply keeps whatever dotfiles each account already had.
#
# DOTFILES_DIR points at an existing checkout instead, which is what a run from
# inside such a repo wants: put this script beside the dotfiles and it uses
# them without cloning anything.
DOTFILES_REPO="${DOTFILES_REPO:-}"
DOTFILES_DIR="${DOTFILES_DIR:-}"
DOTFILES_CACHE="${DOTFILES_CACHE:-$STATE_DIR/dotfiles-src}"

# Where a pasted public key is filed so that re-runs and rebuilds keep working.
# In a dotfiles checkout it belongs with the dotfiles, so the whole team's keys
# travel together; without one it still has to persist somewhere, and that is
# the state directory.
KEYS_DIR="${KEYS_DIR:-}"

# Tailscale. TS_AUTHKEY joins the tailnet unattended; without it the script
# prints the command to run by hand.
TS_AUTHKEY="${TS_AUTHKEY:-}"
TS_HOSTNAME="${TS_HOSTNAME:-$(hostname -s)}"

# Per-user web hosting: https://WEB_DOMAIN/~user and https://user.WEB_DOMAIN
WEB_DOMAIN="${WEB_DOMAIN:-dev.profullstack.com}"
# each user's address is <login>@MAIL_DOMAIN
MAIL_DOMAIN="${MAIL_DOMAIN:-profullstack.com}"
# Where the landing page sends people for mail and webmail. Both are only
# links, so a box for a different domain needs nothing here but these two.
MAIL_URL="${MAIL_URL:-https://forwardemail.net/}"
# the comms network, reached over ssh
BBS_DOMAIN="${BBS_DOMAIN:-bbs.profullstack.com}"
WEBMAIL_URL="${WEBMAIL_URL:-https://mail.forwardemail.net/}"
# Wildcard certs require a DNS-01 challenge. Provide a Cloudflare API token
# either in the environment or in CF_CREDENTIALS (ini format certbot expects).
CF_CREDENTIALS="${CF_CREDENTIALS:-/etc/letsencrypt/cloudflare.ini}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
PORKBUN_API_KEY="${PORKBUN_API_KEY:-}"
PORKBUN_SECRET_API_KEY="${PORKBUN_SECRET_API_KEY:-}"
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
# No default, and no personal address baked in. Let's Encrypt uses it only for
# expiry warnings; issuance works without one, and the _issue_cert_* helpers
# say so once rather than failing.
ACME_EMAIL="${ACME_EMAIL:-}"
ACME_WEBROOT="${ACME_WEBROOT:-/var/www/acme}"
CERT_DIR="/etc/letsencrypt/live/$WEB_DOMAIN"
# reissue once the cert has this little life left
CERT_RENEW_DAYS="${CERT_RENEW_DAYS:-30}"
COPY_SSH_PRIVATE_KEYS="${COPY_SSH_PRIVATE_KEYS:-0}"

# Per-user dev apps: https://<app>.<user>.$WEB_DOMAIN
# Static from ~/apps/<app>/public, or reverse-proxied to 127.0.0.1:<port>
# when ~/apps/<app>/.port holds a port number.
DEV_APPS="${DEV_APPS:-1}"
DEV_APPS_MAP=/etc/nginx/conf.d/profullstack-devapps.conf

# Block AI/LLM crawlers and aggressive scrapers by User-Agent.
#
# Search engines are deliberately NOT in the list: blocking Googlebot/Bingbot
# would deindex the box rather than protect it. What gets blocked is the
# training/scraping crawlers, which ignore robots.txt often enough that the
# polite file alone is not a control.
#
# The map is written even when this is 0 (with no entries, so $bad_bot is
# always empty). nginx refuses to start when a vhost references a variable no
# map defines -- the same trap DEV_APPS_MAP documents -- so the variable must
# exist unconditionally, and only its contents are conditional.
BLOCK_AI_BOTS="${BLOCK_AI_BOTS:-1}"
BAD_BOTS_MAP=/etc/nginx/conf.d/profullstack-badbots.conf

# Substrings matched case-insensitively against the User-Agent. Grouped so it
# is obvious what each entry is and nothing gets removed by guesswork.
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

# Sponsor ad shown at the top of the per-user pages: the directory listings
# under ~/public_html, and the default ~/public_html/index.html.
#
# The endpoint returns plain ASCII sized to a column count -- it is the same
# feed the terminal/motd banners use, and it hands back a different creative
# each time you ask.
#
# The ad rotates per page load, but it is NOT fetched per page load: that would
# put an external host in the critical path of every request, and one slow
# response would stall the page. Instead a timer keeps a pool of $SPONSOR_AD_POOL
# pre-rendered creatives on disk and nginx picks one at random per request
# (random_index). Rotation costs one open(); a dead endpoint just stops the pool
# from refreshing and the existing ads keep serving.
#
# Two mechanisms, because the two pages differ in kind:
#   listings   -- generated by autoindex, so there is no file to edit. nginx
#                 prepends the fragment with add_before_body.
#   index.html -- a real file, so the default page carries an SSI include and
#                 nginx expands it. That also means a user can move the token,
#                 and a user who replaces the page entirely drops the ad.
# OFF until a slot id is configured, and there is deliberately no default one.
# An ad slot is an account: baking one in here would bill every box that ever
# runs this script to whoever owns that slot, and the impressions would look
# like traffic they did not have. So SPONSOR_AD_SLOT is the switch -- set it in
# $SERVER_CONFIG to turn the ad on, leave it alone to never see one.
SPONSOR_AD_SLOT="${SPONSOR_AD_SLOT:-}"
SPONSOR_AD="${SPONSOR_AD:-1}"
[[ -z "$SPONSOR_AD_SLOT" ]] && SPONSOR_AD=0
SPONSOR_AD_ENDPOINT="${SPONSOR_AD_ENDPOINT:-https://crawlproof.com/api/ads/motd}"
# Total width of the ad box, and it has a floor. The endpoint only draws the
# click URL inside the border when it fits -- otherwise it drops it onto a bare
# line underneath, which reads as a stray link rather than part of the ad. The
# URL is 25 chars of prefix + a 36-char id + "?s=$SPONSOR_AD_SRC", and the
# border costs 4 more, so 72 was one short of holding it and 76 is the exact
# floor. 80 leaves headroom for a longer src tag, and matches the ~79-char
# width of the autoindex listing it sits above.
SPONSOR_AD_COLS="${SPONSOR_AD_COLS:-80}"
# rides through to the click URL, so these views are told apart from the motd
SPONSOR_AD_SRC="${SPONSOR_AD_SRC:-userdirs}"
# How many pre-rendered creatives to keep. This is the rotation: nginx picks
# one at random per request, so it also bounds how repetitive a reload feels.
# Duplicates are left in rather than deduped -- the endpoint weights its own
# rotation, and collapsing that here would flatten it.
SPONSOR_AD_POOL="${SPONSOR_AD_POOL:-12}"
SPONSOR_AD_DIR=/var/www/sponsor
SPONSOR_AD_POOL_DIR=/var/www/sponsor/ads
# superseded by the pool; removed on upgrade
SPONSOR_AD_LEGACY_FILE=/var/www/sponsor/ad.html
# nginx URI the pool is served at. Internal, so it is only ever reachable
# through the SSI/add_before_body subrequests -- never fetched directly. The
# trailing slash matters: random_index only fires on a URI that ends in one.
SPONSOR_AD_URI=/.sponsor-ad/
SPONSOR_AD_BLANK_URI=/.sponsor-ad-blank

# chawan -- TUI browser and pager. Not in apt: the author ships a .deb, so the
# current version is read off the homepage ("the latest release (vX.Y.Z)") and
# the matching .deb is pulled from SourceHut. Set CHAWAN_VERSION to pin one.
# lynx is in BASE_PACKAGES as the fallback for when chawan cannot be installed
# at all -- non-amd64, or the download is unreachable.
CHAWAN_INDEX="${CHAWAN_INDEX:-https://chawan.net/index.html}"
CHAWAN_VERSION="${CHAWAN_VERSION:-}"
# only used when the homepage cannot be reached and nothing is installed yet
CHAWAN_FALLBACK_VERSION=0.4.4

# Logo shown at the top of the landing page. Cached locally so the page does
# not depend on profullstack.com being up.
LOGO_URL="${LOGO_URL:-https://profullstack.com/assets/logo.svg}"
LOGO_FILE=/var/www/userdirs/assets/logo.svg

# Group menu offered when creating a user. Default selection is 1,2.
GROUP_CHOICES=(sudo admin docker adm www-data users)
# Overridable like every other setting -- server.conf documents this key, and an
# unattended run takes it verbatim for every account it creates. Assigning it
# unconditionally (as this line used to) meant a box that had configured, say,
# www-data,users,docker still got its new accounts put in sudo,admin.
DEFAULT_GROUPS="${DEFAULT_GROUPS:-sudo,admin}"

USERS=()         # alice@example -- new this run, get the full treatment
USER_GROUPS=()   # sudo,admin           -- index-matched to USERS
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
		PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
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
		( cd -- "$home" && env -i "${envs[@]}" bash -lc "$*" </dev/null )
	else
		( cd -- "$home" && runuser -u "$login" -- \
			env -i "${envs[@]}" bash -lc "$*" </dev/null )
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
# reason to. Re-running the script should not bounce nginx for nothing.
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

# Who a --shared mount is opened to. Not "everyone": every human account on
# these boxes is in `users` (it is one of GROUP_CHOICES above), and daemons are
# not, so the group is already the line between a person and a service.
SHARE_GROUP="${SHARE_GROUP:-users}"

# What a shared directory and the files under it end up as. Directories need the
# execute bit to be traversable at all, and the setgid bit to keep new entries in
# the group -- which is why these are not the same number with a digit moved.
SHARE_DIR_MODE="${SHARE_DIR_MODE:-2775}"
SHARE_FILE_MODE="${SHARE_FILE_MODE:-0664}"

# The account nginx runs as. Only used to let it traverse ~/share (_share_link);
# it is deliberately NOT $SHARE_GROUP, which is who may write to a mount.
WEB_GROUP="${WEB_GROUP:-www-data}"

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
# humans are in `users`, nginx is www-data, and neither belongs in the other's
# group. Putting www-data in `users` hands the web server every other `users`
# share on the box; putting the humans in www-data is the same trade backwards.
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
		warn "share: setfacl is missing -- '${extras[*]}' not granted on $dir (apt install acl)"
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
# That is deliberate -- nginx serving out of a shared volume is the common case
# and does not justify putting www-data in $SHARE_GROUP. Override with
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
		# g:www-data:rwx entry still hands the directory to a daemon, and `ls -l`
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
# second permission boundary for anything that walks in from outside -- nginx
# following ~/public_html/done -> ~/share/seed gets EACCES on ~/share and 403s,
# while the /mnt directory that is supposed to be making that call sits there
# world-traversable.
#
# What needs to traverse is one account, so name it: the directory goes to
# $WEB_GROUP with 0710. www-data gets the x bit, other accounts get nothing --
# 0711 would have worked too, but it hands traversal to every process on the box
# to solve a problem only nginx has. Group execute is the same fix, scoped.
#
# Withholding r keeps it per-user either way: nginx can walk through to a link
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
	  root-ubuntu.sh mount [user@]host:/remote/path [options]
	  root-ubuntu.sh umount <mountpoint|host>
	  root-ubuntu.sh mounts
	  root-ubuntu.sh share <mountpoint>... [--private] [--group NAME] [-R]

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
	  --group NAME  let a SECOND group write too, e.g. www-data. A directory has
	                one group, so this is a POSIX ACL (g:NAME:rwx plus the
	                inherited default) rather than a mode -- `ls -l` shows a
	                trailing + and getfacl shows the rest. Repeatable; needs the
	                acl package and a filesystem mounted with ACL support.
	                $SHARE_EXTRA_GROUPS is the same thing from the environment.
	  --ro          mount read-only
	  --no-fstab    mount now, do not persist across reboots
	  --dry-run     print the mountpoint, fstab line and unit, change nothing

	Examples:
	  root-ubuntu.sh mount ubuntu@files.example.com:~/Downloads/done --via ubuntu
	  root-ubuntu.sh mount media.example.com:/srv/media --ro
	  root-ubuntu.sh umount /mnt/tailscale.files.example.com/Downloads/done
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
	local tsreq=""
	[[ "$label" == tailscale ]] && tsreq=",x-systemd.requires=tailscaled.service"

	local src opts fstype
	case "$proto" in
		nfs)
			fstype=nfs
			src="$target:$remote"
			opts="nfsvers=4.1,proto=tcp,$rw,hard,_netdev,nofail,x-systemd.automount$tsreq"
			;;
		sshfs)
			# A dry run must not install anything -- just say it would.
			if ! command -v sshfs >/dev/null 2>&1; then
				if [[ "$dry" == 1 ]]; then
					info "sshfs is not installed; a real run would apt-get install it"
				else
					log "installing sshfs"
					apt-get install -y sshfs >/dev/null || die "mount: could not install sshfs"
				fi
			fi
			fstype=fuse.sshfs
			src="$user@$target:$remote"
			# root does the mounting, so it is root's key that has to be authorised
			# on the far side -- not the invoking user's.
			opts="$rw,_netdev,nofail,x-systemd.automount$tsreq,allow_other,reconnect,ServerAliveInterval=15,IdentityFile=/root/.ssh/id_ed25519"
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
		info "unit       : $(systemd-escape -p --suffix=automount "$mp")"
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
		systemctl daemon-reload
		local unit; unit="$(systemd-escape -p --suffix=automount "$mp")"
		systemctl start "$unit" 2>/dev/null || true
	fi

	mountpoint -q "$mp" || mount "$mp" 2>/dev/null || ls "$mp" >/dev/null 2>&1
	if ! mountpoint -q "$mp"; then
		warn "not mounted yet -- check: systemctl status $(systemd-escape -p --suffix=mount "$mp")"
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
	systemctl stop "$(systemd-escape -p --suffix=automount "$mp")" 2>/dev/null || true
	systemctl stop "$(systemd-escape -p --suffix=mount "$mp")"     2>/dev/null || true
	umount "$mp" 2>/dev/null || true
	mountpoint -q "$mp" && die "umount: $mp is busy -- something is sitting in it (lsof +D $mp)"

	cp -a /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d-%H%M%S)"
	local tmp; tmp="$(mktemp)"
	awk -v mp="$mp" '$2 == mp { next } { print }' /etc/fstab >"$tmp" && cat "$tmp" >/etc/fstab
	rm -f "$tmp"
	systemctl daemon-reload
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
# for a one-line change: adding an account to docker should not drag an apt
# upgrade, a certbot renewal and a possible reboot along behind it.
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
# `www-data` is 33 -- between them they are the whole idea of who may write to a
# shared volume on these boxes, and groupadd cannot put either back on the same
# gid afterwards, so every file left on disk would keep a numeric group with no
# name. Deleting one is almost always a typo for `groups rm`.
GROUPS_SYSTEM_FLOOR="${GROUPS_SYSTEM_FLOOR:-1000}"

# Same rule as a login: groupadd is as fussy as useradd about names, and a group
# with an uppercase letter or a slash in it breaks the same nginx maps that
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

# "sudo,docker" and "sudo docker" are the same list, because --groups already
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
# root is not itself in `sudo` and does not need to be, so "no members left" is
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
		# nginx has to write to.
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
	  root-ubuntu.sh groups                           every account, and its groups
	  root-ubuntu.sh groups [list] <user>...          just these accounts
	  root-ubuntu.sh groups add     <user> <group>... put a user in groups
	  root-ubuntu.sh groups rm      <user> <group>... take a user out of groups
	  root-ubuntu.sh groups set     <user> <group>... exactly these, drop the rest
	  root-ubuntu.sh groups create  <group>...        make a group
	  root-ubuntu.sh groups delete  <group>...        remove a group
	  root-ubuntu.sh groups members <group>...        who is in a group

	Group lists take commas or spaces: 'docker,www-data' and 'docker www-data'
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
	  root-ubuntu.sh groups
	  root-ubuntu.sh groups alice
	  root-ubuntu.sh groups add alice docker,www-data     # as root
	  root-ubuntu.sh groups rm alice docker               # as root
	  root-ubuntu.sh groups set alice sudo,admin,users    # as root
	  root-ubuntu.sh groups members www-data
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

usage() {
	sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
	exit "${1:-0}"
}

# Subcommands are peeled off before the provisioning flags, so that `mount`
# can take its own options without colliding with them.
SUBCMD=""
SUBARGS=()
case "${1:-}" in
	mount|umount|mounts|share|groups) SUBCMD="$1"; shift; SUBARGS=("$@"); set -- ;;
esac

ARGS=()
CLI_GROUPS=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--refresh)        ASSUME_YES=1 ;;
		--force-dotfiles) FORCE_DOTFILES=1 ;;
		--no-reboot)      REBOOT_POLICY=0 ;;
		--reboot)         REBOOT_POLICY=2 ;;
		--skip-apt)       SKIP_APT=1 ;;
		--skip-web)       SKIP_WEB=1 ;;
		--skip-tailscale) SKIP_TAILSCALE=1 ;;
		--skip-tools)     SKIP_TOOLS=1 ;;
		--skip-dotfiles)  SKIP_DOTFILES=1 ;;
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

# The share and groups helpers are self-contained: no apt, no lock, no dotfiles
# checkout needed. They come before the root check so that --help, --dry-run and
# a plain `groups` listing work as a normal user; each asks for root only when
# it mutates.
case "$SUBCMD" in
	mount)  cmd_mount  ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
	umount) cmd_umount ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
	mounts) cmd_mounts; exit $? ;;
	share)  cmd_share  ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
	groups) cmd_groups ${SUBARGS[@]+"${SUBARGS[@]}"}; exit $? ;;
esac

# Root, not sudo-capable: this writes to /etc, creates accounts and drives
# systemd. Saying which is which up front beats failing on the twentieth step.
if [[ $EUID -ne 0 ]]; then
	if command -v sudo >/dev/null 2>&1; then
		die "must run as root -- try: sudo $0${*:+ $*}"
	fi
	die "must run as root (and there is no sudo on this box -- log in as root)"
fi

# What this actually supports, checked rather than assumed.
#
# The floor is "modern": every mechanism in here -- systemd timers, ufw,
# unattended-upgrades, nginx maps, `http2 on` -- is present on Ubuntu 22.04 and
# newer and on Debian 12. Older releases mostly work and are not worth blocking
# over, so an unrecognised version is a warning: the box may be fine, and a
# hard refusal on a version bump nobody predicted would be its own outage.
check_os() {
	local id="" ver="" pretty=""
	if [[ -r /etc/os-release ]]; then
		# shellcheck disable=SC1091
		. /etc/os-release
		id="${ID:-}"; ver="${VERSION_ID:-}"; pretty="${PRETTY_NAME:-}"
	fi
	command -v apt-get >/dev/null \
		|| die "this script targets Debian/Ubuntu (no apt-get found${pretty:+ on $pretty})"

	case "$id" in
		ubuntu)
			# 22.04 and up. Compared as a number so 24.04 > 22.04 and, more to
			# the point, 26.04 does not sort below 9.10 as a string would.
			if [[ -n "$ver" ]] && awk -v v="$ver" 'BEGIN { exit !(v + 0 < 22) }'; then
				warn "${pretty:-Ubuntu $ver} is older than 22.04 -- expect some steps to fail"
			fi
			;;
		debian)
			if [[ -n "$ver" ]] && awk -v v="$ver" 'BEGIN { exit !(v + 0 < 12) }'; then
				warn "${pretty:-Debian $ver} is older than 12 -- expect some steps to fail"
			fi
			;;
		'')
			warn "no /etc/os-release -- assuming Debian-like because apt-get is here"
			;;
		*)
			warn "${pretty:-$id} is not Ubuntu or Debian; apt-get is here, so continuing"
			;;
	esac

	# Not fatal either. Every systemd user in here already falls back to cron or
	# degrades with a warning, so a container without it still gets the packages,
	# the accounts and the dotfiles.
	command -v systemctl >/dev/null 2>&1 \
		|| warn "no systemd -- timers become cron jobs and services are not managed"
	info "${pretty:-unknown OS} on $(uname -m)"
	return 0
}
check_os

# Two copies racing each other through apt, chsh and nginx is a good way to
# corrupt exactly the box you were trying to maintain.
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

	if looks_like_dotfiles "$SCRIPT_DIR"; then
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

# Both of these are CALLED after the apt stage, not here: cloning a dotfiles
# repo needs git, and git is one of the packages apt_stage installs. Resolving
# before that would fail on exactly the bare box this is meant to bootstrap.

export DEBIAN_FRONTEND=noninteractive
# needrestart on Ubuntu 22.04+ opens a whiptail dialog mid-upgrade and hangs an
# unattended run forever. Suspend it and report /var/run/reboot-required at the
# end instead of restarting services under people's feet.
export NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l

install -d -m 0755 "$STATE_DIR"
if [[ -e "$STATE_DIR/provisioned" ]]; then
	log "maintenance run -- converging $(hostname -s) to the current templates"
else
	log "first run on $(hostname -s)"
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

# ------------------------------------------------------------------- apt ---

# Only the OS-level bits: shell, terminal apps we keep configs for, firewall.
# Language runtimes and dev tools are mise's job.
# mosh ships mosh, mosh-client and mosh-server in one package.
BASE_PACKAGES=(
	ca-certificates curl git zsh tmux irssi mosh ufw unattended-upgrades
	nginx certbot python3-certbot-nginx python3-certbot-dns-cloudflare
	# the tools whose dotfiles this repo ships -- without them the configs
	# are dead weight and the box feels half-provisioned
	vim htop ack screen rsync unzip jq openssl
	# setfacl/getfacl, for `share --group`: a shared volume that a daemon also
	# has to write to needs a second group, and a second group is only sayable
	# as an ACL. Not installed by default on a minimal Ubuntu image.
	acl
	# ripgrep gives you rg, which is what anyone reaching for `find | rg`
	# expects to already be there. ack stays -- it is what .ackrc configures.
	ripgrep
	# lynx is the backup terminal browser: chawan is the one we want, but it
	# is amd64-only and comes from a .deb off the author's site, so there has
	# to be something in apt that always works
	lynx
)

# "You can download the latest release (v0.4.4)" on the homepage
chawan_latest_version() {
	curl -fsSL --max-time 20 "$CHAWAN_INDEX" 2>/dev/null \
		| sed -n 's/.*latest release (v\([0-9][0-9.]*\)).*/\1/p' | head -1
}

# chawan lives outside apt, so this is a hand-rolled "is it current?" check:
# compare the installed version against the one the homepage advertises, and
# only fetch when they differ. Every user gets it -- a .deb lands in /usr/bin.
install_chawan() {
	local arch want have tmp got

	arch="$(dpkg --print-architecture)"
	if [[ "$arch" != amd64 ]]; then
		info "chawan publishes an amd64 .deb only -- skipping on $arch (lynx covers it)"
		return 0
	fi

	have="$(dpkg-query -W -f '${Version}' chawan 2>/dev/null)"

	want="$CHAWAN_VERSION"
	if [[ -z "$want" ]]; then
		want="$(chawan_latest_version)"
		if [[ -z "$want" ]]; then
			# the site is down: keep whatever is installed rather than churn
			[[ -n "$have" ]] && { info "chawan $have installed (could not reach $CHAWAN_INDEX)"; return 0; }
			want="$CHAWAN_FALLBACK_VERSION"
			warn "could not read the current chawan version -- trying $want"
		fi
	fi

	if [[ "$have" == "$want" ]]; then
		info "chawan $have already current"
		return 0
	fi

	tmp="$(mktemp -d)" || return 1
	local url="${CHAWAN_DEB_URL:-https://git.sr.ht/~bptato/chawan/refs/download/v${want}/chawan-${want//./-}-amd64.deb}"
	if ! curl -fsSL --max-time 180 "$url" -o "$tmp/chawan.deb"; then
		warn "could not download chawan $want from $url"
		rm -rf "$tmp"; return 1
	fi

	# A 404 page or a truncated transfer is still a file. Installing it would
	# be worse than not installing at all, so make dpkg confirm it is a
	# package and that it is the version we went looking for.
	if ! dpkg-deb -I "$tmp/chawan.deb" >/dev/null 2>&1; then
		warn "the chawan download is not a valid .deb -- skipping (lynx still available)"
		rm -rf "$tmp"; return 1
	fi
	got="$(dpkg-deb -f "$tmp/chawan.deb" Version 2>/dev/null)"
	if [[ -n "$got" && "$got" != "$want" ]]; then
		warn "chawan .deb says version $got, expected $want -- installing it anyway"
	fi

	# apt-get rather than dpkg -i: it resolves dependencies instead of leaving
	# a half-configured package behind if the author ever adds one
	if apt-get install -y -qq "$tmp/chawan.deb"; then
		note "chawan ${got:-$want} (cha, mancha)"
		rm -rf "$tmp"; return 0
	fi
	warn "chawan install failed -- lynx is still available"
	rm -rf "$tmp"; return 1
}

apt_stage() {
	log "apt update / upgrade"
	try "apt-get update" apt-get update -qq

	# --with-new-pkgs is what unattended-upgrades uses: a plain 'upgrade' holds
	# back anything needing a new dependency, so kernels and security updates
	# quietly never land. confdef+confold keeps every conffile prompt away.
	local upgraded_before upgraded_after
	upgraded_before="$(dpkg-query -W -f '${Package}=${Version}\n' 2>/dev/null | sha256sum)"
	try "apt-get upgrade" apt-get -y --with-new-pkgs \
		-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
	try "apt-get autoremove" apt-get -y autoremove
	upgraded_after="$(dpkg-query -W -f '${Package}=${Version}\n' 2>/dev/null | sha256sum)"
	[[ "$upgraded_before" != "$upgraded_after" ]] && note "apt packages changed"

	log "installing base packages"
	# One apt-get for everything present, then retry the stragglers one at a
	# time so a single unavailable package cannot take the whole batch down.
	local missing=() p
	for p in "${BASE_PACKAGES[@]}"; do
		dpkg-query -W -f '${Status}' "$p" 2>/dev/null | grep -q "^install ok installed$" \
			|| missing+=("$p")
	done
	if [[ ${#missing[@]} -gt 0 ]]; then
		note "installing: ${missing[*]}"
		apt-get install -y -qq "${missing[@]}" || for p in "${missing[@]}"; do
			try "install $p" apt-get install -y -qq "$p"
		done
	else
		info "all base packages already installed"
	fi

	# outside apt, so it gets its own step rather than a package name
	log "installing chawan (TUI browser)"
	try "chawan" install_chawan

	log "enabling unattended security upgrades"
	write_if_changed /etc/apt/apt.conf.d/20auto-upgrades <<'EOF' && note "20auto-upgrades"
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
	return 0
}

if [[ "$SKIP_APT" == 1 ]]; then
	log "skipping apt (--skip-apt)"
else
	apt_stage
fi

# Now that git exists, work out where the dotfiles are coming from -- see
# resolve_dotfiles for the order it tries.
log "resolving dotfiles source"
resolve_dotfiles
resolve_keys_dir

# ------------------------------------------------------------------- ufw ---

log "configuring ufw"
# The -n guard is not redundant with the -f test: with no dotfiles checkout the
# path collapses to /etc/default/ufw, which is the very file being written, and
# the comparison would be a file against itself.
if [[ -n "$DOTFILES_DIR" && -f "$DOTFILES_DIR/etc/default/ufw" ]] \
	&& ! cmp -s "$DOTFILES_DIR/etc/default/ufw" /etc/default/ufw; then
	try "install /etc/default/ufw" install -m 0644 "$DOTFILES_DIR/etc/default/ufw" /etc/default/ufw \
		&& note "/etc/default/ufw"
fi
try "ufw default deny incoming"  ufw --force default deny incoming
try "ufw default allow outgoing" ufw --force default allow outgoing

# ssh first -- opening it before enabling is what stops you locking yourself out
try "ufw allow ${SSH_PORT}/tcp (ssh)" ufw allow "${SSH_PORT}/tcp"
try "ufw allow 80/tcp (http)"         ufw allow 80/tcp
try "ufw allow 443/tcp (https)"       ufw allow 443/tcp
# mosh picks a UDP port in this range per session; without it mosh cannot connect
try "ufw allow 60000:61000/udp (mosh)" ufw allow 60000:61000/udp

# 'ufw enable' on an already-active firewall reloads the whole ruleset, which
# briefly drops packets on a box people are logged into. Only enable it when
# it is actually off.
if ufw status 2>/dev/null | head -1 | grep -q 'inactive'; then
	try "ufw enable" ufw --force enable && note "ufw enabled"
else
	info "ufw already active"
fi
try "enable ufw at boot" systemctl enable ufw
ufw status verbose || true

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
# Managed by root-ubuntu.sh. Swap here is headroom for spikes, not a memory
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
	virt="$(systemd-detect-virt --container 2>/dev/null)"
	if [[ -n "$virt" && "$virt" != none ]]; then
		info "inside a $virt container -- swap belongs to the host"
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

	_swap_sysctl
	return 0
}

log "configuring swap"
try "swap" configure_swap

# ------------------------------------------------------------------ motd ---

# Fetched into a cache file; login just cats it and kicks off a background
# refresh, so a slow/dead endpoint can never hang an ssh login.
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

	# Login only ever reads the cache -- a slow or dead endpoint can never
	# hang an ssh login. Refreshing is the timer's job.
	if [[ -d /etc/update-motd.d ]]; then
		write_if_changed /etc/update-motd.d/99-profullstack 0755 <<EOF
#!/bin/sh
[ -s '${MOTD_CACHE}' ] && cat '${MOTD_CACHE}'
exit 0
EOF
	else
		warn "no /etc/update-motd.d -- wiring motd into /etc/profile.d instead"
		write_if_changed /etc/profile.d/99-profullstack-motd.sh 0755 <<EOF
#!/bin/sh
[ -s '${MOTD_CACHE}' ] && cat '${MOTD_CACHE}'
EOF
	fi

	# refresh every 24h
	if command -v systemctl >/dev/null && [[ -d /etc/systemd/system ]]; then
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
		# reloading systemd on every run is pointless churn
		[[ "$units_changed" == 1 ]] && { systemctl daemon-reload; note "motd timer units"; }
		systemctl is-enabled profullstack-motd.timer >/dev/null 2>&1 \
			|| systemctl enable --now profullstack-motd.timer
		systemctl is-active profullstack-motd.timer >/dev/null 2>&1 \
			|| systemctl start profullstack-motd.timer
	else
		warn "no systemd -- falling back to /etc/cron.daily for the motd refresh"
		ln -sf /usr/local/bin/profullstack-motd /etc/cron.daily/profullstack-motd
	fi

	# Canonical's motd-news would otherwise print ads above ours.
	[[ -f /etc/default/motd-news ]] \
		&& sed -i 's/^ENABLED=.*/ENABLED=0/' /etc/default/motd-news

	# populate the cache now so the very first login already shows it
	/usr/local/bin/profullstack-motd
	[[ -s "$MOTD_CACHE" ]] || { warn "could not fetch ${MOTD_URL} (will retry on next login)"; return 1; }
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

	# Only convert from the distro defaults. If someone has deliberately moved
	# to fish or dash, a maintenance run has no business dragging them back --
	# that is precisely the kind of "it broke my account" a re-run must avoid.
	case "$actual" in
		*/zsh) return 0 ;;
		*/bash|*/sh|"") ;;
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
# debug. nginx separately needs o+x on the home to reach public_html. So the
# target is: owned by the user, group/other write stripped, o+x kept.
fix_home_permissions() {
	local home="$1" login="$2" oct
	[[ -d "$home" ]] || { warn "no home dir $home"; return 1; }

	chown "$login:$login" "$home"
	chmod g-w,o-w "$home"
	chmod o+x "$home"

	if [[ -d "$home/.ssh" ]]; then
		chown -R "$login:$login" "$home/.ssh"
		chmod 0700 "$home/.ssh"
		find "$home/.ssh" -type f ! -name '*.pub' -exec chmod 0600 {} +
		find "$home/.ssh" -type f -name '*.pub' -exec chmod 0644 {} +
	fi

	# nginx (www-data) has to be able to read these. a+rX adds what it needs
	# without flattening modes the user set deliberately -- a blanket 0644
	# would, for instance, strip the +x off anything they keep in there.
	if [[ -d "$home/public_html" ]]; then
		chown -R "$login:$login" "$home/public_html"
		chmod -R a+rX,go-w "$home/public_html"
	fi
	# ~/share holds symlinks to /mnt mountpoints (_share_link). Someone who
	# publishes ~/public_html/done -> ~/share/seed means for nginx to follow it,
	# and no x here breaks that whatever the mountpoint allows. Hand the x to
	# $WEB_GROUP rather than to the world: nginx is the only thing that needs to
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
	# private work that nginx never serves and must stay that way.
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

# Installs/repairs moshcode itself. Re-running is the supported update path and
# it replaces ~/.moshcode/pkg wholesale, which is what heals a partial install.
install_moshcode() { as_user "$1" 'curl -fsSL https://moshcode.sh/install.sh | sh'; }

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
	# anyone but root, and on this box tailscale comes from apt and is
	# upgraded in apt_stage anyway. Failing the whole step over it would mean
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

# One ssh-agent per user, started by systemd, on a socket path that is the
# same at every login: $XDG_RUNTIME_DIR/ssh-agent.socket.
#
# Why a unit and not a line in .zshrc. The shell-snippet version of this
# ("start an agent if $SSH_AUTH_SOCK looks dead") starts a NEW agent per
# shell, so every tmux pane and every reconnect gets its own, a key added in
# one is invisible to the next, and the dead ones pile up until reboot.
# systemd gives exactly one per user and restarts it if it dies.
#
# It goes in /etc/systemd/user enabled --global, rather than into each
# ~/.config/systemd/user: one file to update, and accounts created later pick
# it up without a re-run. Anyone who wants none of it can still turn it off
# for themselves with `systemctl --user mask ssh-agent`, which outranks the
# global enable -- so this is a default, not a policy.
#
# NOTHING here loads a key. Every key worth having is passphrased, and an
# unattended root script is the last thing that should be asking for one.
# Use `ssh-add` on first login, or AddKeysToAgent in your own ~/.ssh/config.
install_ssh_agent() {
	local agent unit=/etc/systemd/user/ssh-agent.service
	local snippet=/etc/profile.d/ssh-agent.sh

	agent="$(command -v ssh-agent)" || { warn "ssh-agent is not installed"; return 1; }
	[[ -d /run/systemd/system ]] || { info "not running systemd -- skipping ssh-agent"; return 0; }

	install -d -m 0755 /etc/systemd/user
	write_if_changed "$unit" <<-EOF && note "ssh-agent user unit"
		# managed by root-ubuntu.sh
		[Unit]
		Description=SSH authentication agent
		Documentation=man:ssh-agent(1)

		[Service]
		Type=simple
		Environment=SSH_AUTH_SOCK=%t/ssh-agent.socket
		# A socket left behind by a killed agent makes the next bind fail with
		# "Address already in use", and then the unit never comes back.
		ExecStartPre=-/bin/rm -f %t/ssh-agent.socket
		ExecStart=$agent -D -a %t/ssh-agent.socket
		Restart=on-failure
		RestartSec=2

		[Install]
		WantedBy=default.target
	EOF

	# --global writes the wants symlink under /etc, so it covers accounts that
	# do not exist yet. It starts nothing: the agent comes up with each user's
	# manager at their next login, which is also when an edited unit is picked
	# up -- there is no system-wide reload that reaches running user managers.
	systemctl --global enable ssh-agent.service >/dev/null 2>&1 \
		|| warn "could not enable ssh-agent.service globally"

	# The unit sets SSH_AUTH_SOCK for services systemd starts, and a login
	# shell is not one of those, so the shell has to be told where the socket
	# is. Debian sources /etc/profile.d/*.sh from bash AND zsh login shells, so
	# one file covers both -- zsh reads it under `emulate sh`, hence no bashisms.
	# (write_if_changed installs a file, not a path, and a stripped-down image
	# can be missing /etc/profile.d entirely.)
	install -d -m 0755 /etc/profile.d
	write_if_changed "$snippet" <<-'EOF' && note "ssh-agent profile snippet"
		# managed by root-ubuntu.sh -- point this shell at the systemd ssh-agent.
		#
		# Only when there is not already a working agent. An inherited
		# SSH_AUTH_SOCK is usually a forwarded one (ssh -A), and overwriting it
		# would swap the keys you brought with you for the ones on this box.
		# Set-but-dead is the reattached-tmux case, and that one is fair game.
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
}

# Without lingering, the user manager stops when the last session ends and
# takes the agent with it -- so a key added in one ssh session is gone by the
# next, which is most of the point of running an agent at all. It is also what
# keeps a detached tmux alive after logout.
enable_ssh_agent_for() {
	local login="$1"
	[[ -d /run/systemd/system ]] || return 0
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
# reports what to run rather than hanging on an interactive login.
install_tailscale() {
	if ! command -v tailscale >/dev/null; then
		curl -fsSL https://tailscale.com/install.sh | sh || return 1
	fi
	systemctl enable --now tailscaled || return 1

	# tailscale ip only succeeds once the node is actually logged in
	if tailscale ip -4 >/dev/null 2>&1; then
		info "already on the tailnet as $(tailscale ip -4 | head -1)"
	elif [[ -n "$TS_AUTHKEY" ]]; then
		tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" \
			|| { warn "tailscale up failed (bad or expired auth key?)"; return 1; }
	else
		warn "not joined to a tailnet: no TS_AUTHKEY set"
		info "  unattended:  sudo TS_AUTHKEY=tskey-auth-... $0"
		info "  or by hand:  sudo tailscale up --hostname=$TS_HOSTNAME"
		return 1
	fi

	# Tailnet traffic is trusted; without this the default deny-incoming
	# policy drops it. 41641/udp lets peers connect directly instead of
	# relaying through DERP.
	ufw allow in on tailscale0 >/dev/null 2>&1 || warn "could not allow tailscale0 in ufw"
	ufw allow 41641/udp >/dev/null 2>&1 || warn "could not allow 41641/udp in ufw"
	return 0
}

# ----------------------------------------------------------- user web dirs ---

# Every default page this script has ever shipped, by revision. A file that
# matches one of them byte for byte has never been edited by its owner, so
# rewriting it is safe; anything else is the user's page and is left alone.
#
# Add a revision here rather than editing an old one -- the old text is what
# lets an already-provisioned box recognise its own default and move on.
_public_html_default_page() {
	local login="$1" rev="$2"

	# rev 1: before the sponsor ad
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

	# rev 2: sponsor ad at the top, expanded by nginx on the way out. The URI is
	# spelled out rather than interpolated: $SPONSOR_AD_URI has moved on since,
	# and a revision that changes under us stops recognising the pages it wrote.
	[[ "$rev" == 2 ]] && cat <<EOF
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${login}</title>
<!-- sponsor ad, filled in by the server; delete the next line to drop it -->
<!--# include virtual="/.sponsor-ad" -->
<h1>${login}</h1>
<p>Default page for ${login} on ${WEB_DOMAIN}.
<p>Email: <a href="mailto:${login}@${MAIL_DOMAIN}">${login}@${MAIL_DOMAIN}</a>
<p>Edit <code>~/public_html/index.html</code> to replace it.
EOF

	# rev 3: the ad became a pool that rotates per request, so the token gained
	# the trailing slash random_index needs. Keep the token to keep the ad;
	# delete the line to drop it.
	[[ "$rev" == 3 ]] && cat <<EOF
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${login}</title>
<!-- sponsor ad, filled in by the server; delete the next line to drop it -->
<!--# include virtual="${SPONSOR_AD_URI}" -->
<h1>${login}</h1>
<p>Default page for ${login} on ${WEB_DOMAIN}.
<p>Email: <a href="mailto:${login}@${MAIL_DOMAIN}">${login}@${MAIL_DOMAIN}</a>
<p>Edit <code>~/public_html/index.html</code> to replace it.
EOF
	return 0
}

# newest revision, i.e. what a fresh page gets written as
_public_html_current_rev() { [[ "$SPONSOR_AD" == 1 ]] && echo 3 || echo 1; }

# ~/public_html served at https://$WEB_DOMAIN/~user and https://user.$WEB_DOMAIN
#
# nginx runs as www-data, so it needs to traverse the home directory. o+x (not
# o+r) on $HOME lets it walk through without making the home itself listable.
install_public_html() {
	local home="$1" login="$2" doc="$1/public_html" rev want cur

	# create if absent; an existing one keeps whatever mode its owner chose
	[[ -d "$doc" ]] || install -d -m 0755 -o "$login" -g "$login" "$doc"
	chmod o+x "$home"

	cur="$(_public_html_current_rev)"
	want=0
	if [[ ! -e "$doc/index.html" ]]; then
		want=1
	else
		# still one of our defaults? then it is ours to update. Anything the
		# user has touched -- including a page they wrote from scratch -- fails
		# every comparison and is never clobbered.
		for rev in 1 2 3; do
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
	fi
	return 0
}

# ~/apps/<name> becomes https://<name>.<user>.$WEB_DOMAIN
#
# Static: files in ~/apps/<name>/public. Dynamic: put the port in
# ~/apps/<name>/.port and listen on 127.0.0.1:<port> -- nginx proxies to it,
# so nothing extra has to be opened in ufw.
install_dev_apps_dir() {
	local home="$1" login="$2" dir="$1/apps" fresh=0
	[[ "$DEV_APPS" == 1 ]] || return 0

	# ~/apps is a common enough name that an adopted account may already have
	# one full of private work. Create it if it is absent, but never restat an
	# existing one -- 'install -d -m 0755' would relax a 0700 directory and
	# publish the listing.
	if [[ ! -d "$dir" ]]; then
		install -d -m 0755 -o "$login" -g "$login" "$dir"
		fresh=1
	fi
	# o+x is traverse-only: nginx can reach a published app underneath without
	# ~/apps itself becoming listable.
	chmod o+x "$home" "$dir"

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
within a minute (profullstack-devapps.timer); no root, no restart, no
re-provision. Bind to 127.0.0.1, not 0.0.0.0 -- the firewall blocks the port
directly and nginx is what terminates TLS for you.
EOF
		chown "$login:$login" "$dir/README"
	fi
	return 0
}

# nginx cannot read a port out of a file per request, so the ~/apps/*/.port
# files are compiled into one map. A timer re-runs this, which is what makes
# "create a directory and it is live" work without root.
write_devapps_generator() {
	[[ "$DEV_APPS" == 1 ]] || return 0
	local units_changed=0

	write_if_changed /usr/local/bin/profullstack-devapps 0755 <<EOF && note "devapps generator"
#!/usr/bin/env bash
# Regenerate the <app>.<user>.${WEB_DOMAIN} port map from ~/apps/*/.port.
# Generated by cli-tools/root-ubuntu.sh -- edits here are overwritten.
set -uo pipefail
map_file='${DEV_APPS_MAP}'
tmp="\$(mktemp)" || exit 1

{
	echo "# generated by profullstack-devapps -- do not edit"
	echo 'map "\$devapp_user/\$devapp_name" \$devapp_port {'
	echo '	default "";'
	for pf in /home/*/apps/*/.port; do
		[ -f "\$pf" ] || continue
		appdir="\$(dirname "\$pf")"
		app="\$(basename "\$appdir")"
		user="\$(basename "\$(dirname "\$(dirname "\$appdir")")")"
		port="\$(tr -cd '0-9' <"\$pf" | head -c 5)"
		# a user must not be able to point us at someone else's service, and
		# the low ports are root's
		[ -n "\$port" ] || continue
		[ "\$port" -ge 1024 ] 2>/dev/null || continue
		[ "\$port" -le 65535 ] 2>/dev/null || continue
		case "\$app" in *[!a-z0-9-]*|-*|'') continue ;; esac
		case "\$user" in *[!a-z0-9_-]*|'') continue ;; esac
		printf '\t"%s/%s" %s;\n' "\$user" "\$app" "\$port"
	done
	echo '}'
} >"\$tmp"

if ! cmp -s "\$tmp" "\$map_file"; then
	install -m 0644 "\$tmp" "\$map_file"
	nginx -t >/dev/null 2>&1 && systemctl reload nginx
fi
rm -f "\$tmp"
EOF

	write_if_changed /etc/systemd/system/profullstack-devapps.service <<'EOF' && units_changed=1
[Unit]
Description=Compile per-user dev app routes for nginx
After=nginx.service

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
		|| systemctl enable profullstack-devapps.timer
	systemctl is-active profullstack-devapps.timer >/dev/null 2>&1 \
		|| systemctl start profullstack-devapps.timer

	# the map file has to exist before nginx -t runs, or the vhost that
	# references $devapp_port will not load
	[[ -f "$DEV_APPS_MAP" ]] || printf '%s\n' \
		'# generated by profullstack-devapps -- do not edit' \
		'map "$devapp_user/$devapp_name" $devapp_port {' \
		'	default "";' \
		'}' >"$DEV_APPS_MAP"
	return 0
}

# The ad endpoint returns plain ASCII. Turning it into the HTML fragment nginx
# serves is three steps -- escape, linkify, wrap in <pre> -- and doing them here
# rather than per request means a page view never touches the ad network.
#
# Escaping comes first so a & in the ad text cannot become markup; linkifying
# second so the URL it produces is a real link on a page in a browser. Both
# leave the box drawing untouched: <a> renders zero-width inside <pre>, so the
# +--+ borders still line up.
write_sponsor_ad_generator() {
	[[ "$SPONSOR_AD" == 1 ]] || return 0
	local units_changed=0

	install -d -m 0755 "$SPONSOR_AD_DIR"

	write_if_changed /usr/local/bin/profullstack-sponsor-ad 0755 <<EOF && note "sponsor ad refresher"
#!/bin/sh
# Refill the pool of sponsor ads served on the per-user pages.
# Generated by cli-tools/root-ubuntu.sh -- edits here are overwritten.
umask 022
url='${SPONSOR_AD_ENDPOINT}?slot=${SPONSOR_AD_SLOT}&cols=${SPONSOR_AD_COLS}&src=${SPONSOR_AD_SRC}'
dir='${SPONSOR_AD_POOL_DIR}'
n=${SPONSOR_AD_POOL}

# One slot at a time, each replaced in place. There is deliberately no
# all-or-nothing swap: every slot holds a valid ad on its own, so a run that
# dies halfway leaves a pool of mixed vintages rather than a broken one.
i=1
while [ "\$i" -le "\$n" ]; do
	slot="\$(printf '%s/ad-%02d.html' "\$dir" "\$i")"
	i=\$((i+1))

	# A failed fetch leaves that slot on its previous ad rather than blanking
	# it, so a dead endpoint degrades to a stale pool, never to no ads.
	raw="\$(curl -fsS --max-time 5 "\$url")" || continue
	[ -n "\$raw" ] || continue

	tmp="\$(mktemp)" || exit 0
	{
		echo '<!-- sponsor ad -- refreshed by profullstack-sponsor-ad.timer -->'
		printf '%s' '<pre style="margin:0;overflow-x:auto">'
		printf '%s\n' "\$raw" \\
			| sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \\
			| sed -E 's|(https?://[A-Za-z0-9._~:/?@!\$()*+,;=%&-]+)|<a href="\1" rel="nofollow noopener sponsored">\1</a>|g'
		echo '</pre>'
		echo '<hr>'
	} >"\$tmp"

	# Never publish a truncated fragment: it would show up on user pages at
	# once. install(1) is the atomic step -- readers see old or new, not half.
	[ -s "\$tmp" ] && install -m 0644 "\$tmp" "\$slot"
	rm -f "\$tmp"
done
EOF

	if command -v systemctl >/dev/null && [[ -d /etc/systemd/system ]]; then
		write_if_changed /etc/systemd/system/profullstack-sponsor-ad.service <<'EOF' && units_changed=1
[Unit]
Description=Refill the sponsor ad pool for the per-user pages
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/profullstack-sponsor-ad
# one slot can stall for 5s; this bounds a whole pass over the pool
TimeoutStartSec=180
EOF

		write_if_changed /etc/systemd/system/profullstack-sponsor-ad.timer <<'EOF' && units_changed=1
[Unit]
Description=Refill the sponsor ad pool on the per-user pages

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
AccuracySec=1min

[Install]
WantedBy=timers.target
EOF

		# reloading systemd on every run is pointless churn
		[[ "$units_changed" == 1 ]] && { systemctl daemon-reload; note "sponsor ad timer units"; }
		systemctl is-enabled profullstack-sponsor-ad.timer >/dev/null 2>&1 \
			|| systemctl enable profullstack-sponsor-ad.timer
		systemctl is-active profullstack-sponsor-ad.timer >/dev/null 2>&1 \
			|| systemctl start profullstack-sponsor-ad.timer
	else
		warn "no systemd -- rotating the sponsor ad from /etc/cron.hourly instead"
		ln -sf /usr/local/bin/profullstack-sponsor-ad /etc/cron.hourly/profullstack-sponsor-ad
	fi

	# The pool directory must exist before the first page is served. Empty is
	# survivable -- the vhost turns the resulting 403/404 into an empty 204 --
	# but the directory itself missing would mean that guard is load-bearing on
	# every request rather than kept for genuine accidents.
	install -d -m 0755 "$SPONSOR_AD_POOL_DIR"

	# the single-file fragment this pool replaced
	rm -f "$SPONSOR_AD_LEGACY_FILE"

	# fill it now rather than serving no ad until the timer first fires
	/usr/local/bin/profullstack-sponsor-ad >/dev/null 2>&1 || true
	return 0
}

# SPONSOR_AD=0 after a run that had it on: stop the timer and drop the
# fragment. The vhosts stop referencing it in the same pass, so nothing is
# left pointing at a file that will not be refreshed.
remove_sponsor_ad() {
	systemctl disable --now profullstack-sponsor-ad.timer >/dev/null 2>&1
	rm -f /etc/cron.hourly/profullstack-sponsor-ad "$SPONSOR_AD_LEGACY_FILE"
	rm -rf "$SPONSOR_AD_POOL_DIR"
	return 0
}

# A wildcard cert can only come from a DNS-01 challenge -- HTTP-01 cannot
# validate *.domain -- so it needs API access to whoever hosts the zone.
# profullstack.com is on Porkbun; the Cloudflare path is kept for other zones.
#
# Wildcards are single-label on BOTH sides of this problem:
#   DNS: *.dev.profullstack.com answers alice.dev.profullstack.com but NOT
#        api.alice.dev.profullstack.com -- that needs its own
#        *.alice.dev.profullstack.com record.
#   TLS: the same, so every user needs *.<user>.dev.profullstack.com as a SAN.
# Hence one cert carrying the base name plus a wildcard per user.

have_dns01() {
	[[ -n "$PORKBUN_API_KEY" && -n "$PORKBUN_SECRET_API_KEY" ]] && return 0
	[[ -n "$CLOUDFLARE_API_TOKEN" || -s "$CF_CREDENTIALS" ]] && return 0
	return 1
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

# Every name the cert has to carry, one per line, $WEB_DOMAIN ALWAYS FIRST --
# acme.sh treats the first -d as the "main domain" and files the certificate
# under that name, which is the name --install-cert and the renewal check both
# look for. Sorting this list would silently break both.
#
# $1: "dns01" for the wildcard form, "http01" for the spelled-out form.
# http-01 cannot validate a wildcard at all, so the fallback must never ask
# for one -- certbot rejects the whole request if it does.
desired_cert_names() {
	local mode="${1:-auto}" u app
	[[ "$mode" == auto ]] && { have_dns01 && mode=dns01 || mode=http01; }

	printf '%s\n' "$WEB_DOMAIN"
	if [[ "$mode" == dns01 ]]; then
		printf '*.%s\n' "$WEB_DOMAIN"
		# one wildcard per user covers all of their current and future apps
		[[ "$DEV_APPS" == 1 ]] && while read -r u; do
			printf '*.%s.%s\n' "$u" "$WEB_DOMAIN"
		done < <(web_users)
	else
		# every name spelled out, and each one must already resolve here
		while read -r u; do
			printf '%s.%s\n' "$u" "$WEB_DOMAIN"
			[[ "$DEV_APPS" == 1 ]] || continue
			for app in "/home/$u"/apps/*; do
				[[ -d "$app" ]] || continue
				app="$(basename "$app")"
				[[ "$app" =~ ^[a-z0-9][a-z0-9-]*$ ]] || continue
				printf '%s.%s.%s\n' "$app" "$u" "$WEB_DOMAIN"
			done
		done < <(web_users)
	fi
}

# the -d arguments for an ACME client, order preserved, duplicates dropped
cert_args() {
	local n seen=() out=()
	while read -r n; do
		[[ -n "$n" ]] || continue
		printf '%s\n' "${seen[@]+"${seen[@]}"}" | grep -qxF "$n" && continue
		seen+=("$n"); out+=(-d "$n")
	done < <(desired_cert_names "${1:-auto}")
	printf '%s\n' "${out[@]+"${out[@]}"}"
}

cert_names() {
	[[ -s "$CERT_DIR/fullchain.pem" ]] || return 1
	openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text 2>/dev/null \
		| grep -A1 'Subject Alternative Name' | tr ',' '\n' \
		| sed -n 's/.*DNS://p' | tr -d ' '
}

cert_days_left() {
	local end now
	[[ -s "$CERT_DIR/fullchain.pem" ]] || { echo -1; return; }
	end="$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2)"
	end="$(date -d "$end" +%s 2>/dev/null)" || { echo -1; return; }
	now="$(date +%s)"
	echo $(( (end - now) / 86400 ))
}

# missing names, one per line (empty = the cert already covers everything)
cert_missing_names() {
	local have
	have="$(cert_names 2>/dev/null)" || { desired_cert_names; return; }
	comm -23 <(desired_cert_names | sort -u) <(printf '%s\n' "$have" | sort -u)
}

# ---- Porkbun DNS ----------------------------------------------------------
#
# A per-user wildcard cert is useless without a matching DNS record, and
# nobody wants to add one by hand each time an account is created.
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

# How each ACME client is told about the contact address, given there may not
# be one.
#
# ACME_EMAIL has no default on purpose -- a public script must not ship
# somebody's address, and a made-up one is worse than none because Let's
# Encrypt would send that person's expiry warnings into a black hole. Both
# clients issue perfectly well without it; the only thing lost is the reminder
# mail, and the box says so once rather than every run.
#
# certbot is the awkward one: it refuses to run non-interactively with neither
# -m nor --register-unsafely-without-email, so the flag has to be chosen rather
# than the argument left empty.
_certbot_email_args() {
	if [[ -n "$ACME_EMAIL" ]]; then
		printf '%s\n%s\n' -m "$ACME_EMAIL"
	else
		printf '%s\n' --register-unsafely-without-email
	fi
}

_warn_no_acme_email() {
	[[ -n "$ACME_EMAIL" ]] && return 0
	info "no ACME_EMAIL set -- the cert will issue, but Let's Encrypt cannot"
	info "      send expiry warnings. Set ACME_EMAIL in $SERVER_CONFIG to get them."
	return 0
}

# acme.sh has built-in Porkbun support; certbot has no official plugin for it.
_issue_cert_porkbun() {
	local args=() n
	while read -r n; do args+=("$n"); done < <(cert_args dns01)
	[[ ${#args[@]} -gt 0 ]] || return 1

	_warn_no_acme_email
	if [[ ! -x "$ACME_HOME/acme.sh" ]]; then
		# The installer takes email= as an optional argument; passing an empty
		# one registers the account to the literal empty string, so it is left
		# off entirely rather than passed blank.
		if [[ -n "$ACME_EMAIL" ]]; then
			curl -fsSL https://get.acme.sh | env HOME=/root sh -s "email=$ACME_EMAIL" \
				|| { warn "acme.sh install failed"; return 1; }
		else
			curl -fsSL https://get.acme.sh | env HOME=/root sh \
				|| { warn "acme.sh install failed"; return 1; }
		fi
	fi
	install -d -m 0755 "$CERT_DIR"

	# --server letsencrypt: acme.sh defaults to ZeroSSL, which wants a
	# registered account. --force so a changed name list is honoured rather
	# than skipped as "cert not yet due for renewal".
	env HOME=/root \
		PORKBUN_API_KEY="$PORKBUN_API_KEY" \
		PORKBUN_SECRET_API_KEY="$PORKBUN_SECRET_API_KEY" \
		"$ACME_HOME/acme.sh" --issue --server letsencrypt --dns dns_porkbun \
			--force "${args[@]}" \
		|| { warn "acme.sh could not issue the cert (API access enabled on the domain?)"; return 1; }

	# land it where nginx already looks, and reload on every renewal
	env HOME=/root "$ACME_HOME/acme.sh" --install-cert -d "$WEB_DOMAIN" \
		--fullchain-file "$CERT_DIR/fullchain.pem" \
		--key-file "$CERT_DIR/privkey.pem" \
		--reloadcmd "systemctl reload nginx"
}

_issue_cert_cloudflare() {
	local args=() n
	while read -r n; do args+=("$n"); done < <(cert_args dns01)
	[[ ${#args[@]} -gt 0 ]] || return 1

	if [[ -n "$CLOUDFLARE_API_TOKEN" && ! -s "$CF_CREDENTIALS" ]]; then
		install -d -m 0700 "$(dirname "$CF_CREDENTIALS")"
		printf 'dns_cloudflare_api_token = %s\n' "$CLOUDFLARE_API_TOKEN" >"$CF_CREDENTIALS"
	fi
	[[ -s "$CF_CREDENTIALS" ]] || return 1
	chmod 0600 "$CF_CREDENTIALS"
	_warn_no_acme_email
	local mail=() m
	while read -r m; do mail+=("$m"); done < <(_certbot_email_args)
	certbot certonly --non-interactive --agree-tos --expand \
		--cert-name "$WEB_DOMAIN" \
		--dns-cloudflare --dns-cloudflare-credentials "$CF_CREDENTIALS" \
		--dns-cloudflare-propagation-seconds 30 \
		"${mail[@]}" "${args[@]}"
}

# No DNS credentials needed: http-01 validates each name individually by
# serving a file over port 80. It cannot do *.domain -- hence one -d per
# existing name -- and it does require this host to be reachable from the
# internet on port 80, which DNS-01 does not.
_issue_cert_http01() {
	local args=() n
	# always http01: this runs as the fallback with the DNS credentials still
	# set, and asking certbot --webroot for a wildcard fails the whole request
	while read -r n; do args+=("$n"); done < <(cert_args http01)
	[[ ${#args[@]} -gt 0 ]] || return 1

	install -d -m 0755 "$ACME_WEBROOT"
	info "http-01 for: $(desired_cert_names http01 | tr '\n' ' ')"
	_warn_no_acme_email
	local mail=() m
	while read -r m; do mail+=("$m"); done < <(_certbot_email_args)
	# --cert-name keeps the path stable so nginx needs no reconfiguration;
	# --expand lets a later run add newly created users to the same cert.
	certbot certonly --non-interactive --agree-tos --expand \
		--cert-name "$WEB_DOMAIN" \
		--webroot -w "$ACME_WEBROOT" \
		"${mail[@]}" "${args[@]}"
}

# Renewal has to be somebody's job or the box quietly goes dark in 90 days.
# acme.sh installs its own cron on first use; certbot ships a systemd timer.
ensure_cert_renewal() {
	if [[ -x "$ACME_HOME/acme.sh" ]] && [[ -d "$ACME_HOME/$WEB_DOMAIN" || -d "$ACME_HOME/${WEB_DOMAIN}_ecc" ]]; then
		crontab -l 2>/dev/null | grep -q 'acme.sh --cron' \
			|| env HOME=/root "$ACME_HOME/acme.sh" --install-cronjob >/dev/null 2>&1
		info "renewal: acme.sh cron"
		return 0
	fi
	if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
		systemctl is-enabled certbot.timer >/dev/null 2>&1 \
			|| systemctl enable --now certbot.timer >/dev/null 2>&1
		# make sure a renewal actually reaches nginx
		install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
		write_if_changed /etc/letsencrypt/renewal-hooks/deploy/reload-nginx 0755 <<'EOF' \
			&& note "certbot deploy hook"
#!/bin/sh
# managed by cli-tools/root-ubuntu.sh
systemctl reload nginx
EOF
		info "renewal: certbot.timer"
		return 0
	fi
	warn "no renewal mechanism found -- the certificate will expire"
	return 1
}

issue_wildcard_cert() {
	local missing days
	days="$(cert_days_left)"
	missing="$(cert_missing_names)"

	if [[ -s "$CERT_DIR/fullchain.pem" && -z "$missing" && "$days" -gt "$CERT_RENEW_DAYS" ]]; then
		info "cert for $WEB_DOMAIN covers everything, $days days left"
		ensure_cert_renewal
		return 0
	fi
	[[ -n "$missing" ]] && info "cert is missing: $(printf '%s' "$missing" | tr '\n' ' ')"
	[[ -s "$CERT_DIR/fullchain.pem" && "$days" -le "$CERT_RENEW_DAYS" ]] \
		&& info "cert expires in $days days -- renewing"

	if [[ -n "$PORKBUN_API_KEY" && -n "$PORKBUN_SECRET_API_KEY" ]]; then
		if _issue_cert_porkbun; then note "certificate"; ensure_cert_renewal; return 0; fi
		warn "porkbun dns-01 failed -- trying http-01 for the named hosts"
	elif [[ -n "$CLOUDFLARE_API_TOKEN" || -s "$CF_CREDENTIALS" ]]; then
		if _issue_cert_cloudflare; then note "certificate"; ensure_cert_renewal; return 0; fi
		warn "cloudflare dns-01 failed -- trying http-01 for the named hosts"
	else
		info "no DNS API credentials -- a wildcard needs dns-01, so falling back"
		info "to http-01 for $WEB_DOMAIN and each existing name."
		info "Per-user dev apps (*.<user>.$WEB_DOMAIN) NEED dns-01:"
		info "  sudo PORKBUN_API_KEY=pk1_... PORKBUN_SECRET_API_KEY=sk1_... $0"
	fi

	_issue_cert_http01 && { note "certificate"; ensure_cert_renewal; return 0; }
	return 1
}

LANDING=/var/www/userdirs/index.html
LANDING_MARKER="generated by cli-tools/root-ubuntu.sh"

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
	# configure_nginx runs twice per invocation (before and after the cert);
	# a logo that is already there and less than a week old is good enough.
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
		&& ! grep -q 'generated by dottemplates/root-ubuntu.sh' "$LANDING" \
		&& ! grep -q 'User pages are at' "$LANDING"; then
		info "$LANDING was edited by hand -- leaving it alone"
		return 0
	fi

	local proto=http u _mail_host _logo _blog
	[[ -s "$CERT_DIR/fullchain.pem" ]] && proto=https
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
  <p class="sub">Profullstack dev box &mdash; staff links and user pages.</p>

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
     directly and nginx is what terminates TLS for you.</p>

  <h2>Stack</h2>
  <ul>
    <li><a href="https://nodejs.org/docs/latest/api/">Node.js<small>nodejs.org</small></a></li>
    <li><a href="https://pnpm.io/motivation">pnpm<small>pnpm.io</small></a></li>
    <li><a href="https://docs.deno.com/">Deno<small>docs.deno.com</small></a></li>
    <li><a href="https://bun.sh/docs">Bun<small>bun.sh/docs</small></a></li>
    <li><a href="https://mise.jdx.dev/">mise<small>mise.jdx.dev</small></a></li>
    <li><a href="https://supabase.com/docs">Supabase<small>supabase.com/docs</small></a></li>
    <li><a href="https://docs.turso.tech/">Turso<small>turso.tech &middot; SQLite in the cloud</small></a></li>
    <li><a href="https://nginx.org/en/docs/">nginx<small>nginx.org</small></a></li>
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

# Two separate vhosts, deliberately not one shared body: with a single server
# block matching both names, a request to user.$WEB_DOMAIN/ finds the bare
# domain's own index.html and serves the landing page instead of the user's.
# One http-context map defining $bad_bot, consumed by every vhost below.
# Matching is case-insensitive (~*) and on substrings, because these crawlers
# append versions and URLs to their User-Agent.
write_bad_bots_map() {
	{
		echo "# managed by cli-tools/root-ubuntu.sh -- AI crawler / scraper blocklist"
		echo "map \$http_user_agent \$bad_bot {"
		echo "	default 0;"
		if [[ "$BLOCK_AI_BOTS" == 1 ]]; then
			local ua
			for ua in "${AI_CRAWLER_AGENTS[@]}"; do
				echo "	\"~*$ua\" 1;"
			done
		fi
		echo "}"
	} | write_if_changed "$BAD_BOTS_MAP"
}

# Emitted into both vhosts that serve ~/public_html, so /~user/x/ and
# user.$WEB_DOMAIN/x/ cannot drift apart about what they show.
_nginx_sponsor_ad_locations() {
	[[ "$SPONSOR_AD" == 1 ]] || return 0
	cat <<EOF


	# Sponsor ad. random_index picks one of the pre-rendered creatives in the
	# pool per request -- that is what makes the ad rotate on reload without
	# any page view waiting on the ad network. Refilled by
	# profullstack-sponsor-ad.timer; serving one is a single open().
	#
	# Prefix, not exact: random_index answers by internally redirecting to
	# ${SPONSOR_AD_URI}<file>, and an exact-match location would not catch
	# that second URI -- it would fall through to the vhost root and 404.
	location ^~ ${SPONSOR_AD_URI} {
		internal;
		alias ${SPONSOR_AD_POOL_DIR}/;
		random_index on;
		default_type text/html;
		# An empty pool otherwise falls through to the inherited autoindex and
		# pastes a listing of this directory into every page.
		autoindex off;
		# Nothing to serve must render as nothing: 404 for a missing pool, 403
		# for an empty one. Without this the error body is what gets pasted
		# into the page that included it.
		error_page 404 403 = ${SPONSOR_AD_BLANK_URI};
	}
	location = ${SPONSOR_AD_BLANK_URI} { internal; return 204; }
EOF
}

# The listing half of the ad. autoindex generates the page, so there is no file
# to hold an SSI token and the fragment is prepended to the response body.
#
# Matching on a trailing "/" is what keeps this to listings: a directory that
# HAS an index.html is internally redirected to .../index.html, which no longer
# ends in "/" and so misses this block. That page gets the ad from its own SSI
# token instead -- which is also why replacing index.html drops the ad, rather
# than having one forced on top of whatever the user wrote.
#
# Takes the body of the matching location, so the /~user form can repeat its
# alias -- a regex location cannot inherit one from a sibling.
_nginx_sponsor_ad_listing() {
	[[ "$SPONSOR_AD" == 1 ]] || return 0
	local pattern="$1" body="${2:-}"
	printf '\n\n\tlocation ~ "%s" {\n' "$pattern"
	[[ -n "$body" ]] && printf '%s\n' "$body"
	printf '\t\tadd_before_body %s;\n\t}\n' "$SPONSOR_AD_URI"
}

# SSI is on only where ~/public_html is served, and only to expand that token.
_nginx_sponsor_ad_ssi() {
	[[ "$SPONSOR_AD" == 1 ]] || return 0
	printf '\n\t# expands the sponsor-ad token in ~/public_html/index.html\n\tssi on;\n'
}

# Version-control metadata is not web content. `git init` inside a doc root
# publishes /.git/config -- remotes, full history, sometimes credentials -- and
# scanners sweep for exactly that URL. 404 rather than 403, so a probe cannot
# tell a blocked repo from a directory that never had one.
#
# Scoped to VCS directories on purpose. A blanket "deny all dotfiles" would take
# /.well-known/acme-challenge/ with it and quietly break certificate renewal,
# and it would swallow the sponsor-ad URIs too.
#
# Emitted into every vhost that serves files from a home directory, since the
# whole point is that it applies to paths nobody remembered to think about.
_nginx_deny_vcs() {
	cat <<'EOF'


	# see _nginx_deny_vcs in root-ubuntu.sh
	location ~ "/\.(git|svn|hg|bzr)(/|$)" {
		access_log off;
		return 404;
	}
EOF
}

_nginx_userdir_vhosts() {
	local listen="$1" ssl="$2"

	# <app>.<user>.$WEB_DOMAIN -- one label deeper than the user pages, so the
	# two regexes cannot collide ([a-z0-9_-] does not match a dot).
	#
	# $devapp_port comes from the generated map: set means "proxy to it",
	# empty means "serve ~/apps/<app>/public as a static site".
	[[ "$DEV_APPS" == 1 ]] && cat <<EOF
server {
$listen
	server_name "~^(?<devapp_name>[a-z0-9][a-z0-9-]{0,62})\.(?<devapp_user>[a-z_][a-z0-9_-]{0,31})\.${WEB_DOMAIN//./\\.}\$";
$ssl
	server_tokens off;

	# AI crawlers / scrapers -- \$bad_bot comes from the map in
	# profullstack-badbots.conf. 403 rather than 444 so a false positive is a
	# readable error instead of a hung connection.
	if (\$bad_bot) { return 403; }

	# The polite half of the same policy, for crawlers that do read it.
	location = /robots.txt {
		add_header Content-Type text/plain;
		return 200 "User-agent: GPTBot\\nUser-agent: OAI-SearchBot\\nUser-agent: ChatGPT-User\\nUser-agent: ClaudeBot\\nUser-agent: anthropic-ai\\nUser-agent: Claude-Web\\nUser-agent: PerplexityBot\\nUser-agent: CCBot\\nUser-agent: Google-Extended\\nUser-agent: Applebot-Extended\\nUser-agent: Bytespider\\nUser-agent: Amazonbot\\nUser-agent: meta-externalagent\\nUser-agent: cohere-ai\\nUser-agent: Diffbot\\nDisallow: /\\n";
	}$(_nginx_deny_vcs)
	client_max_body_size 512m;

	location / {
		root /home/\$devapp_user/apps/\$devapp_name/public;
		index index.html;
		autoindex off;

		# A declared port means there is a server running: hand the request
		# over. 'rewrite ... last' is one of the only two things you may
		# safely do inside an if -- proxy_pass in here would inherit the
		# try_files below and 404 every proxied request.
		if (\$devapp_port) {
			rewrite ^ /.devapp-proxy last;
		}

		try_files \$uri \$uri/ =404;
	}

	# internal: only reachable through the rewrite above. \$request_uri is the
	# original path and query, so the app sees exactly what the client sent.
	location = /.devapp-proxy {
		internal;
		proxy_pass http://127.0.0.1:\$devapp_port\$request_uri;
		proxy_http_version 1.1;
		proxy_set_header Host \$host;
		proxy_set_header X-Real-IP \$remote_addr;
		proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto \$scheme;
		# vite/next/HMR all need the websocket upgrade passed through
		proxy_set_header Upgrade \$http_upgrade;
		proxy_set_header Connection \$connection_upgrade;
		# dev servers stream and hot-reload; buffering breaks both
		proxy_buffering off;
		proxy_read_timeout 3600s;
	}
}

EOF

	# username comes from the hostname here, captured by the server_name regex
	cat <<EOF
server {
$listen
	# quoted: the {0,31} braces would otherwise read as a config block
	server_name "~^(?<uname>[a-z_][a-z0-9_-]{0,31})\.${WEB_DOMAIN//./\\.}\$";
$ssl
	root /home/\$uname/public_html;
	index index.html;
	# A directory with no index.html lists its contents instead of 404ing --
	# ~/public_html is a place to drop files, and having to write an index by
	# hand to see them defeats that. index.html still wins where it exists.
	autoindex on;
	autoindex_exact_size off;
	autoindex_localtime on;
	server_tokens off;$(_nginx_sponsor_ad_ssi)

	# AI crawlers / scrapers -- \$bad_bot comes from the map in
	# profullstack-badbots.conf. 403 rather than 444 so a false positive is a
	# readable error instead of a hung connection.
	if (\$bad_bot) { return 403; }

	# The polite half of the same policy, for crawlers that do read it.
	location = /robots.txt {
		add_header Content-Type text/plain;
		return 200 "User-agent: GPTBot\\nUser-agent: OAI-SearchBot\\nUser-agent: ChatGPT-User\\nUser-agent: ClaudeBot\\nUser-agent: anthropic-ai\\nUser-agent: Claude-Web\\nUser-agent: PerplexityBot\\nUser-agent: CCBot\\nUser-agent: Google-Extended\\nUser-agent: Applebot-Extended\\nUser-agent: Bytespider\\nUser-agent: Amazonbot\\nUser-agent: meta-externalagent\\nUser-agent: cohere-ai\\nUser-agent: Diffbot\\nDisallow: /\\n";
	}$(_nginx_deny_vcs)$(_nginx_sponsor_ad_locations)$(_nginx_sponsor_ad_listing '/$')

	location / {
		# \$uri/ has to stay ahead of the fallback: it is what hands a
		# directory to the index/autoindex handler at all
		try_files \$uri \$uri/ =404;
	}
}

server {
$listen
	server_name $WEB_DOMAIN;
$ssl
	root /var/www/userdirs;
	index index.html;
	autoindex off;
	server_tokens off;$(_nginx_sponsor_ad_ssi)

	# AI crawlers / scrapers -- \$bad_bot comes from the map in
	# profullstack-badbots.conf. 403 rather than 444 so a false positive is a
	# readable error instead of a hung connection.
	if (\$bad_bot) { return 403; }

	# The polite half of the same policy, for crawlers that do read it.
	location = /robots.txt {
		add_header Content-Type text/plain;
		return 200 "User-agent: GPTBot\\nUser-agent: OAI-SearchBot\\nUser-agent: ChatGPT-User\\nUser-agent: ClaudeBot\\nUser-agent: anthropic-ai\\nUser-agent: Claude-Web\\nUser-agent: PerplexityBot\\nUser-agent: CCBot\\nUser-agent: Google-Extended\\nUser-agent: Applebot-Extended\\nUser-agent: Bytespider\\nUser-agent: Amazonbot\\nUser-agent: meta-externalagent\\nUser-agent: cohere-ai\\nUser-agent: Diffbot\\nDisallow: /\\n";
	}$(_nginx_deny_vcs)

	# /~user without a trailing slash: redirect so relative links resolve
	location ~ "^/~([a-z_][a-z0-9_-]{0,31})\$" {
		return 301 /~\$1/;
	}$(_nginx_sponsor_ad_locations)$(_nginx_sponsor_ad_listing '^/~([a-z_][a-z0-9_-]{0,31})(/(?:.*/)?)$' \
"		alias /home/\$1/public_html\$2;
		index index.html;
		autoindex on;
		autoindex_exact_size off;
		autoindex_localtime on;")

	# same listing behaviour as the subdomain form, so /~user/x/ and
	# user.$WEB_DOMAIN/x/ do not disagree about what they show
	location ~ "^/~([a-z_][a-z0-9_-]{0,31})(/.*)?\$" {
		alias /home/\$1/public_html\$2;
		index index.html;
		autoindex on;
		autoindex_exact_size off;
		autoindex_localtime on;
	}

	location / {
		try_files \$uri \$uri/ =404;
	}
}
EOF
}

# Port 80 always redirects to 443, so 443 must always answer -- an
# ssl_certificate pointing at a missing file stops nginx from starting at all.
# Until the real cert is issued this self-signed one keeps the listener up
# (browsers will warn, but the redirect works and nothing 5xxs).
FALLBACK_CERT_DIR=/etc/nginx/ssl
ensure_fallback_cert() {
	[[ -s "$FALLBACK_CERT_DIR/fullchain.pem" && -s "$FALLBACK_CERT_DIR/privkey.pem" ]] && return 0
	install -d -m 0755 "$FALLBACK_CERT_DIR"
	openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
		-keyout "$FALLBACK_CERT_DIR/privkey.pem" \
		-out "$FALLBACK_CERT_DIR/fullchain.pem" \
		-subj "/CN=$WEB_DOMAIN" \
		-addext "subjectAltName=DNS:$WEB_DOMAIN,DNS:*.$WEB_DOMAIN" >/dev/null 2>&1 \
		|| { warn "could not generate the fallback certificate"; return 1; }
	chmod 0600 "$FALLBACK_CERT_DIR/privkey.pem"
	warn "using a SELF-SIGNED cert for $WEB_DOMAIN -- browsers will warn until a real one is issued"
	return 0
}

configure_nginx() {
	local crt key changed=0
	if [[ -s "$CERT_DIR/fullchain.pem" ]]; then
		crt="$CERT_DIR/fullchain.pem"; key="$CERT_DIR/privkey.pem"
	else
		ensure_fallback_cert || return 1
		crt="$FALLBACK_CERT_DIR/fullchain.pem"; key="$FALLBACK_CERT_DIR/privkey.pem"
	fi

	# Proxying websockets needs Connection: upgrade on upgrade requests and
	# Connection: close otherwise -- the one map everybody ends up writing.
	write_if_changed /etc/nginx/conf.d/profullstack-upgrade.conf <<'EOF' && changed=1
# managed by cli-tools/root-ubuntu.sh
map $http_upgrade $connection_upgrade {
	default upgrade;
	''      close;
}
EOF

	if [[ "$DEV_APPS" == 1 ]]; then
		write_devapps_generator
	else
		# the map references $devapp_user, a variable that only the dev-app
		# vhost defines. Leaving it behind after DEV_APPS=0 stops nginx from
		# starting at all ("unknown devapp_user variable").
		[[ -e "$DEV_APPS_MAP" ]] && { rm -f "$DEV_APPS_MAP"; changed=1; }
		systemctl disable --now profullstack-devapps.timer >/dev/null 2>&1
	fi

	# must exist before nginx -t: the vhosts below reference $bad_bot, and
	# nginx will not start if no map defines it.
	write_bad_bots_map && changed=1

	# must also come first: the vhosts alias the ad fragment, and it should be
	# on disk before the reload at the end of this function makes them live
	if [[ "$SPONSOR_AD" == 1 ]]; then
		write_sponsor_ad_generator
	else
		remove_sponsor_ad
	fi

	{
		echo "# managed by cli-tools/root-ubuntu.sh -- per-user public_html"
		echo "# https://$WEB_DOMAIN/~user  and  https://user.$WEB_DOMAIN"
		echo
		echo "# port 80: ACME challenges, everything else redirects"
		echo "server {"
		echo "	listen 80 default_server;"
		echo "	listen [::]:80 default_server;"
		echo "	server_name $WEB_DOMAIN *.$WEB_DOMAIN;"
		echo "	# must come before the redirect: an http-01 challenge is fetched"
		echo "	# over http, and a blanket 301 to https would break issuance"
		echo "	location ^~ /.well-known/acme-challenge/ {"
		echo "		root $ACME_WEBROOT;"
		echo "		default_type \"text/plain\";"
		echo "	}"
		echo "	location / { return 301 https://\$host\$request_uri; }"
		echo "}"
		echo
		_nginx_userdir_vhosts \
			$'\tlisten 443 ssl;\n\tlisten [::]:443 ssl;\n\thttp2 on;' \
			"	ssl_certificate     $crt;
	ssl_certificate_key $key;"
	} | write_if_changed /etc/nginx/sites-available/userdirs.conf && changed=1

	fetch_logo || warn "could not fetch $LOGO_URL (landing page will link to it instead)"
	write_landing_page

	if [[ ! -L /etc/nginx/sites-enabled/userdirs.conf ]]; then
		ln -sfn /etc/nginx/sites-available/userdirs.conf \
			/etc/nginx/sites-enabled/userdirs.conf
		changed=1
	fi
	# default vhost would otherwise claim port 80 for every unmatched host
	[[ -e /etc/nginx/sites-enabled/default ]] \
		&& { rm -f /etc/nginx/sites-enabled/default; changed=1; }

	if ! nginx -t; then
		warn "nginx config test failed -- disabling the userdir vhost"
		rm -f /etc/nginx/sites-enabled/userdirs.conf
		nginx -t && systemctl reload nginx
		return 1
	fi
	systemctl is-enabled nginx >/dev/null 2>&1 || systemctl enable nginx

	# Reload only when something actually changed. A maintenance run should be
	# invisible to anyone using the box, and reloading drops in-flight
	# websocket connections to everyone's dev servers.
	if [[ "$changed" == 1 ]] || ! systemctl is-active nginx >/dev/null 2>&1; then
		note "nginx config"
		systemctl reload nginx || systemctl restart nginx
	else
		info "nginx config unchanged -- not reloading"
	fi
	# which cert ended up in use is already reported by ensure_fallback_cert
	return 0
}

# ------------------------------------------------------------------ users ---

create_user() {
	local spec="$1" groups="$2" login home pass g
	login="$(user_login "$spec")"

	if id -u "$login" >/dev/null 2>&1; then
		info "user $login already exists"
	else
		info "creating user $login"
		useradd -m -s /bin/zsh -c "$spec" "$login" || { warn "useradd $login failed"; return 1; }
		if interactive; then
			read -r -s -p "    password for ${login} (blank = key-only login): " pass; echo
			if [[ -n "$pass" ]]; then
				printf '%s:%s\n' "$login" "$pass" | chpasswd
			else
				passwd -l "$login" >/dev/null
			fi
			unset pass
		else
			passwd -l "$login" >/dev/null
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

	ensure_zsh_shell "$login" || warn "$login may still be on bash"

	for g in ${groups//,/ }; do
		getent group "$g" >/dev/null || groupadd "$g" || { warn "cannot create group $g"; continue; }
		usermod -aG "$g" "$login" || warn "could not add $login to $g"
	done
	info "$login groups: $(id -nG "$login")"

	refresh_user "$login"
	remember_user "$login"
	return 0
}

# What a re-run does to an account that already exists: no useradd, no
# password, no group changes, no questions -- just bring the files we own up
# to date and re-assert the permissions sshd and nginx depend on.
refresh_user() {
	local login="$1" home
	home="$(user_home "$login")"
	[[ -n "$home" && -d "$home" ]] || { warn "no home dir for $login"; return 1; }

	# Adopted accounts arrive on whatever shell the cloud image gave them --
	# /home/ubuntu is the usual one. Without this a refresh left them on bash
	# forever while installing a zsh setup around them. ensure_zsh_shell only
	# converts from bash/sh, so a deliberate choice of anything else stands.
	ensure_zsh_shell "$login" || warn "$login may still be on bash"

	install_dotfiles "$home" "$login"
	install_public_html "$home" "$login"
	install_dev_apps_dir "$home" "$login"
	enable_ssh_agent_for "$login"
	# last word on permissions, after everything has written into the home
	fix_home_permissions "$home" "$login" || warn "$login home permissions need attention"
	return 0
}

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

log "installing dotfiles for root"
try "root dotfiles" install_dotfiles /root root
# our .zshrc has a dedicated root prompt, so root runs zsh too
try "root login shell -> zsh" ensure_zsh_shell root
# root does not go through refresh_user, so it needs its own linger
enable_ssh_agent_for root

if [[ "$SKIP_TOOLS" == 1 ]]; then
	log "skipping oh-my-zsh/mise/moshcode (--skip-tools)"
else
	log "installing/updating oh-my-zsh, mise, moshcode"
	# these installers are all "fetch the current version and put it in place",
	# so running them again is exactly how the box picks up new releases
	while read -r login; do
		[[ -n "$login" ]] || continue
		id -u "$login" >/dev/null 2>&1 || continue
		try "oh-my-zsh ($login)" install_omz "$login"
		try "mise ($login)"      install_mise "$login"
		try "moshcode ($login)"  install_moshcode "$login"
		# separate step: installing moshcode does not update what it manages
		try "moshcode tools ($login)" update_moshcode_tools "$login"
	done < <(printf 'root\n'; all_logins)
fi

# ---------------------------------------------------------------- wrap up ---

if [[ "$SKIP_TAILSCALE" == 1 ]]; then
	log "skipping tailscale (--skip-tailscale)"
else
	log "installing tailscale"
	try "tailscale" install_tailscale
fi

PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
	|| hostname -I | awk '{print $1}')"

if [[ "$SKIP_WEB" == 1 ]]; then
	log "skipping web/TLS (--skip-web)"
else
	log "configuring per-user web hosting on $WEB_DOMAIN"

	# DNS before the cert: a dns-01 challenge for *.<user>.$WEB_DOMAIN only
	# works once the zone knows about the name, and http-01 needs the name to
	# resolve here at all.
	if [[ -n "$PORKBUN_API_KEY" && -n "$PORKBUN_SECRET_API_KEY" ]]; then
		try "dns records at porkbun" ensure_dns_records "$PUBLIC_IP"
	fi

	# nginx first: http-01 needs something answering on port 80 to serve the
	# challenge. It comes up on the self-signed fallback if there is no cert yet.
	try "nginx userdir vhosts" configure_nginx
	try "certificate for $WEB_DOMAIN" issue_wildcard_cert
	# again, to pick up a cert that was just issued (no-op otherwise)
	if [[ -s "$CERT_DIR/fullchain.pem" ]]; then
		try "nginx with the issued certificate" configure_nginx
	fi
	# compile the dev-app routes now rather than waiting for the timer
	[[ "$DEV_APPS" == 1 && -x /usr/local/bin/profullstack-devapps ]] \
		&& /usr/local/bin/profullstack-devapps
fi

# only when it is actually wrong -- otherwise this is noise on every run
if [[ "$(timedatectl show -p Timezone --value 2>/dev/null)" != UTC ]]; then
	try "set timezone" timedatectl set-timezone UTC && note "timezone -> UTC"
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
info "ufw:  $(ufw status | head -1)"
info "open: $(ufw status | awk '/ALLOW/{printf "%s ", $1}')"
info "mosh: $(command -v mosh-server >/dev/null && echo "$(mosh-server --version 2>&1 | head -1)" || echo 'MISSING')"
info "tail: $(tailscale ip -4 2>/dev/null | head -1 || echo 'not joined to a tailnet')"
info "motd: $([[ -s $MOTD_CACHE ]] && echo "cached ($(wc -l <"$MOTD_CACHE") lines)" || echo 'empty')"
info "ram:  $(free -h | awk '/^Mem:/{printf "%s total, %s available", $2, $7}')"
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
		"$([[ -e "$h/.local/bin/moshcode" || -e "$h/.moshcode" ]] && echo ok || echo '?')" \
		"$([[ -e "$h/.tmux.conf" ]]        && echo ok || echo MISS)" \
		"$(find "$h/apps" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)" \
		"$(getent passwd "$login" | cut -d: -f7)"
done < <(printf 'root\n'; all_logins)

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
	if [[ "$_nkeys" -eq 0 ]]; then
		if [[ "$_pwauth" == no ]]; then
			warn "$l has NO keys in ~/.ssh/authorized_keys and sshd refuses passwords -- they cannot log in"
		elif [[ "$_pw" == L ]]; then
			warn "$l has no keys and a locked password"
		fi
		info "      fix: put their public key in ssh-keys/$l.pub and re-run, or"
		info "           echo '<their key>' >> $h/.ssh/authorized_keys"
	else
		info "$l: $_nkeys key(s) authorised"
	fi
done < <(all_logins)

echo
info "DNS records required for $WEB_DOMAIN (point at this host):"
info "    A    $WEB_DOMAIN      ->  ${PUBLIC_IP:-<this server ip>}"
info "    A    *.$WEB_DOMAIN    ->  ${PUBLIC_IP:-<this server ip>}"
if [[ "$DEV_APPS" == 1 ]]; then
	# DNS wildcards match ONE label, so *.dev.profullstack.com does not answer
	# for api.alice.dev.profullstack.com. Each user needs their own.
	while read -r l; do
		info "    A    *.$l.$WEB_DOMAIN  ->  ${PUBLIC_IP:-<this server ip>}   (${l}'s dev apps)"
	done < <(web_users)
fi
if [[ -s "$CERT_DIR/fullchain.pem" ]]; then
	info "cert: expires $(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2) ($(cert_days_left) days)"
	info "      names: $(cert_names | tr '\n' ' ')"
	_miss="$(cert_missing_names)"
	[[ -n "$_miss" ]] && warn "not covered by the cert: $(printf '%s' "$_miss" | tr '\n' ' ')"
else
	info "cert: none yet (self-signed fallback in use). To issue the real one:"
	info "      sudo PORKBUN_API_KEY=pk1_... PORKBUN_SECRET_API_KEY=sk1_... $0"
fi
while read -r l; do
	info "    https://$WEB_DOMAIN/~$l  |  https://$l.$WEB_DOMAIN"
	[[ "$DEV_APPS" == 1 ]] && info "        dev apps: mkdir ~/apps/<name>  ->  https://<name>.$l.$WEB_DOMAIN"
done < <(all_logins)

# ---------------------------------------------------------------- reboot ---
#
# This script is re-run on a live box, so a reboot is never the default. Even
# when one is genuinely required, someone may be mid-session -- so say who is
# logged in and let a human decide.
echo
_reboot_required=0
[[ -e /var/run/reboot-required ]] && _reboot_required=1
if [[ "$_reboot_required" == 1 ]]; then
	warn "a reboot is required (kernel or libc updated)"
	[[ -s /var/run/reboot-required.pkgs ]] \
		&& info "      $(tr '\n' ' ' </var/run/reboot-required.pkgs)"
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
	info "      run 'sudo reboot' when the box is free"
elif confirm "Reboot now? ${_sessions:+($_sessions session(s) open) }[y/N]" n; then
	info "rebooting in 5s..."
	sleep 5
	reboot
fi
