#!/usr/bin/env bash
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.14}"
BUN_LINUX_X64_SHA256="${BUN_LINUX_X64_SHA256:-951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f}"

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "unsupported Bun test-image architecture: $(uname -m)" >&2
  exit 1
fi

archive="$(mktemp /tmp/bun-linux-x64.XXXXXX.zip)"
trap 'rm -f -- "$archive"' EXIT

curl --fail --silent --show-error --location \
  --retry 3 --retry-delay 2 --retry-all-errors \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
  --output "$archive"
printf '%s  %s\n' "$BUN_LINUX_X64_SHA256" "$archive" | sha256sum --check --strict
unzip -j "$archive" 'bun-linux-x64/bun' -d /usr/local/bin
chmod 0755 /usr/local/bin/bun
ln -sf bun /usr/local/bin/bunx
test "$(bun --version)" = "$BUN_VERSION"
test "$(bunx --version)" = "$BUN_VERSION"
