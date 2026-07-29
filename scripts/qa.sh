#!/usr/bin/env bash
# scripts/qa.sh — anet QA 一键入口
#
# 跑 L0 + L1 测试，让 PR 评审一条命令验证基线。
# - L0：bun test 单测（ms 级，最快，失败立即停）
# - L1：Docker contract 测试三连（hub-05 / hub-06 / node-02），并行 build/run
# - 任一 fail → 非 0 退出
#
# Usage:
#   bash scripts/qa.sh          # 全跑
#   bash scripts/qa.sh --l0     # 只跑 L0
#   bash scripts/qa.sh --l1     # 只跑 L1
#   bash scripts/qa.sh --list   # 列测试名 + 预算
#
# 预算（warm cache）：L0 ~0.1s + L1 ~20s（并行）= ~20s 总。
# 预算（cold cache）：~60s 总（含 npm install of preview package per L1 test）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Color helpers (skip if not a tty)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[0;33m'; DIM='\033[2m'; NC='\033[0m'
else
  GREEN=''; RED=''; YEL=''; DIM=''; NC=''
fi
ok()   { printf "%b✓%b %s\n" "$GREEN" "$NC" "$*"; }
fail() { printf "%b✗%b %s\n" "$RED" "$NC" "$*" >&2; }
note() { printf "%b·%b %s\n" "$DIM" "$NC" "$*"; }
sec()  { printf "\n%b%s%b\n" "$YEL" "$1" "$NC"; }

USE_SG=0
if ! docker info >/dev/null 2>&1; then
  if command -v sg >/dev/null && sg docker -c 'docker info' >/dev/null 2>&1; then
    USE_SG=1
  else
    fail "docker not accessible. Try: sg docker -c 'docker info'"
    exit 2
  fi
fi
# Run a docker command, optionally through sg docker -c for permission group access.
dockerrun() {
  if [[ $USE_SG -eq 1 ]]; then sg docker -c "$*"
  else bash -c "$*"
  fi
}

L0_TESTS=(
  "password-dict:server/src/password-dict.test.ts"
  "auth-tokens:server/src/auth-tokens.test.ts"
  "auth-validate:server/src/auth-validate.test.ts"
  "observer-push:server/src/observer-push.test.ts"
  "avatar-validate:server/src/avatar-validate.test.ts"
  "observer-avatar-http:server/src/observer-avatar-http.test.ts"
)
L1_TESTS=(
  "qa-cli-01-hub-start"
  "qa-cli-02-network-create"
  "qa-dash-07-auth-boundary"
  "qa-dash-08-cross-account-views"
  "qa-dash-10-incremental-poll"
  "qa-hub-05-roundtrip"
  "qa-hub-06-token-revoke"
  "qa-hub-06b-cross-user-isolation"
  "qa-hub-07-sse-reconnect"
  "qa-hub-08-restart-persistence"
  "qa-hub-09-task-state-machine"
  "qa-node-02-success-reply"
  "qa-node-03b-task-events"
)

if [[ "${1:-}" == "--list" ]]; then
  echo "L0 unit (bun test, local, ms-budget):"
  for t in "${L0_TESTS[@]}"; do echo "  - ${t%%:*}  (${t#*:})"; done
  echo "L1 contract (Docker, ~10-15s each):"
  for t in "${L1_TESTS[@]}"; do echo "  - tests/$t/"; done
  exit 0
fi

RUN_L0=1; RUN_L1=1
case "${1:-}" in
  --l0) RUN_L1=0 ;;
  --l1) RUN_L0=0 ;;
  "")   ;;
  *)    fail "unknown arg: $1"; exit 2 ;;
esac

START=$(date +%s)
FAILED=0

if [[ $RUN_L0 -eq 1 ]]; then
  sec "L0 — bun test (代码视角，单测)"
  if ! command -v bun >/dev/null; then
    fail "bun not installed; skip L0. Install: curl -fsSL https://bun.sh/install | bash"
    FAILED=$((FAILED+1))
  else
    for entry in "${L0_TESTS[@]}"; do
      name="${entry%%:*}"; path="${entry#*:}"
      # Route db.ts schema bootstrap to a fresh throwaway file. Tests that
      # call register() depend on a clean DB to avoid 'username already
      # taken' on rerun (auth-validate). Cleared by removing before each run.
      rm -f /tmp/qa-l0-$name.db
      if (cd server && COMMHUB_DB=/tmp/qa-l0-$name.db bun test "${path#server/}" \
            >/tmp/qa-l0-$name.log 2>&1); then
        ok "L0 $name"
      else
        fail "L0 $name — see /tmp/qa-l0-$name.log"
        FAILED=$((FAILED+1))
      fi
    done
  fi
fi

if [[ $RUN_L1 -eq 1 ]]; then
  sec "L1 — Docker contract tests (用户视角，并行)"
  pids=()
  declare -A pid_to_test
  for t in "${L1_TESTS[@]}"; do
    # Build (cached if recent)
    note "build $t"
    if ! dockerrun "docker build -q -t anet-$t -f tests/$t/Dockerfile ." >/tmp/qa-l1-$t-build.log 2>&1; then
      fail "L1 $t — build failed, see /tmp/qa-l1-$t-build.log"
      FAILED=$((FAILED+1))
      continue
    fi
    # Run in background
    (dockerrun "docker run --rm anet-$t" >/tmp/qa-l1-$t-run.log 2>&1) &
    pid=$!
    pids+=("$pid")
    pid_to_test["$pid"]="$t"
  done

  for pid in "${pids[@]}"; do
    t="${pid_to_test[$pid]}"
    if wait "$pid"; then
      ok "L1 $t ($(tail -1 /tmp/qa-l1-$t-run.log))"
    else
      fail "L1 $t — see /tmp/qa-l1-$t-run.log"
      tail -10 /tmp/qa-l1-$t-run.log | sed 's/^/    /'
      FAILED=$((FAILED+1))
    fi
  done
fi

ELAPSED=$(( $(date +%s) - START ))
echo
if [[ $FAILED -eq 0 ]]; then
  ok "ALL PASS in ${ELAPSED}s"
  exit 0
else
  fail "$FAILED test(s) failed in ${ELAPSED}s"
  exit 1
fi
