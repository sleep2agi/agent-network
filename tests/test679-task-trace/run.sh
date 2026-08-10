#!/usr/bin/env bash
set -euo pipefail
echo "source_commit=${TEST679_SOURCE_COMMIT}"
HUB_BASE=http://127.0.0.1:9679
WORK=/tmp/test679
mkdir -p "$WORK"
(cd /app/server && env PORT=9679 HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
trap 'kill "$HUB_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep .25; done
curl -fsS "$HUB_BASE/health" >/dev/null
HUB_BASE="$HUB_BASE" bun /app/tests/test679-task-trace/true-hub.ts
bun test /app/tests/test679-task-trace/wiring.test.ts

mutate_expect_red() {
  local file="$1" from="$2" to="$3" label="$4" backup="$WORK/mutation.orig"
  cp "$file" "$backup"
  python3 - "$file" "$from" "$to" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); old=sys.argv[2]; new=sys.argv[3]; data=p.read_text()
if data.count(old) != 1: raise SystemExit(f"anchor count={data.count(old)} for {old!r}")
p.write_text(data.replace(old,new,1))
PY
  if cmp -s "$file" "$backup"; then echo "mutation no-op: $label" >&2; exit 1; fi
  set +e
  bun test /app/tests/test679-task-trace/wiring.test.ts >"$WORK/$label.log" 2>&1
  local rc=$?
  set -e
  cp "$backup" "$file"
  [[ $rc -ne 0 ]] || { echo "mutation stayed green: $label" >&2; exit 1; }
  echo "WITNESSED_RED $label rc=$rc"
}

mutate_expect_red /app/agent-node/src/explicit-task-trace.ts 'transport: "mcp_http"' 'transport: "sdk_mcp_proxy"' explicit-transport
mutate_expect_red /app/agent-node/src/commhub-mcp.ts 'transport: "sdk_mcp_proxy"' 'transport: "mcp_http"' sdk-transport
mutate_expect_red /app/agent-network/src/channel-task-trace.ts 'transport: "channel_mcp_proxy"' 'transport: "mcp_http"' channel-transport
mutate_expect_red /app/agent-node/src/commhub-mcp.ts 'lifecycle_tracking: "not_tracked"' 'lifecycle_tracking: "tracked"' sdk-lifecycle
mutate_expect_red /app/agent-network/src/channel-task-trace.ts 'lifecycle_tracking: "not_tracked"' 'lifecycle_tracking: "tracked"' channel-lifecycle
mutate_expect_red /app/agent-network/src/node-server.ts \
  $'    return { content: [{ type: "text", text: JSON.stringify(result) }] };\n  }\n\n  if (name === "commhub_send_message")' \
  $'    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };\n  }\n\n  if (name === "commhub_send_message")' \
  channel-response-shape
cd /app/agent-node
bun test src/task-trace.test.ts src/commhub-mcp.test.ts
bun run build
cd /app/agent-network
bun run typecheck
bun run build
cmp -s /app/agent-node/src/task-trace.ts /app/agent-network/src/task-trace.ts
echo "RESULT: PASS"
