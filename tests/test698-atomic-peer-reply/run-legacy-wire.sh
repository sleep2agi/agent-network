#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/tests/lib/safe-rm.sh"
BASE_COMMIT="${TEST698_BASE_COMMIT:-17b8223f9d7fd25fcc435b40e7fa1fc0823ea1de}"
CURRENT_IMAGE="${TEST698_CURRENT_IMAGE:?set TEST698_CURRENT_IMAGE to the exact-source test image}"
SOURCE_COMMIT="${TEST698_SOURCE_COMMIT:?set TEST698_SOURCE_COMMIT to the exact source commit}"
TMP=$(mktemp -d)
NET="test698-legacy-$RANDOM-$$"
HUB_CONTAINER="${NET}-hub"
OLD_IMAGE="anet-test698-legacy-hub:${BASE_COMMIT:0:8}"
DB_DIR="$TMP/oldhubdb"
mkdir -p "$DB_DIR"

cleanup() {
  docker rm -f "$HUB_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  safe_rm_rf "$TMP"
}
trap cleanup EXIT

git -C "$ROOT" archive "$BASE_COMMIT" | tar -x -C "$TMP"
# The legacy Hub Dockerfile was introduced after BASE_COMMIT. Extract its exact
# SOURCE_COMMIT bytes into the archived context instead of reading the worktree.
git -C "$ROOT" archive "$SOURCE_COMMIT" -- \
  tests/test698-atomic-peer-reply/Dockerfile.legacy-hub | tar -x -C "$TMP"
docker build -t "$OLD_IMAGE" \
  -f "$TMP/tests/test698-atomic-peer-reply/Dockerfile.legacy-hub" "$TMP" >/tmp/test698-legacy-build.log
docker network create "$NET" >/dev/null
docker run -d --name "$HUB_CONTAINER" --network "$NET" \
  -e COMMHUB_AUTH_TOKEN=test698-legacy-auth \
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

run_wire() {
  local image="$1" log="$2"
  docker run --rm --network "$NET" --entrypoint bun "$image" \
    /workspace/tests/test698-atomic-peer-reply/legacy-wire-e2e.ts \
    "http://${HUB_CONTAINER}:9200" test698-legacy-auth >"$log" 2>&1
  docker run --rm --network "$NET" --entrypoint bun "$image" \
    /workspace/tests/test698-atomic-peer-reply/legacy-cli-failure-e2e.ts \
    "http://${HUB_CONTAINER}:9200" test698-legacy-auth >>"$log" 2>&1
}

run_wire "$CURRENT_IMAGE" /tmp/test698-legacy-pristine.log
grep -Fq 'LEGACY_HUB_WIRE_PASS' /tmp/test698-legacy-pristine.log
grep -Fq 'LEGACY_CLI_TERMINAL_PASS originals=2 terminal=2 replies=2 child_tasks=0' /tmp/test698-legacy-pristine.log
echo "LEGACY_PRISTINE_PASS"

run_legacy_mutation() {
  local name="$1" file="$2" sed_expr="$3"
  local root="$TMP/mut-$name" image="anet-test698-legacy-mut:${SOURCE_COMMIT:0:8}-$name"
  mkdir -p "$root"
  git -C "$ROOT" archive "$SOURCE_COMMIT" | tar -x -C "$root"
  local target="$root/$file" before after rc
  before=$(sha256sum "$target" | cut -d' ' -f1)
  sed -i "$sed_expr" "$target"
  after=$(sha256sum "$target" | cut -d' ' -f1)
  if [ "$before" = "$after" ]; then
    echo "MUTATION_NOOP: $name"
    exit 1
  fi
  docker build -t "$image" --build-arg SOURCE_COMMIT="$SOURCE_COMMIT-mut-$name" \
    -f "$root/tests/test698-atomic-peer-reply/Dockerfile" "$root" >/tmp/test698-legacy-mut-build.log
  set +e
  run_wire "$image" "/tmp/test698-legacy-mut-$name.log"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_SURVIVED: $name"
    cat "/tmp/test698-legacy-mut-$name.log"
    exit 1
  fi
  echo "MUTATION_RED: $name rc=$rc"
}

# Deterministic final-state witnesses: pristine always observes two terminal
# originals and zero child tasks. These mutations cannot pass on a transient
# pending-reply state because the probe only accepts committed Hub rows.
run_legacy_mutation "old-hub-terminal-fallback-skipped" \
  agent-node/src/peer-reply-send.ts \
  's/payload: await deps.sendLegacyReply(args)/payload: { ok: true, silently_dropped: true }/'
run_legacy_mutation "old-hub-capability-fallback-removed" \
  agent-node/src/peer-reply-send.ts \
  's/if (!isPeerReplyCapabilityUnavailable(error)) throw error;/if (true) throw error;/'

echo "LEGACY_WIRE_RESULT: PASS"
