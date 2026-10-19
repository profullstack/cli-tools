#!/bin/sh
# Installs root-w3bs-os, the W3BS OS box setup and maintenance script (users, ssh, Caddy,
# firewall, confinement), as the package profullstack.com/root-w3bs-os on w3bs.org/packages:
#
#   w3bs install profullstack.com/root-w3bs-os     # or: w3bs os setup
#
# The script is fetched from this release's git tag and must match the sha256 below, so
# the signed release installs exactly what was reviewed. Re-run to update.
set -eu
VERSION=0.1.0
SHA256=de06d5cf0fd62d8f9a9d867a1e2a4eb753601ad7eaa2600a5ad7cf8788e54a76
URL="https://raw.githubusercontent.com/profullstack/cli-tools/root-w3bs-os-v$VERSION/root-w3bs-os.sh"
fail() { printf 'root-w3bs-os: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail 'curl is required'
if [ "$(id -u)" = 0 ]; then bin=/usr/local/sbin; else bin=${HOME:?HOME must be set}/.local/bin; fi
mkdir -p "$bin"
tmp=$(mktemp "$bin/.root-w3bs-os.XXXXXX")
trap 'rm -f "$tmp"' EXIT INT TERM
curl -fsSL "$URL" -o "$tmp" || fail "could not download $URL"
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp" | cut -d' ' -f1)
else got=$(shasum -a 256 "$tmp" | cut -d' ' -f1); fi
[ "$got" = "$SHA256" ] || fail "downloaded script does not match this installer (got $got)"
chmod 0755 "$tmp" && mv "$tmp" "$bin/root-w3bs-os"
trap - EXIT INT TERM
printf 'root-w3bs-os %s installed in %s\n' "$VERSION" "$bin"
printf 'Run it as root: doas %s/root-w3bs-os anthony --groups wheel   (or: w3bs os setup)\n' "$bin"
