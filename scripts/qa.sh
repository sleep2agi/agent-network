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
  # observer-avatar-http.test.ts 不进 L0：它启真 HTTP server，import 链需要
  # MCP SDK，而 CI 的 L0 层按设计不跑 bun install（ms 级零依赖预算）。
  # 它的 CI 归属是会安装依赖的层级；本地跑法见该文件头注释的门禁命令。
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
  "test686-rest-shape-golden"
  "test765-batch-runtime-gate"
  "test766-bunx-preflight"
  "test746-setup-bun-pin"
  # 下面三个是 2026-08-13 扫出来的:形状完整的 Docker 门(Dockerfile + run.sh
  # + 自己的 mutation),但从没被注册进 L1_TESTS,所以一直没人跑。
  # 本地实测三个都 PASS(39s / 15s / 36s;L1 是并行跑的)。
  "test224-grok-preview-security"
  "test597-dashboard-slash-namespace"
  "test679-task-trace"
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

  # L1 的多数用例在容器里 `npm install -g @sleep2agi/<pkg>@preview`,也就是说
  # 它们测的是【此刻 registry 上 preview 指向什么】,不是【这个 commit 是什么】。
  #
  # 后果实测过(#726):main 在 bec372c8 上 L1 全绿;之后没有任何 commit 变动,
  # 只因为有人发布了新的 preview,同一份代码的 L1 就红了。反方向同样成立 ——
  # 一个真把东西改坏的 PR,只要 @preview 还指着旧的好版本,它照样能绿。
  #
  # 把三个包此刻解析到的版本记下来,这样任何一次红都能立刻区分
  # 「代码改坏了」还是「registry 动了」。这里【只记录不改行为】——
  # 是否改成钉死版本涉及 49 个测试文件的语义,留给单独决定。
  {
    echo "L1 registry snapshot @ $(date -u +%FT%TZ)"
    for pkg in agent-network agent-node commhub-server; do
      v=$(npm view "@sleep2agi/$pkg" dist-tags.preview 2>/dev/null || echo "?")
      echo "  @sleep2agi/$pkg@preview -> $v"
    done
  } | tee /tmp/qa-l1-registry-snapshot.txt
  pids=()
  declare -A pid_to_test
  for t in "${L1_TESTS[@]}"; do
    # Build (cached if recent)
    note "build $t"
    # 从套件自己的 Dockerfile 推导 SOURCE_COMMIT 参数名,而不是维护一条硬编码
    # 的 if/elif 链 —— 链的失效方式是静默的:把套件加进 L1_TESTS 却忘了加分支,
    # 它会在**没有 SHA 绑定**的情况下跑,而输出看起来一切正常。
    # 等价性已核:对原链覆盖的 test686/765/766/746 四个套件,推导结果与硬编码
    # 逐字相同;新加的 test224/test597 用的是不带前缀的 ARG SOURCE_COMMIT,
    # 正是原链无法表达、只能再加分支的那种形状。
    build_args=""
    # `|| true` 不是装饰:本脚本是 set -euo pipefail,而多数套件的 Dockerfile
    # 根本没有 ARG SOURCE_COMMIT —— grep 无命中退 1,pipefail 把它传给整个
    # 命令替换,set -e 于是在第一个这样的套件上把 runner 打死。
    # 第一版就是这么挂的:CI 在 `build qa-cli-01-hub-start` 处 exit 1,
    # 一个套件都没跑成,而失败看起来像「L1 挂了」而不是「参数推导写错了」。
    arg_name=$(grep -oE '^ARG (SOURCE_COMMIT|TEST[0-9]+_SOURCE_COMMIT)' \
      "tests/$t/Dockerfile" 2>/dev/null | head -1 | awk '{print $2}' || true)
    if [[ -n "$arg_name" ]]; then
      build_args="--build-arg $arg_name=$(git rev-parse HEAD)"
    fi
    if ! dockerrun "docker build -q $build_args -t anet-$t -f tests/$t/Dockerfile ." >/tmp/qa-l1-$t-build.log 2>&1; then
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
