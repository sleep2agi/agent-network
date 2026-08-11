#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
BASE_COMMIT="${TEST698_BASE_COMMIT:-17b8223f9d7fd25fcc435b40e7fa1fc0823ea1de}"
CURRENT_IMAGE="${TEST698_CURRENT_IMAGE:?set TEST698_CURRENT_IMAGE to the exact-source test image}"
SOURCE_COMMIT="${TEST698_SOURCE_COMMIT:?set TEST698_SOURCE_COMMIT to the exact source commit}"
TMP=$(mktemp -d)
NET="test698-legacy-$RANDOM-$$"
HUB_CONTAINER="${NET}-hub"
OLD_IMAGE="anet-test698-legacy-hub:${BASE_COMMIT:0:8}"
MUTATED_IMAGE="anet-test698-legacy-route-mut:${SOURCE_COMMIT:0:8}"

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

echo "legacy-wire mutation: production cli loses exact-task identity lookup"
MUT_ROOT="$TMP/mutated-current"
mkdir -p "$MUT_ROOT"
git -C "$ROOT" archive "$SOURCE_COMMIT" | tar -x -C "$MUT_ROOT"
MUT_FILE="$MUT_ROOT/agent-node/src/cli.ts"
BEFORE=$(sha256sum "$MUT_FILE" | cut -d' ' -f1)
sed -i 's/callCommHub("get_task", { task_id: taskId })/callCommHub("get_all_status", {})/' "$MUT_FILE"
AFTER=$(sha256sum "$MUT_FILE" | cut -d' ' -f1)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "MUTATION_NOOP: old-hub-exact-task-lookup-lost"
  exit 1
fi
docker build -t "$MUTATED_IMAGE" \
  --build-arg SOURCE_COMMIT="$SOURCE_COMMIT-mut-old-hub-route" \
  -f "$MUT_ROOT/tests/test698-atomic-peer-reply/Dockerfile" "$MUT_ROOT" \
  >/tmp/test698-legacy-mutated-build.log
set +e
docker run --rm --network "$NET" --entrypoint bun "$MUTATED_IMAGE" \
  /workspace/tests/test698-atomic-peer-reply/legacy-wire-e2e.ts \
  "http://${HUB_CONTAINER}:9200" test698-legacy-auth \
  >/tmp/test698-legacy-mutated-run.log 2>&1
MUT_RC=$?
set -e
if [ "$MUT_RC" -eq 0 ]; then
  echo "MUTATION_SURVIVED: old-hub-exact-task-lookup-lost"
  cat /tmp/test698-legacy-mutated-run.log
  exit 1
fi
echo "MUTATION_RED: old-hub-exact-task-lookup-lost rc=$MUT_RC"
