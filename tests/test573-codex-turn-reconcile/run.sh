#!/usr/bin/env bash

# 🔴 本套件原来有 ARG SOURCE_COMMIT 却从不打印/校验它 ——
# 「绑定了却没人看得见，与没绑定等效」（.github/scripts/check-l1-sha-binding.py 的原话）。
# ⚠️ 注意：本套件的 build-arg 名是 SOURCE_COMMIT，而 Dockerfile:14 把它导出成
#    ENV **TEST573**_SOURCE_COMMIT —— 两个名字不同。断言必须查【运行时那个】。
#    我第一版查了 ARG 名，于是断言在一个运行时根本不存在的变量上，恒红。
[[ "${TEST573_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST573_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST573_SOURCE_COMMIT"

set -euo pipefail

test -f /workspace/agent-node/src/runtime/codex-app-server-bridge.ts
test -f /workspace/agent-node/src/runtime/codex-app-server/runtime.ts

bun test \
  /workspace/agent-node/src/runtime/codex-app-server-bridge.test.ts \
  /workspace/agent-node/src/runtime/codex-app-server/runtime.test.ts
