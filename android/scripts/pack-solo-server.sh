#!/usr/bin/env bash
# Packs the StalkerWeb server for the Solo app: backend/ without its tests and
# dev tools, with its production dependencies (all plain JavaScript), zipped to
# app/src/solo/assets/server.zip. Next to it, server.version names this exact
# server — a hash of what's in the zip — so the app unpacks it again only when
# it changed (ServerInstaller). Both are build outputs (gitignored). Run before
# Gradle builds a Solo variant.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
assets="$repo/android/app/src/solo/assets"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/backend"
tar -C "$repo/backend" \
  --exclude=./node_modules --exclude=./tests \
  --exclude=./eslint.config.js --exclude=./vitest.config.js \
  -cf - . | tar -C "$work/backend" -xf -

# The lockfile's versions exactly, nothing for development, and no install
# scripts (there are no native addons to build).
(cd "$work/backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

version="$(cd "$work" && find backend -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)"

mkdir -p "$assets"
rm -f "$assets/server.zip"
(cd "$work" && zip -qr -X "$assets/server.zip" backend)
printf '%s\n' "$version" > "$assets/server.version"
echo "server.zip $version ($(du -h "$assets/server.zip" | cut -f1)) in $assets"
