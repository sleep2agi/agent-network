#!/usr/bin/env bash
# Host/CI: build image + compose dual-container E2E (agent ≠ hub, no shared FS).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SOURCE_COMMIT="${SOURCE_COMMIT:-$(git rev-parse HEAD)}"
export SOURCE_COMMIT
echo "# test693 dual-container"
echo "SOURCE_COMMIT=$SOURCE_COMMIT"

docker build -t anet-test693:dev \
  --build-arg "SOURCE_COMMIT=$SOURCE_COMMIT" \
  -f tests/test693-agent-local-upload/Dockerfile .

docker compose -p "test693-${SOURCE_COMMIT:0:8}" \
  -f tests/test693-agent-local-upload/compose.yml \
  down -v --remove-orphans 2>/dev/null || true

set +e
docker compose -p "test693-${SOURCE_COMMIT:0:8}" \
  -f tests/test693-agent-local-upload/compose.yml \
  up --abort-on-container-exit --exit-code-from agent
rc=$?
set -e

docker compose -p "test693-${SOURCE_COMMIT:0:8}" \
  -f tests/test693-agent-local-upload/compose.yml \
  logs hub 2>&1 | tail -30 || true
docker compose -p "test693-${SOURCE_COMMIT:0:8}" \
  -f tests/test693-agent-local-upload/compose.yml \
  logs agent 2>&1 | tail -40 || true

docker compose -p "test693-${SOURCE_COMMIT:0:8}" \
  -f tests/test693-agent-local-upload/compose.yml \
  down -v --remove-orphans 2>/dev/null || true

if [ "$rc" -ne 0 ]; then
  echo "DUAL_CONTAINER_E2E_FAIL rc=$rc"
  exit "$rc"
fi
echo "DUAL_CONTAINER_E2E_PASS"
exit 0
