#!/usr/bin/env bash
# Fetches Node for the Solo app: nodejs-mobile's libnode.so for each ABI Solo
# ships, and the headers the native bridge (app/src/solo/cpp) builds against.
# They land in android/app/libnode/ (gitignored). The download is checked
# against a pinned SHA-256, so a changed or tampered release fails the build
# instead of ending up in the app. Run before Gradle builds a Solo variant;
# a second run with the same version does nothing.
set -euo pipefail

VERSION="v18.20.4"
URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/nodejs-mobile-${VERSION}-android.zip"
SHA256="bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af"
ABIS=("arm64-v8a" "armeabi-v7a")

out="$(cd "$(dirname "$0")/.." && pwd)/app/libnode"
marker="$out/.version"

if [ -f "$marker" ] && [ "$(cat "$marker")" = "$VERSION" ]; then
  echo "libnode $VERSION already in $out"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading nodejs-mobile $VERSION"
curl -fsSL --retry 3 -o "$work/node.zip" "$URL"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/node.zip" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$work/node.zip" | cut -d' ' -f1)"
fi
if [ "$actual" != "$SHA256" ]; then
  echo "nodejs-mobile $VERSION: SHA-256 is $actual, expected $SHA256 — not using it" >&2
  exit 1
fi

unzip -q "$work/node.zip" -d "$work/x"
rm -rf "$out"
mkdir -p "$out/jniLibs"
for abi in "${ABIS[@]}"; do
  mkdir -p "$out/jniLibs/$abi"
  cp "$work/x/bin/$abi/libnode.so" "$out/jniLibs/$abi/"
done
cp -R "$work/x/include" "$out/include"
echo "$VERSION" > "$marker"
echo "libnode $VERSION ready in $out (${ABIS[*]})"
