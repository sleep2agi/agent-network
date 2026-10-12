#!/usr/bin/env bash
set -euo pipefail
# Run through sg docker. Inputs must be an offline backup and published tarballs,
# never the live database. No credentials or production directories are mounted.
if [ "$#" -ne 4 ]; then
  echo 'usage: bash run.sh <offline-before.db> <published-hub.tgz> <zod-4.6.5.tgz> <bun-1.4.0-executable>' >&2
  exit 2
fi
backup_input=$(realpath "$1")
hub_input=$(realpath "$2")
zod_input=$(realpath "$3")
bun_input=$(realpath "$4")
[[ "${backup_input##*/}" == before.db ]] || { echo 'requires an explicit offline before.db backup' >&2; exit 2; }
suite_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
docker build --network none -t anet-provider:hub-upgrade-preflight "$suite_dir"
docker run --rm --network none --read-only --memory 3g \
  --tmpfs /tmp:rw,nosuid,nodev,size=2g,mode=1777 \
  -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/bun-cache \
  -e "HUB_PREFLIGHT_VERSION=${HUB_PREFLIGHT_VERSION:-0.9.0-preview.126}" \
  -e "HUB_PREFLIGHT_INTEGRITY=${HUB_PREFLIGHT_INTEGRITY:-YT1x3vnqaVdMaETIoN/5OebLZEcWiqPB0QOKk6LO6n48x8RHVDKr4M5f6EMtHdwn0M5EPlaotZ/fzRvWLBn3Tw==}" \
  --mount "type=bind,src=$backup_input,dst=/input/before.db,readonly" \
  --mount "type=bind,src=$hub_input,dst=/input/hub.tgz,readonly" \
  --mount "type=bind,src=$zod_input,dst=/input/zod.tgz,readonly" \
  --mount "type=bind,src=$bun_input,dst=/runtime/bun,readonly" \
  anet-provider:hub-upgrade-preflight
