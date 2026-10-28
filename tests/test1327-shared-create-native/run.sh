#!/usr/bin/env bash
set -euo pipefail
unset TMUX TMUX_PANE
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test1327-runtime.txt") 2>&1
echo "test1327 native shared create source=${SOURCE_COMMIT:-unset} date=$(date -Is)"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" ]]; then test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"; fi
# #1537 追加了「停两节点 -> 停 Server -> 复制 data -> 新 Server -> 两节点 start -> 各回一件」，
# 比原来多出约 2 分钟真实等待（TUI 渲染 + 两次任务终态）。预算抬到 420s，
# 断言的严格程度不变 —— 只是给真实等待留出空间。
timeout 420s bun /test1327/harness.ts
