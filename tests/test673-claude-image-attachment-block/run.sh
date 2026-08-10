#!/usr/bin/env bash
# test673 — Claude runtime multimodal-wiring gate (issue #259 Y).
#
# Proves the FULL real inbound path in agent-node/src/cli.ts:
#   SSE task with meta.attachments=[{type:"file",file_id,mime:"image/png"}]
#     → extractImagePaths() downloads bytes via hub GET /api/files/<id>  (#222)
#     → processTask → think → processWithClaude(task, from, images)      (dispatch)
#     → processWithClaude builds prompt as AsyncIterable<SDKUserMessage> (#259 Y)
#       whose user-message content carries an image content block
#       { type:"image", source:{ type:"base64", media_type, data } }
#     → claude-agent-sdk query({ prompt }) receives that image block.
#
# The claude-agent-sdk `query` is stubbed via `bun --preload` (see
# sdk-stub-preload.ts) so no real vendor/binary is needed; the stub
# records the prompt structure query() actually received to a capture
# file, which we then assert against the uploaded bytes.
#
# Witnessed-red mutation: revert the dispatch to processWithClaude(task,
# from)  — dropping the images arg — and prove the image block DISAPPEARS
# from the query prompt (capture kind flips to "string").
#
# REPO defaults to /app (Docker). Override REPO to run against a source
# checkout on the host (isolated hub + tmp DB, cleans up after).
set -uo pipefail

REPO="${REPO:-/app}"
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRELOAD="$TEST_DIR/sdk-stub-preload.ts"
source "$REPO/tests/lib/safe-rm.sh"

HUB_PORT="${HUB_PORT:-9673}"
HUB_BASE="http://127.0.0.1:$HUB_PORT"
WORK="${WORK:-/tmp/test673}"
export HOME="$WORK/home"
HUB_DB="$WORK/hub.db"
HUB_UPLOADS="$WORK/hub-uploads"
CAPTURE="$WORK/capture.json"
NODE_LOG="$WORK/node.log"
HUB_LOG="$WORK/hub.log"
CFG="$WORK/node-config.json"
ALIAS="test673-agent"
ADMIN_USER="test673admin"
ADMIN_PW="test673_TestPass_1234!"

export TEST673_CAPTURE_FILE="$CAPTURE"

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  PASS %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  FAIL %s\n" "$*"; FAIL=$((FAIL+1)); }

printf "source_commit=%s\n" "${TEST673_SOURCE_COMMIT:-unknown}"
printf "repo=%s\n" "$REPO"

safe_rm_rf "$WORK"
mkdir -p "$HOME" "$HUB_UPLOADS"

HUB_PID=""; NODE_PID=""
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    [[ ! -e "/proc/$pid" ]] && return 0
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    [[ ! -e "/proc/$pid" ]] && return 0
    sleep 0.1
  done
  echo "test673 REFUSE: process-group leader $pid survived cleanup" >&2
  return 1
}

stop_node() {
  local pid="$NODE_PID"
  NODE_PID=""
  stop_group "$pid"
  [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
}

cleanup() {
  stop_node || true
  local hub_pid="$HUB_PID"
  HUB_PID=""
  stop_group "$hub_pid" || true
  [[ -n "$hub_pid" ]] && wait "$hub_pid" 2>/dev/null || true
  # restore cli.ts if a mutation left it patched
  if [[ -f "$WORK/cli.ts.orig" ]]; then cp "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts"; fi
}
trap cleanup EXIT

# ── 0. boot hub ───────────────────────────────────────────────────
note "0. boot hub"
( cd "$REPO/server" && exec setsid env PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test \
    COMMHUB_DB="$HUB_DB" COMMHUB_UPLOADS_ROOT="$HUB_UPLOADS" \
    bun run src/index.ts >"$HUB_LOG" 2>&1 ) &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
if curl -fsS "$HUB_BASE/health" >/dev/null 2>&1; then ok "hub /health 200 :$HUB_PORT"; else bad "hub did not start"; tail -30 "$HUB_LOG"; exit 1; fi

# ── 1. register admin + network + node token ──────────────────────
note "1. admin + network + ntok"
REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"t673@test.local\"}")
UTOK=$(echo "$REG" | jq -r '.token // empty')
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
[[ -n "$NET_ID" && "$NET_ID" != "null" ]] && ok "network_id=$NET_ID" || { bad "no network"; exit 1; }
NTOK=$(curl -sS -X POST "$HUB_BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$ALIAS\"}" | jq -r '.token // empty')
[[ "$NTOK" == ntok_* ]] && ok "agent ntok minted" || { bad "ntok mint failed"; exit 1; }

# ── 2. upload a real PNG → file_id ────────────────────────────────
note "2. upload real 1x1 PNG"
# 1x1 PNG (deterministic, no secrets).
B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
echo -n "$B64" | base64 -d > "$WORK/pixel.png"
UPLOAD=$(curl -sS -X POST "$HUB_BASE/api/upload" -H "Authorization: Bearer $UTOK" \
  -F "file=@$WORK/pixel.png;type=image/png")
FILE_ID=$(echo "$UPLOAD" | jq -r '.file_id // empty')
[[ -n "$FILE_ID" && "$FILE_ID" != "null" ]] && ok "uploaded file_id=$FILE_ID" || { bad "upload failed: $UPLOAD"; exit 1; }
EXPECTED_B64=$(base64 -w0 "$WORK/pixel.png")

# ── 3. write node config (image-capable claude runtime) ───────────
note "3. node config"
write_config() {
  local image_capable="$1"
  cat > "$CFG" <<JSON
{ "runtime": "claude-agent-sdk", "model": "claude-sonnet-4-6",
  "hub": "$HUB_BASE", "token": "$NTOK", "network_id": "$NET_ID",
  "flags": { "modelImageCapable": $image_capable, "dangerouslySkipPermissions": true } }
JSON
}
write_config true
ok "config written (flags.modelImageCapable=true)"

# ── helper: start the real node under the stubbed SDK ─────────────
start_node() {
  rm -f "$CAPTURE"
  ( cd "$WORK" && exec setsid env COMMHUB_URL="$HUB_BASE" COMMHUB_TOKEN="$NTOK" ANET_NETWORK_ID="$NET_ID" \
      MODEL="claude-sonnet-4-6" ANTHROPIC_API_KEY="test673-fake-key" \
      TEST673_CAPTURE_FILE="$CAPTURE" HOME="$HOME" \
      bun --preload "$PRELOAD" "$REPO/agent-node/src/cli.ts" \
        --alias "$ALIAS" --config "$CFG" >>"$NODE_LOG" 2>&1 ) &
  NODE_PID=$!
  # wait until the node's session shows up as active on the hub
  for _ in $(seq 1 60); do
    if curl -fsS "$HUB_BASE/api/status?network_id=$NET_ID" -H "Authorization: Bearer $UTOK" 2>/dev/null | jq -e \
         --arg a "$ALIAS" '.sessions[]? | select(.alias==$a)' >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

send_task_with_image() {
  # $1 = task text (must differ between phases — the hub rejects identical
  # task content to the same alias within a 5-min window: duplicate_send).
  local text="$1" resp mid
  for _ in 1 2 3; do
    resp=$(curl -sS -X POST "$HUB_BASE/api/task" -H "Authorization: Bearer $UTOK" \
      -H 'Content-Type: application/json' \
      -d "{\"alias\":\"$ALIAS\",\"task\":\"$text\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\",\"attachments\":[{\"type\":\"file\",\"file_id\":\"$FILE_ID\",\"mime\":\"image/png\",\"name\":\"pixel.png\"}]}")
    mid=$(echo "$resp" | jq -r '.message_id // empty')
    [[ -n "$mid" ]] && { echo "$mid"; return 0; }
    echo "  (task-send retry; resp=$resp)" >&2
    sleep 1
  done
  return 1
}

send_text_task() {
  local text="$1" resp mid
  for _ in 1 2 3; do
    resp=$(curl -sS -X POST "$HUB_BASE/api/task" -H "Authorization: Bearer $UTOK" \
      -H 'Content-Type: application/json' \
      -d "{\"alias\":\"$ALIAS\",\"task\":\"$text\",\"priority\":\"normal\",\"network_id\":\"$NET_ID\"}")
    mid=$(echo "$resp" | jq -r '.message_id // empty')
    [[ -n "$mid" ]] && { echo "$mid"; return 0; }
    echo "  (text-task retry; resp=$resp)" >&2
    sleep 1
  done
  return 1
}

wait_capture() {
  for _ in $(seq 1 60); do [[ -s "$CAPTURE" ]] && return 0; sleep 0.5; done
  return 1
}

# assert_image_block: exit 0 iff the captured query prompt is an
# AsyncIterable carrying an image block whose base64 == the uploaded PNG.
assert_image_block() {
  [[ -s "$CAPTURE" ]] || { echo "no capture file"; return 1; }
  local kind cnt data
  kind=$(jq -r '.kind' "$CAPTURE")
  cnt=$(jq -r '.image_block_count // 0' "$CAPTURE")
  [[ "$kind" == "async-iterable" ]] || { echo "kind=$kind (expected async-iterable)"; return 1; }
  [[ "$cnt" -ge 1 ]] || { echo "image_block_count=$cnt"; return 1; }
  data=$(jq -r '.blocks[] | select(.type=="image") | .data_b64' "$CAPTURE" | head -1)
  [[ "$data" == "$EXPECTED_B64" ]] || { echo "image base64 mismatch"; return 1; }
  return 0
}

# ── 4. GREEN: real path delivers an image block to query() ────────
note "4. GREEN — image block reaches claude-agent-sdk query()"
if start_node; then ok "node registered on hub"; else bad "node did not register"; tail -40 "$NODE_LOG"; exit 1; fi
TID=$(send_task_with_image "describe the attached image [green $(date +%s%N)]")
[[ -n "$TID" ]] && ok "task sent (id=$TID) with file_id attachment" || bad "task send failed"
if wait_capture; then ok "query() was invoked (capture written)"; else bad "query() never captured"; tail -40 "$NODE_LOG"; fi
if assert_image_block; then
  MT=$(jq -r '.blocks[] | select(.type=="image") | .media_type' "$CAPTURE" | head -1)
  ST=$(jq -r '.blocks[] | select(.type=="image") | .source_type' "$CAPTURE" | head -1)
  HASTXT=$(jq -r '[.blocks[]? | select(.type=="text")] | length' "$CAPTURE")
  ok "query prompt carries an image content block (source_type=$ST media_type=$MT) with the downloaded bytes"
  [[ "$HASTXT" -ge 1 ]] && ok "prompt also carries the text block (multimodal turn, not image-only)" || bad "text block missing from multimodal prompt"
else
  bad "image block assertion failed: $(cat "$CAPTURE" 2>/dev/null)"
fi
stop_node; sleep 1

# ── 5. GREEN: text-only remains the historical string prompt ─────
note "5. GREEN — text-only task remains a string prompt"
if start_node; then ok "text-only node registered"; else bad "text-only node did not register"; tail -40 "$NODE_LOG"; fi
TEXT_MARKER="text-only-shape-$(date +%s%N)"
TID_TEXT=$(send_text_task "$TEXT_MARKER")
[[ -n "$TID_TEXT" ]] && ok "text-only task sent (id=$TID_TEXT)" || bad "text-only task send failed"
if wait_capture; then ok "text-only query captured"; else bad "text-only query never captured"; tail -20 "$NODE_LOG"; fi
TEXT_KIND=$(jq -r '.kind // "none"' "$CAPTURE" 2>/dev/null)
TEXT_PREVIEW=$(jq -r '.textPreview // ""' "$CAPTURE" 2>/dev/null)
[[ "$TEXT_KIND" == "string" ]] && ok "text-only query keeps string prompt shape" || bad "text-only prompt kind=$TEXT_KIND"
[[ "$TEXT_PREVIEW" == *"$TEXT_MARKER"* ]] && ok "text-only prompt still contains the task bytes" || bad "text-only task marker missing"
stop_node; sleep 1

# ── 6. GREEN: unverified model must not receive image blocks ──────
note "6. GREEN — modelImageCapable=false downgrades to text-only"
write_config false
if start_node; then ok "non-image-capable node registered"; else bad "non-image-capable node did not register"; tail -40 "$NODE_LOG"; fi
TID_FALSE=$(send_task_with_image "do not attach image [capability-false $(date +%s%N)]")
[[ -n "$TID_FALSE" ]] && ok "image task sent to non-image-capable profile (id=$TID_FALSE)" || bad "non-image-capable task send failed"
if wait_capture; then ok "non-image-capable query captured"; else bad "non-image-capable query never captured"; tail -20 "$NODE_LOG"; fi
FALSE_KIND=$(jq -r '.kind // "none"' "$CAPTURE" 2>/dev/null)
FALSE_COUNT=$(jq -r '.image_block_count // 0' "$CAPTURE" 2>/dev/null)
[[ "$FALSE_KIND" == "string" && "$FALSE_COUNT" == "0" ]] \
  && ok "modelImageCapable=false structurally cannot send an image block" \
  || bad "capability=false leaked image block (kind=$FALSE_KIND count=$FALSE_COUNT)"
stop_node; sleep 1
write_config true

# ── 7. WITNESSED-RED mutation: drop images from the dispatch ──────
note "7. RED mutation — dispatch drops images but preserves evidence"
cp "$REPO/agent-node/src/cli.ts" "$WORK/cli.ts.orig"
sed -i 's/return await processWithClaude(task, from, images, evidence);/return await processWithClaude(task, from, undefined, evidence);/' "$REPO/agent-node/src/cli.ts"
if ! cmp -s "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts" \
   && grep -q 'processWithClaude(task, from, undefined, evidence);' "$REPO/agent-node/src/cli.ts"; then
  ok "mutation applied with byte change (images arg dropped, evidence preserved)"
else
  bad "mutation did not change the exact production dispatch anchor"
fi
if start_node; then ok "mutated node registered"; else bad "mutated node did not register"; tail -40 "$NODE_LOG"; fi
sleep 1
TID2=$(send_task_with_image "describe the attached image [mutation $(date +%s%N)]")
[[ -n "$TID2" ]] && ok "task re-sent under mutation (id=$TID2)" || bad "task send failed under mutation"
if wait_capture; then ok "mutated turn still ran (query captured)"; else bad "mutated query never captured"; tail -20 "$NODE_LOG"; fi
if assert_image_block; then
  bad "MUTATION STAYED GREEN — image block still present without the images arg (gate is vacuous)"
else
  KIND=$(jq -r '.kind // "none"' "$CAPTURE" 2>/dev/null)
  CNT=$(jq -r '.image_block_count // 0' "$CAPTURE" 2>/dev/null)
  # Clean red: the turn DID run but with a plain string prompt (no image
  # block), proving the dropped `images` arg is what carries the image —
  # not that the task merely failed to arrive.
  if [[ "$KIND" == "string" ]]; then
    ok "witnessed red — turn ran with a STRING prompt (kind=$KIND, image_block_count=$CNT); dropping the images arg removes the image block"
  else
    ok "witnessed red — no image block under mutation (capture kind=$KIND); dispatch threading is load-bearing"
  fi
fi
stop_node
cp "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts"; rm -f "$WORK/cli.ts.orig"
ok "cli.ts restored"

# ── 8. WITNESSED-RED mutation: bypass per-model capability gate ───
note "8. RED mutation — bypass modelImageCapable gate"
cp "$REPO/agent-node/src/cli.ts" "$WORK/cli.ts.orig"
sed -i 's/if (hasImages && modelImageCapable) {/if (hasImages) {/' "$REPO/agent-node/src/cli.ts"
if ! cmp -s "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts" \
   && grep -q 'if (hasImages) {' "$REPO/agent-node/src/cli.ts"; then
  ok "capability mutation applied with byte change"
else
  bad "capability mutation did not change the exact production gate"
fi
write_config false
if start_node; then ok "capability-mutated node registered"; else bad "capability-mutated node did not register"; tail -40 "$NODE_LOG"; fi
TID_CAP_MUT=$(send_task_with_image "capability mutation [$(date +%s%N)]")
[[ -n "$TID_CAP_MUT" ]] && ok "task sent under capability mutation (id=$TID_CAP_MUT)" || bad "capability mutation task send failed"
if wait_capture; then ok "capability-mutated query captured"; else bad "capability-mutated query never captured"; tail -20 "$NODE_LOG"; fi
if assert_image_block; then
  ok "witnessed red — removing modelImageCapable check leaks an image block to the unverified profile"
else
  bad "capability mutation stayed green; image block was still absent"
fi
stop_node
cp "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts"; rm -f "$WORK/cli.ts.orig"
write_config true
ok "cli.ts and config restored after capability mutation"

printf "\n────────────────────────────────────────────\n"
printf "test673 claude image-attachment block — PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
printf "────────────────────────────────────────────\n"
[[ "$FAIL" -eq 0 ]]
