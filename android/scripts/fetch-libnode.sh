#!/usr/bin/env bash
# Fetches Node for the Solo app: nodejs-mobile's libnode.so for each ABI Solo
# ships, and the headers the native bridge (app/src/solo/cpp) builds against.
# They land in android/app/libnode/ (gitignored). The download is checked
# against a pinned SHA-256, so a changed or tampered release fails the build
# instead of ending up in the app. Run before Gradle builds a Solo variant.
#
# The zip is kept in LIBNODE_CACHE (default android/app/libnode-cache/, also
# gitignored; CI caches it by version and SHA-256) and checked against the pin
# on every run, not trusted for being there. A second run with the same
# version re-checks the unpacked libraries against the hashes recorded when
# they were unpacked, and unpacks them again if anything differs.
set -euo pipefail

VERSION="v18.20.4"
URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/nodejs-mobile-${VERSION}-android.zip"
SHA256="bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af"
ABIS=("arm64-v8a" "armeabi-v7a")

app="$(cd "$(dirname "$0")/.." && pwd)/app"
out="$app/libnode"
cache="${LIBNODE_CACHE:-$app/libnode-cache}"
zip="$cache/nodejs-mobile-${VERSION}-android.zip"
marker="$out/.version"   # the version and pin, then "<sha256>  <lib>" for each library unpacked

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# What the marker should say about the libraries as they are now.
state() {
  echo "$VERSION $SHA256"
  for abi in "${ABIS[@]}"; do
    f="$out/jniLibs/$abi/libnode.so"
    [ -f "$f" ] || return 1
    echo "$(sha "$f")  $abi/libnode.so"
  done
}

if [ -f "$marker" ] && [ -d "$out/include" ] && now="$(state)" && [ "$now" = "$(cat "$marker")" ]; then
  echo "libnode $VERSION already in $out (checked)"
  exit 0
fi

mkdir -p "$cache"
if [ -f "$zip" ] && [ "$(sha "$zip")" != "$SHA256" ]; then
  echo "cached nodejs-mobile $VERSION doesn't match its SHA-256 — fetching it again" >&2
  rm -f "$zip"
fi
if [ ! -f "$zip" ]; then
  echo "Downloading nodejs-mobile $VERSION"
  curl -fsSL --retry 3 -o "$zip.tmp" "$URL"
  mv "$zip.tmp" "$zip"
fi
actual="$(sha "$zip")"
if [ "$actual" != "$SHA256" ]; then
  rm -f "$zip"
  echo "nodejs-mobile $VERSION: SHA-256 is $actual, expected $SHA256 — not using it" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q "$zip" -d "$work/x"
rm -rf "$out"
mkdir -p "$out/jniLibs"
for abi in "${ABIS[@]}"; do
  mkdir -p "$out/jniLibs/$abi"
  cp "$work/x/bin/$abi/libnode.so" "$out/jniLibs/$abi/"
done
cp -R "$work/x/include" "$out/include"
state > "$marker"
echo "libnode $VERSION ready in $out (${ABIS[*]})"
