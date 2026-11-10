#!/bin/sh
set -eu
docker build --network none -t anet-shared-variant-final:local -f tests/test-shared-variant/Dockerfile .
exec docker run --rm --init --network none --user 0 \
  -e HOME=/work/test-home -e XDG_CONFIG_HOME=/work/test-config \
  -e XDG_DATA_HOME=/work/test-data -e XDG_CACHE_HOME=/work/test-cache -e XDG_STATE_HOME=/work/test-state \
  --mount type=bind,src=/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode,dst=/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode,readonly \
  anet-shared-variant-final:local "$@"
