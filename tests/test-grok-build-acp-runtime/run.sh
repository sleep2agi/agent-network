#!/usr/bin/env bash
set -euo pipefail

ROOT="/workspace"
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-grok-build-acp-runtime.txt}"
PORT="${PORT:-9391}"
HUB="http://127.0.0.1:$PORT"
ALIAS="grok-runtime-probe"
WORK="/tmp/anet-grok-runtime"

mkdir -p "$ARTIFACT_DIR" "$(dirname "$REPORT")" "$HOME/.grok" "$WORK/.anet/nodes/$ALIAS"
: >"$REPORT"

log() {
  printf '%s\n' "$*" | tee -a "$REPORT"
}

mask() {
  sed -E \
    -e 's/(xai-|sk-|gsk-|ghp_|github_pat_)[A-Za-z0-9._-]+/\1•••MASKED•••/g' \
    -e 's/("refresh_token"[[:space:]]*:[[:space:]]*")[^"]+(")/\1•••MASKED•••\2/g' \
    -e 's/("access_token"[[:space:]]*:[[:space:]]*")[^"]+(")/\1•••MASKED•••\2/g'
}

setup_auth() {
  if [ -n "${GROK_CODE_XAI_API_KEY:-}" ]; then
    log "auth: env mode"
    return 0
  fi
  if [ -f /host-grok/auth.json ]; then
    ln -sf /host-grok/auth.json "$HOME/.grok/auth.json"
    [ -f /host-grok/agent_id ] && ln -sf /host-grok/agent_id "$HOME/.grok/agent_id"
    [ -f /host-grok/config.toml ] && ln -sf /host-grok/config.toml "$HOME/.grok/config.toml"
    log "auth: host-mount mode"
    return 0
  fi
  log "SKIP: no GROK_CODE_XAI_API_KEY and no /host-grok/auth.json"
  exit 0
}

install_grok() {
  if command -v grok >/dev/null 2>&1; then return 0; fi
  log "installing grok"
  curl -fsSL https://x.ai/cli/install.sh | bash
  export PATH="$HOME/.local/bin:$HOME/.grok/bin:$PATH"
  command -v grok >/dev/null 2>&1
}

wait_http() {
  local url="$1"
  for _ in $(seq 1 80); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  return 1
}

cleanup() {
  set +e
  [ -n "${AGENT_PID:-}" ] && kill "$AGENT_PID" 2>/dev/null
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT

log "# Grok Build ACP runtime E2E"
log "- date: $(date -Is)"

export HOME="${HOME:-/tmp/grok-home}"
export PATH="$HOME/.local/bin:$HOME/.grok/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

setup_auth
install_grok
grok --version | tee "$ARTIFACT_DIR/grok-version.txt" | tee -a "$REPORT"

log "build: agent-node"
cd "$ROOT/agent-node"
npm run build >>"$REPORT" 2>&1

log "start: commhub dev-open"
cd "$ROOT/server"
HOST=127.0.0.1 PORT="$PORT" COMMHUB_DEV_OPEN=1 bun run src/index.ts --dev-open >"$ARTIFACT_DIR/server.log" 2>&1 &
SERVER_PID=$!
wait_http "$HUB/health" || { log "FAIL: hub did not start"; tail -80 "$ARTIFACT_DIR/server.log" | mask | tee -a "$REPORT"; exit 1; }

log "auth: register test user and node token"
REGISTER_JSON=$(curl -fsS -X POST "$HUB/api/auth/register" \
  -H 'Content-Type: application/json' \
  --data '{"username":"grok-runtime-test","password":"testpass123","display_name":"Grok Runtime Test"}')
USER_TOKEN=$(echo "$REGISTER_JSON" | jq -r '.token')
NODE_TOKEN=$(echo "$REGISTER_JSON" | jq -r '.network_token')
NETWORK_ID=$(echo "$REGISTER_JSON" | jq -r '.network_id')
if [ -z "$USER_TOKEN" ] || [ "$USER_TOKEN" = "null" ] || [ -z "$NODE_TOKEN" ] || [ "$NODE_TOKEN" = "null" ] || [ -z "$NETWORK_ID" ] || [ "$NETWORK_ID" = "null" ]; then
  log "FAIL: auth register did not return user token, node token, and network_id"
  echo "$REGISTER_JSON" | mask | tee -a "$REPORT"
  exit 1
fi
log "auth: network_id=$NETWORK_ID"

cat >"$WORK/.anet/nodes/$ALIAS/config.json" <<JSON
{
  "alias": "$ALIAS",
  "runtime": "grok-build-acp",
  "hub": "$HUB",
  "token": "$NODE_TOKEN",
  "network_id": "$NETWORK_ID",
  "logLevel": "debug"
}
JSON

log "start: agent-node grok-build-acp"
cd "$WORK"
node "$ROOT/agent-node/dist/cli.js" --config "$WORK/.anet/nodes/$ALIAS/config.json" --alias "$ALIAS" >"$ARTIFACT_DIR/agent.log" 2>&1 &
AGENT_PID=$!

for _ in $(seq 1 80); do
  if curl -fsS "$HUB/api/status?network_id=$NETWORK_ID" -H "Authorization: Bearer $USER_TOKEN" | jq -e --arg a "$ALIAS" '.sessions[]? | select(.alias == $a)' >/dev/null; then
    log "PASS: agent registered"
    break
  fi
  sleep 0.5
done
if ! curl -fsS "$HUB/api/status?network_id=$NETWORK_ID" -H "Authorization: Bearer $USER_TOKEN" | jq -e --arg a "$ALIAS" '.sessions[]? | select(.alias == $a)' >/dev/null; then
  log "FAIL: agent did not register"
  tail -120 "$ARTIFACT_DIR/agent.log" | mask | tee -a "$REPORT"
  exit 1
fi

TASK_ID=$(curl -fsS -X POST "$HUB/api/task" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $USER_TOKEN" \
  --data "{\"alias\":\"$ALIAS\",\"task\":\"Reply with exactly GROK_RUNTIME_OK.\",\"from\":\"grok-runtime-test\",\"priority\":\"high\",\"network_id\":\"$NETWORK_ID\"}" \
  | jq -r '.task_id // .message_id // .id')
log "task: $TASK_ID"

for _ in $(seq 1 180); do
  TASK_ROW=$(curl -fsS "$HUB/api/tasks?limit=20&network_id=$NETWORK_ID" -H "Authorization: Bearer $USER_TOKEN" | jq -c --arg id "$TASK_ID" '.tasks[]? | select(.task_id == $id)' || true)
  if echo "$TASK_ROW" | jq -e '.status == "replied"' >/dev/null 2>&1; then
    log "PASS: task replied"
    echo "$TASK_ROW" >"$ARTIFACT_DIR/task-row.json"
    break
  fi
  if echo "$TASK_ROW" | jq -e '.status == "failed"' >/dev/null 2>&1; then
    log "FAIL: task failed"
    echo "$TASK_ROW" | tee -a "$REPORT"
    tail -160 "$ARTIFACT_DIR/agent.log" | mask | tee -a "$REPORT"
    exit 1
  fi
  sleep 1
done

if [ ! -s "$ARTIFACT_DIR/task-row.json" ]; then
  log "FAIL: task did not reach replied"
  curl -fsS "$HUB/api/tasks?limit=20&network_id=$NETWORK_ID" -H "Authorization: Bearer $USER_TOKEN" | tee "$ARTIFACT_DIR/tasks-timeout.json" | jq . | tee -a "$REPORT" || true
  tail -160 "$ARTIFACT_DIR/agent.log" | mask | tee -a "$REPORT"
  exit 1
fi

if ! jq -e '.grokSession | type == "string" and length > 0' "$WORK/.anet/nodes/$ALIAS/config.json" >/dev/null; then
  log "FAIL: grokSession was not persisted"
  cat "$WORK/.anet/nodes/$ALIAS/config.json" | tee -a "$REPORT"
  exit 1
fi

log "PASS: grokSession persisted"
log ""
log "## Summary"
log "- result: PASS"
log "- task_id: $TASK_ID"
log "- grokSession: $(jq -r '.grokSession' "$WORK/.anet/nodes/$ALIAS/config.json" | cut -c1-8)..."
