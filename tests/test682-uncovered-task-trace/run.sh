#!/usr/bin/env bash
set -euo pipefail
echo "source_commit=${TEST682_SOURCE_COMMIT}"
WORK=/tmp/test682
HUB_BASE=http://127.0.0.1:9682
mkdir -p "$WORK"
(cd /app/server && env PORT=9682 HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
trap 'kill "$HUB_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep .25; done
curl -fsS "$HUB_BASE/health" >/dev/null

cd /app
bun test tests/test682-uncovered-task-trace/wiring.test.ts tests/test682-uncovered-task-trace/semantics.test.ts
HUB_BASE="$HUB_BASE" bun tests/test682-uncovered-task-trace/true-hub.ts

mutate_expect_red() {
  local file="$1" from="$2" to="$3" label="$4"
  local backup="$WORK/$label.orig"
  cp "$file" "$backup"
  python3 - "$file" "$from" "$to" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); old=sys.argv[2]; new=sys.argv[3]; data=p.read_text()
if data.count(old) != 1: raise SystemExit(f"anchor count={data.count(old)} for {old!r}")
p.write_text(data.replace(old,new,1))
PY
  cmp -s "$file" "$backup" && { echo "mutation no-op: $label" >&2; exit 1; }
  set +e
  bun test tests/test682-uncovered-task-trace/wiring.test.ts tests/test682-uncovered-task-trace/semantics.test.ts >"$WORK/$label.log" 2>&1
  local rc=$?
  set -e
  cp "$backup" "$file"
  [[ $rc -ne 0 ]] || { echo "mutation stayed green: $label" >&2; exit 1; }
  echo "WITNESSED_RED $label rc=$rc"
}

mutate_expect_red agent-node/src/cli.ts 'sendPeerReplyTaskWithTrace({' 'sendPeerReplyTaskWithoutTrace({' peer-wiring
mutate_expect_red agent-network/src/client.ts 'sendClientTaskWithTrace({ alias: targetAlias' 'sendClientTaskWithoutTrace({ alias: targetAlias' client-wiring
mutate_expect_red agent-node/src/peer-reply-task-trace.ts 'transport: "mcp_http"' 'transport: "sdk_mcp_proxy"' peer-transport
mutate_expect_red agent-network/src/client-task-trace.ts 'transport: "mcp_http"' 'transport: "sdk_mcp_proxy"' client-transport
mutate_expect_red agent-node/src/peer-reply-task-trace.ts 'lifecycleTracking: "not_tracked"' 'lifecycleTracking: "tracked"' peer-lifecycle
mutate_expect_red agent-network/src/client-task-trace.ts 'lifecycleTracking: "not_tracked"' 'lifecycleTracking: "tracked"' client-lifecycle
mutate_expect_red agent-network/src/task-trace.ts '    throw error;' '    return { swallowed: true };' preserve-throw
mutate_expect_red agent-network/src/task-trace.ts '"missing_task_id"' '"send_failed"' missing-id
mutate_expect_red agent-network/src/task-trace.ts '    if (taskId) {' '    if (taskId && result?.ok !== false) {' queued-is-delivered
mutate_expect_red agent-node/src/peer-reply-task-trace.ts '  return sendTaskWithTrace({' '  return (Promise.resolve({ changed: true }) as any) || sendTaskWithTrace({' peer-return-shape
mutate_expect_red agent-network/src/client-task-trace.ts '  return sendTaskWithTrace({' '  return (Promise.resolve({ changed: true }) as any) || sendTaskWithTrace({' client-return-shape

cd /app/agent-node
bun run build
cd /app/agent-network
bun run typecheck
bun run build
cmp -s /app/agent-node/src/task-trace.ts /app/agent-network/src/task-trace.ts
echo "RESULT: PASS"
