#!/bin/sh
# cli-tools installer.
#
#   curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh
#
# Clones (or updates) the repository, installs its dependencies, and symlinks
# every command into ~/.local/bin. POSIX sh on purpose: this is what
# `moshcode install cli-tools` runs, and that runs it with `sh -c`.
#
# Environment:
#   CLI_TOOLS_HOME     where the checkout lives (default ~/.local/share/cli-tools)
#   CLI_TOOLS_PREFIX   where the commands are linked (default ~/.local/bin)
#   CLI_TOOLS_REPO     clone URL
#   CLI_TOOLS_BRANCH   branch to track (default master)
#   CLI_TOOLS_FORCE    set to 1 to take over links owned by another checkout
#   CLI_TOOLS_SKIP_STRIPE  set to 1 to skip the Stripe CLI
#   STRIPE_CLI_VERSION     pin the Stripe CLI (default: latest release)
#   CLI_TOOLS_SKIP_SKILL   set to 1 to skip the Profullstack agent skill
#   PROFULLSTACK_INSTALL_URL  where that skill installer lives

set -eu

REPO="${CLI_TOOLS_REPO:-https://github.com/profullstack/cli-tools.git}"
BRANCH="${CLI_TOOLS_BRANCH:-master}"
PREFIX="${CLI_TOOLS_PREFIX:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'cli-tools: %s\n' "$*" >&2; exit 1; }

need() {
	command -v "$1" >/dev/null 2>&1 || die "$2"
}

need git "git is required. Install it, then re-run this installer."
need node "Node 20 or newer is required. Install it, then re-run this installer."

# Node 20 is the floor: the commands use `import ... with`-era syntax and the
# test runner assumes it. Checking here names the problem, rather than letting
# it surface as a parse error inside an unrelated command later.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20 or newer is required (found $(node -v))."

# If a checkout already owns the installed commands, update THAT one rather than
# cloning a second copy beside it. Without this, a contributor working from
# ~/src/… would get a duplicate clone whose links are all refused as
# not-ours, and no explanation of why nothing changed.
existing_home() {
	for probe in blog-post domainfree gh-prs cli-tools; do
		link="$PREFIX/$probe"
		[ -L "$link" ] || continue
		resolved="$(cd "$(dirname "$link")" && readlink "$link")" || continue
		case "$resolved" in
			/*) ;;
			*) resolved="$PREFIX/$resolved" ;;
		esac
		root="$(dirname "$(dirname "$resolved")")"
		if [ -d "$root/.git" ] && [ -d "$root/bin" ]; then
			printf '%s\n' "$root"
			return 0
		fi
	done
	return 1
}

if [ -n "${CLI_TOOLS_HOME:-}" ]; then
	HOME_DIR="$CLI_TOOLS_HOME"
elif HOME_DIR="$(existing_home)"; then
	say "Using the checkout that already owns your commands: $HOME_DIR"
else
	HOME_DIR="$HOME/.local/share/cli-tools"
fi

if [ -d "$HOME_DIR/.git" ]; then
	say "Updating $HOME_DIR"
	# A contributor's checkout may sit on a feature branch with work on it.
	# Fetching always and fast-forwarding only when it is safe means the
	# installer keeps them current without ever discarding anything.
	git -C "$HOME_DIR" fetch --quiet origin "$BRANCH" || die "could not fetch from origin."
	if [ -z "$(git -C "$HOME_DIR" status --porcelain)" ]; then
		git -C "$HOME_DIR" merge --quiet --ff-only "origin/$BRANCH" 2>/dev/null \
			|| say "  left on $(git -C "$HOME_DIR" rev-parse --abbrev-ref HEAD) — not a fast-forward, so nothing was moved."
	else
		say "  working tree is dirty — fetched, but not moved."
	fi
else
	say "Cloning into $HOME_DIR"
	mkdir -p "$(dirname "$HOME_DIR")"
	git clone --quiet --branch "$BRANCH" "$REPO" "$HOME_DIR" \
		|| die "clone failed. Is $REPO reachable?"
fi

say "Installing dependencies"
if command -v pnpm >/dev/null 2>&1; then
	# pnpm is what the lockfile is for; --prefer-offline keeps a re-run cheap.
	(cd "$HOME_DIR" && pnpm install --silent --prefer-offline) || die "pnpm install failed."
else
	# npm cannot read pnpm-lock.yaml, so this resolves fresh. It is the fallback,
	# not the intent, but it produces a working tsx and that is what matters.
	(cd "$HOME_DIR" && npm install --silent --no-audit --no-fund) || die "npm install failed."
fi

say "Linking commands into $PREFIX"
LINK_ARGS=""
[ "${CLI_TOOLS_FORCE:-0}" = "1" ] && LINK_ARGS="--force"
# shellcheck disable=SC2086
CLI_TOOLS_PREFIX="$PREFIX" node "$HOME_DIR/scripts/install-links.mjs" $LINK_ARGS

# ── Companions ───────────────────────────────────────────────────────────────
#
# Commands this set ships but does not implement: published packages that bring
# their own binary. The list lives in src/companions.ts and is read from there
# rather than repeated here, so adding one is a single-file change.
#
# Run through the checkout's own dispatcher rather than $PREFIX/cli-tools: the
# link above is refused when another checkout already owns that name, and this
# should still work on such a box.
#
# Warns rather than dying, like the Stripe block below. npm being absent or a
# prefix being read-only should not fail an install that has otherwise
# succeeded — and CLI_TOOLS_NO_COMPANIONS=1 skips it entirely for anyone who
# would rather manage those packages themselves.
if [ "${CLI_TOOLS_NO_COMPANIONS:-0}" != "1" ]; then
	say "Installing companions (timer, billing, bw, …)"
	# The default set only. The grouped ones -- `mobile`, which is adb plus half
	# a gigabyte of Expo -- are installed when somebody asks for them and not
	# because they ran an installer. `cli-tools companions` names them.
	"$HOME_DIR/bin/cli-tools.ts" companions --install ||
		printf 'cli-tools: companions skipped. Install them later with: cli-tools companions --install\n' >&2
fi

# ── Stripe CLI ───────────────────────────────────────────────────────────────
#
# Not one of this repo's commands: it is the official binary from
# stripe/stripe-cli. It lives here because the payment work needs it on every
# box, and "install the Stripe CLI first" is exactly the setup step that
# quietly never happens.
#
# Vendored under $HOME_DIR/vendor/stripe for the same reason codeburn is: the
# name should exist once. If some other stripe is already on PATH, that one is
# left alone and nothing is linked over it.
#
# This runs AFTER the commands are linked, and warns rather than dying. A
# GitHub outage or an unknown architecture should not fail an install that has
# otherwise already succeeded.

# Last release verified against this installer. Used when the version cannot be
# resolved from the API, which is mostly rate limiting on a shared IP.
STRIPE_FALLBACK_VERSION="1.50.4"

stripe_platform() {
	# Asset names look like stripe_1.50.4_linux_x86_64.tar.gz — note that the
	# macOS ones say mac-os, and that arm64 is arm64 on both.
	os="$(uname -s)"
	arch="$(uname -m)"
	case "$os" in
		Linux) os="linux" ;;
		Darwin) os="mac-os" ;;
		*) return 1 ;;
	esac
	case "$arch" in
		x86_64 | amd64) arch="x86_64" ;;
		aarch64 | arm64) arch="arm64" ;;
		*) return 1 ;;
	esac
	printf '%s_%s\n' "$os" "$arch"
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		return 1
	fi
}

install_stripe() {
	[ "${CLI_TOOLS_SKIP_STRIPE:-0}" = "1" ] && return 0

	vendor="$HOME_DIR/vendor/stripe"

	# Someone else's stripe on PATH wins. Ours would only shadow it depending on
	# the order of two directories, which is not a thing to leave to chance.
	existing="$(command -v stripe 2>/dev/null || true)"
	if [ -n "$existing" ] && [ "$existing" != "$PREFIX/stripe" ]; then
		say "  stripe already on PATH at $existing — left alone."
		return 0
	fi

	command -v curl >/dev/null 2>&1 || { say "  skipped: curl is required."; return 0; }
	command -v tar >/dev/null 2>&1 || { say "  skipped: tar is required."; return 0; }

	platform="$(stripe_platform)" || {
		say "  skipped: no Stripe CLI build for $(uname -s)/$(uname -m)."
		return 0
	}

	version="${STRIPE_CLI_VERSION:-}"
	if [ -z "$version" ]; then
		# Plain grep/sed rather than jq, which is not a dependency anywhere else
		# in this installer.
		version="$(curl -fsSL https://api.github.com/repos/stripe/stripe-cli/releases/latest 2>/dev/null \
			| sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
		[ -n "$version" ] || version="$STRIPE_FALLBACK_VERSION"
	fi
	version="${version#v}"

	# Already at the wanted version? Then there is nothing to download.
	if [ -x "$vendor/stripe" ] && [ "$($vendor/stripe --version 2>/dev/null | sed -n 's/.*version \([0-9.]*\).*/\1/p')" = "$version" ]; then
		say "  stripe $version already installed."
		return 0
	fi

	case "$platform" in
		mac-os_*) sums="stripe-mac-checksums.txt" ;;
		*) sums="stripe-linux-checksums.txt" ;;
	esac
	tarball="stripe_${version}_${platform}.tar.gz"
	base="https://github.com/stripe/stripe-cli/releases/download/v${version}"

	tmp="$(mktemp -d)" || { say "  skipped: could not create a temp dir."; return 0; }

	if ! curl -fsSL "$base/$tarball" -o "$tmp/$tarball"; then
		say "  skipped: could not download $tarball."
		rm -rf "$tmp"
		return 0
	fi

	# The checksum comes from the same host as the tarball, so this is not a
	# supply-chain guarantee — it catches a truncated or corrupted download,
	# which is the failure this actually sees.
	if curl -fsSL "$base/$sums" -o "$tmp/sums.txt" 2>/dev/null; then
		want="$(grep " $tarball\$" "$tmp/sums.txt" 2>/dev/null | cut -d' ' -f1)"
		got="$(sha256_of "$tmp/$tarball" 2>/dev/null || true)"
		if [ -n "$want" ] && [ -n "$got" ] && [ "$want" != "$got" ]; then
			say "  skipped: checksum mismatch on $tarball."
			rm -rf "$tmp"
			return 0
		fi
	fi

	if ! tar -xzf "$tmp/$tarball" -C "$tmp" stripe 2>/dev/null; then
		say "  skipped: could not extract stripe from $tarball."
		rm -rf "$tmp"
		return 0
	fi

	mkdir -p "$vendor"
	# mv onto the old binary rather than writing in place: a running stripe
	# keeps its inode, and the replacement is atomic.
	mv "$tmp/stripe" "$vendor/stripe"
	chmod +x "$vendor/stripe"
	rm -rf "$tmp"

	mkdir -p "$PREFIX"
	ln -sf "$vendor/stripe" "$PREFIX/stripe"
	say "  stripe $version -> $PREFIX/stripe"
}

say "Installing the Stripe CLI"
install_stripe

# ── tea (Forgejo/Gitea CLI) ──────────────────────────────────────────────────
#
# git.profullstack.com runs Forgejo, which serves a Gitea-compatible /api/v1.
# `gh` cannot talk to it — it only speaks GitHub.com and GitHub Enterprise — so
# every issue, PR and release on our own forge is otherwise a browser tab. tea
# is the CLI that does speak that API, and it belongs on the same footing as
# the Stripe CLI: the box that has the commands should have the tool they talk
# to the forge with.
#
# Vendored under $HOME_DIR/vendor/tea and linked into $PREFIX, so the name
# exists once. A tea already on PATH from somewhere else is left alone.
#
# Unlike the Stripe CLI this is a bare binary rather than a tarball, so there is
# no tar dependency — download, check the sha256, chmod, move.
#
# Authenticate once, per forge:
#   tea login add --name agentgit --url https://git.profullstack.com --token <token>
# The token comes from /user/settings/applications on the forge. It is a
# credential: it belongs in tea's own config under $XDG_CONFIG_HOME/tea, and in
# the vault -- not in a shell rc and not in this repository.

# Last release verified against this installer. Used when the version cannot be
# resolved from the API, which is mostly rate limiting on a shared IP.
TEA_FALLBACK_VERSION="0.16.0"

tea_platform() {
	# Asset names look like tea-0.16.0-linux-amd64 — no tarball, no libc
	# variants, and arm64 is arm64 on both platforms.
	os="$(uname -s)"
	arch="$(uname -m)"
	case "$os" in
		Linux) os="linux" ;;
		Darwin) os="darwin" ;;
		FreeBSD) os="freebsd" ;;
		*) return 1 ;;
	esac
	case "$arch" in
		x86_64 | amd64) arch="amd64" ;;
		aarch64 | arm64) arch="arm64" ;;
		*) return 1 ;;
	esac
	# There is no freebsd-arm64 build; saying so here beats a 404 later.
	if [ "$os" = "freebsd" ] && [ "$arch" != "amd64" ]; then
		return 1
	fi
	printf '%s-%s\n' "$os" "$arch"
}

tea_version_of() {
	# `tea --version` prints "Version: <ESC>[1m0.16.0<ESC>[0m\tgolang: …" — the
	# number arrives wrapped in ANSI bold even when stdout is not a terminal,
	# so the escapes come off before anything tries to read a version out.
	"$1" --version 2>/dev/null | tr -d '\033' | sed 's/\[[0-9;]*m//g' \
		| sed -n 's/^Version: *\([0-9][0-9.]*\).*/\1/p' | head -1
}

install_tea() {
	[ "${CLI_TOOLS_SKIP_TEA:-0}" = "1" ] && return 0

	vendor="$HOME_DIR/vendor/tea"

	# Someone else's tea on PATH wins, for the same reason the Stripe CLI
	# defers: ours would only shadow it depending on the order of two
	# directories, which is not a thing to leave to chance.
	existing="$(command -v tea 2>/dev/null || true)"
	if [ -n "$existing" ] && [ "$existing" != "$PREFIX/tea" ]; then
		say "  tea already on PATH at $existing — left alone."
		return 0
	fi

	command -v curl >/dev/null 2>&1 || { say "  skipped: curl is required."; return 0; }

	platform="$(tea_platform)" || {
		say "  skipped: no tea build for $(uname -s)/$(uname -m)."
		return 0
	}

	version="${TEA_CLI_VERSION:-}"
	if [ -z "$version" ]; then
		# tea is released on gitea.com, not GitHub, so this is the Gitea API
		# rather than the GitHub one. Plain sed for the same reason as above:
		# jq is not a dependency anywhere else in this installer.
		version="$(curl -fsSL https://gitea.com/api/v1/repos/gitea/tea/releases/latest 2>/dev/null \
			| sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
		[ -n "$version" ] || version="$TEA_FALLBACK_VERSION"
	fi
	version="${version#v}"

	# Already at the wanted version? Then there is nothing to download.
	if [ -x "$vendor/tea" ] && [ "$(tea_version_of "$vendor/tea")" = "$version" ]; then
		say "  tea $version already installed."
		return 0
	fi

	asset="tea-${version}-${platform}"
	base="https://gitea.com/gitea/tea/releases/download/v${version}"

	tmp="$(mktemp -d)" || { say "  skipped: could not create a temp dir."; return 0; }

	if ! curl -fsSL "$base/$asset" -o "$tmp/tea"; then
		say "  skipped: could not download $asset."
		rm -rf "$tmp"
		return 0
	fi

	# Same caveat as the Stripe CLI: the checksum comes from the same host as
	# the binary, so this is not a supply-chain guarantee — it catches a
	# truncated or corrupted download, which is the failure this actually sees.
	if curl -fsSL "$base/checksums.txt" -o "$tmp/sums.txt" 2>/dev/null; then
		want="$(grep " $asset\$" "$tmp/sums.txt" 2>/dev/null | cut -d' ' -f1)"
		got="$(sha256_of "$tmp/tea" 2>/dev/null || true)"
		if [ -n "$want" ] && [ -n "$got" ] && [ "$want" != "$got" ]; then
			say "  skipped: checksum mismatch on $asset."
			rm -rf "$tmp"
			return 0
		fi
	fi

	# A downloaded binary that will not run is worse than no binary: it shadows
	# nothing but fails at the point of use, long after this installer has said
	# it succeeded. One exec now is cheap.
	chmod +x "$tmp/tea"
	if [ -z "$(tea_version_of "$tmp/tea")" ]; then
		say "  skipped: the downloaded $asset does not run here."
		rm -rf "$tmp"
		return 0
	fi

	mkdir -p "$vendor"
	# mv onto the old binary rather than writing in place: a running tea keeps
	# its inode, and the replacement is atomic.
	mv "$tmp/tea" "$vendor/tea"
	rm -rf "$tmp"

	mkdir -p "$PREFIX"
	ln -sf "$vendor/tea" "$PREFIX/tea"
	say "  tea $version -> $PREFIX/tea"
}

say "Installing tea (the Forgejo/Gitea CLI)"
install_tea

# ── Profullstack skill ──────────────────────────────────────────────────
#
#   curl -fsSL https://profullstack.com/install.sh | sh
#
# The agent-facing half of this set. That published installer writes
# profullstack.com/skill.md once to ~/.agents/skills/profullstack and links it
# into every coding agent on the box -- Claude Code, Codex, Gemini, qwen,
# opencode, Crush, Goose, Cursor, Windsurf and the rest -- which is how
# whatever agent you drive these commands with learns what this shop builds and
# how it builds it.
# Running it here is the same bargain the Stripe CLI gets: the commands and the
# agent that drives them arrive together, rather than the skill being a second
# curl nobody remembers.
#
# The published script is fetched and run rather than reimplemented, so what a
# box gets from the installer and what it gets from the one-liner stay the same
# thing. Warns rather than dies, and CLI_TOOLS_SKIP_SKILL=1 skips it.

SKILL_INSTALL_URL="${PROFULLSTACK_INSTALL_URL:-https://profullstack.com/install.sh}"

install_skill() {
	[ "${CLI_TOOLS_SKIP_SKILL:-0}" = "1" ] && return 0

	command -v curl >/dev/null 2>&1 || { say "  skipped: curl is required."; return 0; }

	tmp="$(mktemp)" || { say "  skipped: could not create a temp file."; return 0; }

	if ! curl -fsSL "$SKILL_INSTALL_URL" -o "$tmp" 2>/dev/null; then
		say "  skipped: could not reach $SKILL_INSTALL_URL."
		rm -f "$tmp"
		return 0
	fi

	# No arguments: which agents are on the box is that installer's business,
	# and it knows twelve of them. Naming one here would be this repo deciding
	# that a box running Gemini or opencode does not get the skill.
	sh "$tmp" || say "  skipped: $SKILL_INSTALL_URL failed."
	rm -f "$tmp"
}

say "Installing the Profullstack skill"
install_skill

# install-links.mjs already warns when $PREFIX is not on PATH, so there is
# deliberately no second warning here.
say ""
say "Installed. Try:"
say "  cli-tools list             # what landed, and what is on PATH"
say "  cli-tools aliases --install  # the moshcode pit aliases"
say "  stripe login               # authenticate the Stripe CLI"
say "  tea login add --name agentgit --url https://git.profullstack.com  # the forge"
say "  /profullstack              # the agent skill, inside Claude Code"
