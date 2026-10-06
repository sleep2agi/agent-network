#!/usr/bin/env bash
set -euo pipefail

# SHA binding. scripts/qa.sh passes this only when the Dockerfile declares
# ARG TEST<digits>_SOURCE_COMMIT. A missing value must fail here, not look green.
[[ "${TEST668_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST668_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST668_SOURCE_COMMIT"

cd /workspace
cp agent-node/src/cli.ts /tmp/cli.orig
cp server/src/session-task-on-dispatch.ts /tmp/dispatch.orig
cp server/src/tools.ts /tmp/tools.orig

restore() {
  cp /tmp/cli.orig agent-node/src/cli.ts
  cp /tmp/dispatch.orig server/src/session-task-on-dispatch.ts
  cp /tmp/tools.orig server/src/tools.ts
}
trap restore EXIT

mutate() {
  local file="$1"
  local count
  count=$(grep -F -c "$ANCHOR" "$file" || true)
  if [ "$count" != "1" ]; then
    echo "MUTATION_NOT_APPLIED: anchor count=$count"
    exit 1
  fi
  FILE="$file" bun -e '
    const fs = require("fs");
    const file = process.env.FILE;
    const anchor = process.env.ANCHOR;
    const repl = process.env.REPL;
    const text = fs.readFileSync(file, "utf8");
    const n = text.split(anchor).length - 1;
    if (n !== 1) {
      console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
      process.exit(1);
    }
    fs.writeFileSync(file, text.replace(anchor, repl));
  '
  if grep -F -q "$ANCHOR" "$file"; then
    echo "MUTATION_NOT_APPLIED: anchor still present"
    exit 1
  fi
}

expect_red() {
  local needle="$1"
  local log="/tmp/scenario668.log"
  settle
  set +e
  bun /workspace/tests/test668-grok-working-status/scenario.ts >"$log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN"
    cat "$log"
    exit 1
  fi
  local line
  line=$(grep -F 'FAIL:' "$log" | head -n 1 || true)
  if [ "$line" != "$needle" ]; then
    echo "WRONG_FAILURE: ${line:-no FAIL line}"
    cat "$log"
    exit 1
  fi
  echo "MUTATION_RED: $line"
}

settle() {
  # The oven/bun image has no pkill. Match the command lines under /proc.
  local pid cmdline
  for pid in /proc/[0-9]*; do
    pid=${pid#/proc/}
    cmdline=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmdline" in
      *'/workspace/server/src/index.ts'*|*'agent-node/src/cli.ts'*|*' /opt/fake-grok/grok'*|*'/opt/fake-grok/grok '*|*' /opt/fake-claude/claude'*|*'/opt/fake-claude/claude '*)
        kill -9 "$pid" >/dev/null 2>&1 || true
        ;;
    esac
  done
  sleep 0.2
}

echo "## green — grok and claude both report the full task while the turn is in flight"
settle
bun /workspace/tests/test668-grok-working-status/scenario.ts

echo "## mutation — report only 200 chars, so the task row never starts"
ANCHOR='activeTurnTask = hubStatusTask(runtimeTask); // board668-inflight-task' \
REPL='activeTurnTask = runtimeTask.slice(0, 200); // board668-inflight-task' \
  mutate agent-node/src/cli.ts
expect_red 'FAIL: started'
restore

echo "## mutation — idle heartbeat covers a live turn"
ANCHOR='if (activeTurnTask) { // board668-keep-working' \
REPL='if (false && activeTurnTask) { // board668-keep-working' \
  mutate agent-node/src/cli.ts
expect_red 'FAIL: heartbeat-idle'
restore

echo "## mutation — dispatch replaces the task text while the session is working"
ANCHOR="CASE WHEN status = 'working' THEN task ELSE" \
REPL="CASE WHEN status = 'no-such-status' THEN task ELSE" \
  mutate server/src/session-task-on-dispatch.ts
expect_red 'FAIL: later message'
restore

echo "## mutation — only grok reports the full task; claude is sliced to 200"
ANCHOR='activeTurnTask = hubStatusTask(runtimeTask); // board668-inflight-task' \
REPL='activeTurnTask = (RUNTIME === "grok" ? hubStatusTask(runtimeTask) : runtimeTask.slice(0, 200)); // board668-inflight-task' \
  mutate agent-node/src/cli.ts
expect_red 'FAIL: claude-started'
restore

echo "## mutation — report_status stores the whole task on the session row"
ANCHOR='const sessionTask = task == null ? null : sessionTaskPreview(task); // board668-session-preview' \
REPL='const sessionTask = task ?? null; // board668-session-preview' \
  mutate server/src/tools.ts
expect_red 'FAIL: session-preview'
restore

echo "## mutation — parent inference takes an acked/running task again"
ANCHOR="status IN ('delivered')\"; // board668-parent-delivered-only" \
REPL="status IN ('delivered','acked','running')\"; // board668-parent-delivered-only" \
  mutate server/src/tools.ts
expect_red 'FAIL: parent-running'
restore

echo "## mutation — parent inference no longer takes a delivered task"
ANCHOR="status IN ('delivered')\"; // board668-parent-delivered-only" \
REPL="status IN ('no-such-status')\"; // board668-parent-delivered-only" \
  mutate server/src/tools.ts
expect_red 'FAIL: parent-delivered'
restore

echo "OVERALL: PASS"
