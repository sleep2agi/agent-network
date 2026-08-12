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
DEDUP_MUTATED_IMAGE="anet-test698-legacy-dedup-mut:${SOURCE_COMMIT:0:8}"
IDENTITY_MUTATED_IMAGE="anet-test698-legacy-identity-mut:${SOURCE_COMMIT:0:8}"
MAX_CAP_MUTATED_IMAGE="anet-test698-legacy-max-cap-mut:${SOURCE_COMMIT:0:8}"
DUP_RETRY_MUTATED_IMAGE="anet-test698-legacy-dup-retry-mut:${SOURCE_COMMIT:0:8}"
DB_DIR="$TMP/oldhubdb"
mkdir -p "$DB_DIR"

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
  -e COMMHUB_AUTH_TOKEN=test698-legacy-auth \
  -e COMMHUB_SEND_DEDUP_WINDOW_MS=5000 \
  -e COMMHUB_DB=/test698-oldhubdb/hub.db \
  -v "$DB_DIR:/test698-oldhubdb" "$OLD_IMAGE" >/dev/null

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
docker run --rm --network "$NET" --entrypoint bun \
  -v "$DB_DIR:/test698-oldhubdb" "$CURRENT_IMAGE" \
  /workspace/tests/test698-atomic-peer-reply/legacy-cli-failure-e2e.ts \
  "http://${HUB_CONTAINER}:9200" test698-legacy-auth /test698-oldhubdb/hub.db

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

echo "legacy-wire mutation: stable peer identity marker removed"
DEDUP_MUT_ROOT="$TMP/mutated-dedup"
mkdir -p "$DEDUP_MUT_ROOT"
git -C "$ROOT" archive "$SOURCE_COMMIT" | tar -x -C "$DEDUP_MUT_ROOT"
DEDUP_MUT_FILE="$DEDUP_MUT_ROOT/agent-node/src/cli.ts"
BEFORE=$(sha256sum "$DEDUP_MUT_FILE" | cut -d' ' -f1)
sed -i 's/const taskText = legacyPeerReplyTaskText(args);/const taskText = args.failed ? `⚠️ ${args.text}` : args.text;/' "$DEDUP_MUT_FILE"
AFTER=$(sha256sum "$DEDUP_MUT_FILE" | cut -d' ' -f1)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "MUTATION_NOOP: legacy-equal-replies-deduplicated"
  exit 1
fi
docker build -t "$DEDUP_MUTATED_IMAGE" \
  --build-arg SOURCE_COMMIT="$SOURCE_COMMIT-mut-legacy-dedup" \
  -f "$DEDUP_MUT_ROOT/tests/test698-atomic-peer-reply/Dockerfile" "$DEDUP_MUT_ROOT" \
  >/tmp/test698-legacy-dedup-mutated-build.log
set +e
docker run --rm --network "$NET" --entrypoint bun \
  -v "$DB_DIR:/test698-oldhubdb" "$DEDUP_MUTATED_IMAGE" \
  /workspace/tests/test698-atomic-peer-reply/legacy-cli-failure-e2e.ts \
  "http://${HUB_CONTAINER}:9200" test698-legacy-auth /test698-oldhubdb/hub.db \
  >/tmp/test698-legacy-dedup-mutated-run.log 2>&1
DEDUP_MUT_RC=$?
set -e
if [ "$DEDUP_MUT_RC" -eq 0 ]; then
  echo "MUTATION_SURVIVED: legacy-equal-replies-deduplicated"
  cat /tmp/test698-legacy-dedup-mutated-run.log
  exit 1
fi
echo "MUTATION_RED: legacy-equal-replies-deduplicated rc=$DEDUP_MUT_RC"

echo "legacy-wire mutation: old-Hub task-identity failure guesses node route"
IDENTITY_MUT_ROOT="$TMP/mutated-identity"
mkdir -p "$IDENTITY_MUT_ROOT"
git -C "$ROOT" archive "$SOURCE_COMMIT" | tar -x -C "$IDENTITY_MUT_ROOT"
IDENTITY_MUT_FILE="$IDENTITY_MUT_ROOT/agent-node/src/cli.ts"
BEFORE=$(sha256sum "$IDENTITY_MUT_FILE" | cut -d' ' -f1)
sed -i '/isOldHubOriginNode:/,/      ),/ s/      ),/      ).catch(() => true),/' "$IDENTITY_MUT_FILE"
AFTER=$(sha256sum "$IDENTITY_MUT_FILE" | cut -d' ' -f1)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "MUTATION_NOOP: old-hub-identity-failure-egresses"
  exit 1
fi
docker build -t "$IDENTITY_MUTATED_IMAGE" \
  --build-arg SOURCE_COMMIT="$SOURCE_COMMIT-mut-old-hub-identity" \
  -f "$IDENTITY_MUT_ROOT/tests/test698-atomic-peer-reply/Dockerfile" "$IDENTITY_MUT_ROOT" \
  >/tmp/test698-legacy-identity-mutated-build.log
set +e
docker run --rm --network "$NET" --entrypoint bun \
  -v "$DB_DIR:/test698-oldhubdb" "$IDENTITY_MUTATED_IMAGE" \
  /workspace/tests/test698-atomic-peer-reply/legacy-cli-failure-e2e.ts \
  "http://${HUB_CONTAINER}:9200" test698-legacy-auth /test698-oldhubdb/hub.db \
  >/tmp/test698-legacy-identity-mutated-run.log 2>&1
IDENTITY_MUT_RC=$?
set -e
if [ "$IDENTITY_MUT_RC" -eq 0 ]; then
  echo "MUTATION_SURVIVED: old-hub-identity-failure-egresses"
  cat /tmp/test698-legacy-identity-mutated-run.log
  exit 1
fi
echo "MUTATION_RED: old-hub-identity-failure-egresses rc=$IDENTITY_MUT_RC"

echo "legacy-wire mutation: full-length reply exceeds old-Hub send_task cap"
MAX_CAP_MUT_ROOT="$TMP/mutated-max-cap"
mkdir -p "$MAX_CAP_MUT_ROOT"
git -C "$ROOT" archive "$SOURCE_COMMIT" | tar -x -C "$MAX_CAP_MUT_ROOT"
MAX_CAP_MUT_FILE="$MAX_CAP_MUT_ROOT/agent-node/src/peer-reply-send.ts"
BEFORE=$(sha256sum "$MAX_CAP_MUT_FILE" | cut -d' ' -f1)
sed -i 's/if (body.length + marker.length <= LEGACY_SEND_TASK_MAX_CHARS)/if (true)/' "$MAX_CAP_MUT_FILE"
AFTER=$(sha256sum "$MAX_CAP_MUT_FILE" | cut -d' ' -f1)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "MUTATION_NOOP: legacy-full-length-crosses-schema-cap"
  exit 1
fi
docker build -t "$MAX_CAP_MUTATED_IMAGE" \
  --build-arg SOURCE_COMMIT="$SOURCE_COMMIT-mut-legacy-max-cap" \
  -f "$MAX_CAP_MUT_ROOT/tests/test698-atomic-peer-reply/Dockerfile" "$MAX_CAP_MUT_ROOT" \
  >/tmp/test698-legacy-max-cap-mutated-build.log
set +e
docker run --rm --network "$NET" --entrypoint bun \
  -v "$DB_DIR:/test698-oldhubdb" "$MAX_CAP_MUTATED_IMAGE" \
  /workspace/tests/test698-atomic-peer-reply/legacy-cli-failure-e2e.ts \
  "http://${HUB_CONTAINER}:9200" test698-legacy-auth /test698-oldhubdb/hub.db \
  >/tmp/test698-legacy-max-cap-mutated-run.log 2>&1
MAX_CAP_MUT_RC=$?
set -e
if [ "$MAX_CAP_MUT_RC" -eq 0 ]; then
  echo "MUTATION_SURVIVED: legacy-full-length-crosses-schema-cap"
  cat /tmp/test698-legacy-max-cap-mutated-run.log
  exit 1
fi
echo "MUTATION_RED: legacy-full-length-crosses-schema-cap rc=$MAX_CAP_MUT_RC"

echo "legacy-wire mutation: duplicate_send clears the pending full-length reply"
DUP_RETRY_MUT_ROOT="$TMP/mutated-dup-retry"
mkdir -p "$DUP_RETRY_MUT_ROOT"
git -C "$ROOT" archive "$SOURCE_COMMIT" | tar -x -C "$DUP_RETRY_MUT_ROOT"
DUP_RETRY_MUT_FILE="$DUP_RETRY_MUT_ROOT/agent-node/src/peer-reply-send.ts"
BEFORE=$(sha256sum "$DUP_RETRY_MUT_FILE" | cut -d' ' -f1)
sed -i 's/legacyError.code === "duplicate_send"/legacyError.code === "duplicate_send_disabled"/' "$DUP_RETRY_MUT_FILE"
AFTER=$(sha256sum "$DUP_RETRY_MUT_FILE" | cut -d' ' -f1)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "MUTATION_NOOP: legacy-duplicate-send-drops-pending"
  exit 1
fi
docker build -t "$DUP_RETRY_MUTATED_IMAGE" \
  --build-arg SOURCE_COMMIT="$SOURCE_COMMIT-mut-legacy-dup-retry" \
  -f "$DUP_RETRY_MUT_ROOT/tests/test698-atomic-peer-reply/Dockerfile" "$DUP_RETRY_MUT_ROOT" \
  >/tmp/test698-legacy-dup-retry-mutated-build.log
set +e
docker run --rm --network "$NET" --entrypoint bun \
  -v "$DB_DIR:/test698-oldhubdb" "$DUP_RETRY_MUTATED_IMAGE" \
  /workspace/tests/test698-atomic-peer-reply/legacy-cli-failure-e2e.ts \
  "http://${HUB_CONTAINER}:9200" test698-legacy-auth /test698-oldhubdb/hub.db \
  >/tmp/test698-legacy-dup-retry-mutated-run.log 2>&1
DUP_RETRY_MUT_RC=$?
set -e
if [ "$DUP_RETRY_MUT_RC" -eq 0 ]; then
  echo "MUTATION_SURVIVED: legacy-duplicate-send-drops-pending"
  cat /tmp/test698-legacy-dup-retry-mutated-run.log
  exit 1
fi
echo "MUTATION_RED: legacy-duplicate-send-drops-pending rc=$DUP_RETRY_MUT_RC"
