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
# Commands this set ships but does not implement: published npm packages that
# bring their own binary. The list lives in src/companions.ts and is read from
# there rather than repeated here, so adding one is a single-file change.
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
	say "Installing npm companions (timer, billing)"
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

stripe_sha256() {
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
		got="$(stripe_sha256 "$tmp/$tarball" 2>/dev/null || true)"
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

# install-links.mjs already warns when $PREFIX is not on PATH, so there is
# deliberately no second warning here.
say ""
say "Installed. Try:"
say "  cli-tools list             # what landed, and what is on PATH"
say "  cli-tools aliases --install  # the moshcode pit aliases"
say "  stripe login               # authenticate the Stripe CLI"
