#!/usr/bin/env bash
# Packs the StalkerWeb server for the Solo app: backend/'s tracked files,
# without its tests and dev tools, with its production dependencies (all plain JavaScript), zipped to
# app/src/solo/assets/server.zip. Next to it, server.version names this exact
# server — a hash of what's in the zip — so the app unpacks it again only when
# it changed (ServerInstaller). Both are build outputs (gitignored). Run before
# Gradle builds a Solo variant.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
assets="$repo/android/app/src/solo/assets"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Only the files git tracks (as they are in the working tree): never a stray
# .env, local data or anything else lying about in backend/.
git -C "$repo" ls-files -z -- backend \
  | grep -zv -e '^backend/node_modules/' -e '^backend/tests/' \
      -e '^backend/eslint\.config\.js$' -e '^backend/vitest\.config\.js$' \
  | tar -C "$repo" --null -T - -cf - | tar -C "$work" -xf -

# The lockfile's versions exactly, nothing for development, and no install
# scripts (there are no native addons to build).
(cd "$work/backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

version="$(cd "$work" && find backend -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)"

mkdir -p "$assets"
rm -f "$assets/server.zip"
(cd "$work" && zip -qr -X "$assets/server.zip" backend)
printf '%s\n' "$version" > "$assets/server.version"
echo "server.zip $version ($(du -h "$assets/server.zip" | cut -f1)) in $assets"
