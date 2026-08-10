#!/usr/bin/env bash
set -euo pipefail
echo "source_commit=${TEST681_SOURCE_COMMIT}"
WORK=/tmp/test681
mkdir -p "$WORK"

cd /app/agent-node
bun test src/explicit-task-lifecycle.test.ts
bun run build

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
  bun test src/explicit-task-lifecycle.test.ts >"$WORK/$label.log" 2>&1
  local rc=$?
  set -e
  cp "$backup" "$file"
  [[ $rc -ne 0 ]] || { echo "mutation stayed green: $label" >&2; exit 1; }
  echo "WITNESSED_RED $label rc=$rc"
}

mutate_expect_red src/explicit-task-trace.ts 'emit(childStatus === "acked" ? "acked" : "started", taskId);' 'emit("started", taskId);' ack-event
mutate_expect_red src/explicit-task-trace.ts 'emit(childStatus === "replied" ? "replied" : "failed", taskId, {' 'emit("failed", taskId, {' reply-event
mutate_expect_red src/explicit-task-trace.ts 'event: "task.warning.delivered_stale_30s"' 'event: "task.warning.deleted"' stale-30-event
mutate_expect_red src/explicit-task-trace.ts 'event: "task.warning.delivered_stale_60s"' 'event: "task.warning.deleted"' stale-60-event
mutate_expect_red src/explicit-task-trace.ts 'emit("expired", taskId, { errorCode: "lifecycle_timeout" });' 'emit("failed", taskId, { errorCode: "lifecycle_timeout" });' expiry-event
mutate_expect_red src/cli.ts '    emit: emitTrace,' '    emit: () => {},' production-wiring
mutate_expect_red src/explicit-task-trace.ts 'dependencies.timeoutMs ?? 120_000' 'dependencies.timeoutMs ?? 121_000' timeout-default
mutate_expect_red src/explicit-task-trace.ts 'dependencies.pollIntervalMs ?? 2_000' 'dependencies.pollIntervalMs ?? 3_000' poll-default
mutate_expect_red src/explicit-task-trace.ts 'dependencies.stale30Ms ?? 30_000' 'dependencies.stale30Ms ?? 31_000' stale-30-default
mutate_expect_red src/explicit-task-trace.ts 'dependencies.stale60Ms ?? 60_000' 'dependencies.stale60Ms ?? 61_000' stale-60-default

echo "RESULT: PASS"
