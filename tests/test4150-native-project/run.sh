#!/bin/sh
set -eu
if [ "${TEST4150_NATIVE_ATTACH_DERIVED:-}" = "1" ] && [ "${TEST4150_NATIVE_ATTACH:-}" != "1" ]; then
  echo 'derived mode requires explicit TEST4150_NATIVE_ATTACH=1; refusing other native lanes' >&2
  exit 2
fi
# Run via sg docker; invoke in the harness background (no sleep/poll loop).
docker build --network none -t anet-4150-native-project:local -f tests/test4150-native-project/Dockerfile .
exec docker run --rm --init --network none --user 0 \
  -e TEST4150_NATIVE_FORK \
  -e TEST4150_NATIVE_ATTACH \
  -e TEST4150_NATIVE_ATTACH_DERIVED \
  -e HOME=/tmp/native-acceptance-home -e XDG_CONFIG_HOME=/tmp/native-config \
  -e XDG_CACHE_HOME=/tmp/native-cache -e XDG_DATA_HOME=/tmp/native-data -e XDG_STATE_HOME=/tmp/native-state \
  -v /tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode:/native/opencode:ro \
  anet-4150-native-project:local
