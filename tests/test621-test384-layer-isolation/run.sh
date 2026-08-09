#!/usr/bin/env bash
set -Eeuo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test621-test384-layer-isolation.txt"
HUB=http://127.0.0.1:9621
DB=/tmp/test621.db
HUB_PID=""
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"
exec > >(tee -a "$REPORT") 2>&1

cleanup() {
  if [[ -n "$HUB_PID" ]] && kill -0 "$HUB_PID" 2>/dev/null; then
    kill -TERM "$HUB_PID" 2>/dev/null || true
    wait "$HUB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mcp_call() {
  local token="$1" tool_name="$2" tool_args="$3"
  local body
  body=$(jq -nc --arg name "$tool_name" --argjson args "$tool_args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$name,arguments:$args}}')
  curl -fsS -X POST "$HUB/mcp" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    --data "$body" \
    | sed -n 's/^data: //p' | head -1 \
    | jq -r '.result.content[0].text // empty'
}

assert_script_boundary() {
  local script=$1
  local start_line capture_line stop_line cancel_line end_line
  start_line=$(grep -n '^start_fake_node hang ' "$script" | cut -d: -f1) \
    || { echo 'missing start_fake_node hang'; return 1; }
  capture_line=$(grep -n '^HOLD_OPEN_TASK_ID="\$TASK_ID"$' "$script" | cut -d: -f1) \
    || { echo 'missing HOLD_OPEN_TASK_ID capture'; return 1; }
  stop_line=$(tail -n "+$start_line" "$script" | grep -n '^stop_node$' | head -1 | cut -d: -f1) \
    || { echo 'missing exact stop_node after hold-open start'; return 1; }
  stop_line=$((start_line + stop_line - 1))
  cancel_line=$(grep -n '^cancel_layer_task "\$HOLD_OPEN_TASK_ID"$' "$script" | cut -d: -f1) \
    || { echo 'missing cancel_layer_task boundary'; return 1; }
  end_line=$(tail -n "+$start_line" "$script" | grep -n '^CURRENT_LAYER="L5.5 ' | head -1 | cut -d: -f1) \
    || { echo 'missing L5.5 boundary'; return 1; }
  end_line=$((start_line + end_line - 1))
  [[ "$start_line" -lt "$capture_line" \
    && "$capture_line" -lt "$stop_line" \
    && "$stop_line" -lt "$cancel_line" \
    && "$cancel_line" -lt "$end_line" ]] \
    || { echo 'hold-open teardown ordering regressed'; return 1; }
  grep -Fq 'all(.messages[]?; .id != $id)' "$script" \
    || { echo 'missing cancelled-inbox absence assertion'; return 1; }
}

echo "# test621 — test384 hold-open layer isolation"
echo "source_commit=${TEST621_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

echo "L0 syntax + orchestration contract"
bash -n tests/test384-opencode-local-package-e2e/run.sh
assert_script_boundary tests/test384-opencode-local-package-e2e/run.sh

echo "L1 real Hub cancellation removes the unacked row before restart"
COMMHUB_DB="$DB" HOST=127.0.0.1 PORT=9621 \
  bun run server/bin/commhub.ts --port 9621 --host 127.0.0.1 --db "$DB" \
  >/tmp/test621-hub.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 100); do
  curl -fsS "$HUB/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "$HUB/health" | jq -e '.ok == true' >/dev/null

REGISTER=$(curl -fsS -X POST "$HUB/api/auth/register" \
  -H 'Content-Type: application/json' \
  --data '{"username":"test621","password":"Test621-Strong-Password!"}')
TOKEN=$(jq -r '.token' <<<"$REGISTER")
NODE_TOKEN=$(jq -r '.network_token' <<<"$REGISTER")
NETWORK=$(jq -r '.network_id' <<<"$REGISTER")
[[ "$TOKEN" == utok_* && "$NODE_TOKEN" == ntok_* && "$NETWORK" == net_* ]]

STATUS=$(mcp_call "$NODE_TOKEN" report_status "$(jq -nc --arg net "$NETWORK" \
  '{resume_id:"test621-resume",alias:"test621",status:"idle",network_id:$net}')")
jq -e '.ok == true' <<<"$STATUS" >/dev/null

DISPATCH=$(curl -fsS -X POST "$HUB/api/task" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg net "$NETWORK" \
    '{alias:"test621",task:"hold-open",priority:"normal",network_id:$net}')")
TASK_ID=$(jq -r '.task_id // .message_id // empty' <<<"$DISPATCH")
[[ -n "$TASK_ID" ]]

BEFORE=$(mcp_call "$NODE_TOKEN" get_inbox '{"alias":"test621","limit":100}')
jq -e --arg id "$TASK_ID" 'any(.messages[]?; .id == $id)' <<<"$BEFORE" >/dev/null

CANCEL=$(mcp_call "$TOKEN" cancel_task "$(jq -nc --arg id "$TASK_ID" --arg net "$NETWORK" \
  '{task_id:$id,reason:"test621 layer teardown",from_session:"test621",network_id:$net}')")
jq -e '.ok == true and .cancelled == true' <<<"$CANCEL" >/dev/null

AFTER=$(mcp_call "$NODE_TOKEN" get_inbox '{"alias":"test621","limit":100}')
jq -e --arg id "$TASK_ID" 'all(.messages[]?; .id != $id)' <<<"$AFTER" >/dev/null
curl -fsS "$HUB/api/tasks?task_id=$TASK_ID&network_id=$NETWORK" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -e '.tasks[0].status == "cancelled"' >/dev/null

# A second pull models the fresh process reconnect. The row remains absent;
# cancel_task closed both the task lifecycle and its inbox delivery.
RESTART_PULL=$(mcp_call "$NODE_TOKEN" get_inbox '{"alias":"test621","limit":100}')
jq -e --arg id "$TASK_ID" 'all(.messages[]?; .id != $id)' <<<"$RESTART_PULL" >/dev/null

echo "L2 witnessed-red: deleting the layer cancellation must fail"
cp tests/test384-opencode-local-package-e2e/run.sh /tmp/test621-mutated.sh
sed -i '/^cancel_layer_task "\$HOLD_OPEN_TASK_ID"$/d' /tmp/test621-mutated.sh
if grep -Fq 'cancel_layer_task "$HOLD_OPEN_TASK_ID"' /tmp/test621-mutated.sh; then
  echo "MUTATION_NOT_APPLIED"
  exit 1
fi
set +e
assert_script_boundary /tmp/test621-mutated.sh >/tmp/test621-mutated.log 2>&1
MUTATION_RC=$?
set -e
if [[ "$MUTATION_RC" -eq 0 ]]; then
  echo "MUTATION_FALSE_GREEN: hold-open-layer-cancel"
  exit 1
fi
grep -Fq 'missing cancel_layer_task boundary' /tmp/test621-mutated.log
echo "MUTATION_RED: hold-open-layer-cancel rc=$MUTATION_RC"

echo "RESULT: PASS"
