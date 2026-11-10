#!/bin/sh
set -eu
docker build --network none -t anet-shared-fork-final:local -f tests/test-shared-fork/Dockerfile .
exec docker run --rm --init --network none --user 0 \
  -e HOME=/state/test-home -e XDG_CONFIG_HOME=/state/test-config -e XDG_DATA_HOME=/state/test-data -e XDG_CACHE_HOME=/state/test-cache -e XDG_STATE_HOME=/state/test-state \
  --mount type=bind,src=/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode,dst=/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode,readonly \
  anet-shared-fork-final:local "$@"
