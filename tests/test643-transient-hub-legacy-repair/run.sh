#!/usr/bin/env bash
set -euo pipefail

source /workspace/tests/lib/safe-rm.sh

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test643-transient-hub-legacy-repair.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test643 — transient --hub survives legacy node_id repair"
echo "source_commit=${TEST643_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

echo "L0 typecheck agent-network"
(cd /workspace/agent-network && bun run typecheck)

DB_PATH=$(mktemp /tmp/test643-db.XXXXXX.sqlite)
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; fi
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
}
trap cleanup EXIT

BASE=http://127.0.0.1:9643
STALE_HUB=http://127.0.0.1:1
ANET=(bun run /workspace/agent-network/bin/cli.ts)

echo "L1 start real Hub with fresh SQLite"
(
  cd /workspace/server
  PORT=9643 HOST=127.0.0.1 COMMHUB_DB="$DB_PATH" COMMHUB_AUTH_TOKEN=test643-auth \
    bun run src/index.ts
) >/tmp/test643-hub.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 80); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$BASE/health" >/dev/null

run_case() {
  local suffix=$1
  local expected_failure=${2:-0}
  local home_dir project_dir fake_bin node_cfg start_log spawn_log
  home_dir=$(mktemp -d "/tmp/test643-home-${suffix}.XXXXXX")
  project_dir=$(mktemp -d "/tmp/test643-project-${suffix}.XXXXXX")
  fake_bin=$(mktemp -d "/tmp/test643-bin-${suffix}.XXXXXX")
  start_log="/tmp/test643-start-${suffix}.log"
  spawn_log="/tmp/test643-spawn-${suffix}.log"

  HOME="$home_dir" "${ANET[@]}" register --hub "$BASE" --token test643-auth \
    --username "legacy643-${suffix}" --password 'Legacy643!' >/tmp/test643-register.log 2>&1
  (
    cd "$project_dir"
    HOME="$home_dir" "${ANET[@]}" node create "legacy-${suffix}" --runtime codex-sdk \
      >/tmp/test643-create.log 2>&1
  )
  node_cfg=$(find "$project_dir/.anet/nodes" -name config.json -type f -print -quit)
  [[ -n "$node_cfg" ]]
  jq --arg hub "$STALE_HUB" 'del(.node_id) | .hub=$hub' "$node_cfg" > /tmp/test643-node-config.json
  mv /tmp/test643-node-config.json "$node_cfg"
  chmod 0600 "$node_cfg"

  cat > "$fake_bin/npx" <<SH
#!/usr/bin/env bash
printf 'COMMHUB_URL=%s\n' "\${COMMHUB_URL:-}" > "$spawn_log"
exit 0
SH
  chmod 0755 "$fake_bin/npx"

  (
    cd "$project_dir"
    PATH="$fake_bin:$PATH" HOME="$home_dir" \
      "${ANET[@]}" node start "legacy-${suffix}" --hub "$BASE"
  ) >"$start_log" 2>&1
  cat "$start_log"

  grep -Fxq "COMMHUB_URL=$BASE" "$spawn_log" || {
    echo "FAIL_START_DID_NOT_USE_OVERRIDE"
    return 1
  }
  jq -e --arg hub "$STALE_HUB" '.hub == $hub and (.node_id | type == "string" and length > 0)' \
    "$node_cfg" >/dev/null || {
      echo "FAIL_TRANSIENT_HUB_WAS_PERSISTED"
      jq '{hub,node_id}' "$node_cfg"
      return 1
    }
  grep -Fq 'persisted canonical node_id' "$start_log"

  safe_rm_rf "$home_dir" "$project_dir" "$fake_bin"
  if [[ "$expected_failure" == 1 ]]; then
    echo "MUTATION_FALSE_GREEN: persisted-profile-separation"
    return 1
  fi
}

echo "L2 legacy repair persists node_id but not the transient Hub"
run_case green

echo "L3 witnessed-red: repair writes the launch-time override"
CLI=/workspace/agent-network/bin/cli.ts
cp "$CLI" /tmp/test643-cli.original.ts
sed -i 's/saveProfile(nodeId, persistedProfile);/saveProfile(nodeId, profile);/' "$CLI"
grep -Fq 'saveProfile(nodeId, profile);' "$CLI"
set +e
run_case mutation 1 >/tmp/test643-mutation.log 2>&1
mutation_rc=$?
set -e
cat /tmp/test643-mutation.log
[[ "$mutation_rc" -ne 0 ]] || { echo "MUTATION_FALSE_GREEN: persisted-profile-separation"; exit 1; }
grep -Fq 'FAIL_TRANSIENT_HUB_WAS_PERSISTED' /tmp/test643-mutation.log || {
  echo "MUTATION_WRONG_RED: persisted-profile-separation"
  exit 1
}
echo "MUTATION_RED: persisted-profile-separation rc=$mutation_rc"
cp /tmp/test643-cli.original.ts "$CLI"
cmp -s "$CLI" /tmp/test643-cli.original.ts

echo "L4 restored green"
run_case restored

echo "RESULT: PASS"
