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

# install-links.mjs already warns when $PREFIX is not on PATH, so there is
# deliberately no second warning here.
say ""
say "Installed. Try:"
say "  cli-tools list             # what landed, and what is on PATH"
say "  cli-tools aliases --install  # the moshcode pit aliases"
