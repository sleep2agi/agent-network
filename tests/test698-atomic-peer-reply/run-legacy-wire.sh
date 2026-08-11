#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
BASE_COMMIT="${TEST698_BASE_COMMIT:-17b8223f9d7fd25fcc435b40e7fa1fc0823ea1de}"
CURRENT_IMAGE="${TEST698_CURRENT_IMAGE:?set TEST698_CURRENT_IMAGE to the exact-source test image}"
TMP=$(mktemp -d)
NET="test698-legacy-$RANDOM-$$"
HUB_CONTAINER="${NET}-hub"
OLD_IMAGE="anet-test698-legacy-hub:${BASE_COMMIT:0:8}"

cleanup() {
  docker rm -f "$HUB_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf -- "$TMP"
}
trap cleanup EXIT

git -C "$ROOT" archive "$BASE_COMMIT" | tar -x -C "$TMP"
docker build -t "$OLD_IMAGE" \
  -f "$ROOT/tests/test698-atomic-peer-reply/Dockerfile.legacy-hub" "$TMP" >/tmp/test698-legacy-build.log
docker network create "$NET" >/dev/null
docker run -d --name "$HUB_CONTAINER" --network "$NET" \
  -e COMMHUB_AUTH_TOKEN=test698-legacy-auth "$OLD_IMAGE" >/dev/null

for _ in $(seq 1 80); do
  if docker exec "$HUB_CONTAINER" bun -e \
    "fetch('http://127.0.0.1:9200/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 0.25
done
docker exec "$HUB_CONTAINER" bun -e \
  "fetch('http://127.0.0.1:9200/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

docker run --rm --network "$NET" --entrypoint bun "$CURRENT_IMAGE" \
  /workspace/tests/test698-atomic-peer-reply/legacy-wire-e2e.ts \
  "http://${HUB_CONTAINER}:9200" test698-legacy-auth
