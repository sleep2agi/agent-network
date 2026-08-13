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
  QA_L1_MAX_PAR="${QA_L1_MAX_PAR:-$(nproc 2>/dev/null || echo 4)}"
  note "L1 并发上限 = ${QA_L1_MAX_PAR}(0 = 不限;用 QA_L1_MAX_PAR 覆盖)"
  pids=()
  declare -A pid_to_test
  for t in "${L1_TESTS[@]}"; do
    # Build (cached if recent)
    note "build $t"
    build_args=""
    if [[ "$t" == "test686-rest-shape-golden" ]]; then
      build_args="--build-arg TEST686_SOURCE_COMMIT=$(git rev-parse HEAD)"
    elif [[ "$t" == "test765-batch-runtime-gate" ]]; then
      build_args="--build-arg TEST765_SOURCE_COMMIT=$(git rev-parse HEAD)"
    elif [[ "$t" == "test766-bunx-preflight" ]]; then
      build_args="--build-arg TEST766_SOURCE_COMMIT=$(git rev-parse HEAD)"
    elif [[ "$t" == "test746-setup-bun-pin" ]]; then
      build_args="--build-arg TEST746_SOURCE_COMMIT=$(git rev-parse HEAD)"
    fi
    if ! dockerrun "docker build -q $build_args -t anet-$t -f tests/$t/Dockerfile ." >/tmp/qa-l1-$t-build.log 2>&1; then
      fail "L1 $t — build failed, see /tmp/qa-l1-$t-build.log"
      FAILED=$((FAILED+1))
      continue
    fi
    # Run in background —— 但要有并发上限。
    #
    # 原来这里是无节制后台化:L1_TESTS 有多少条,就同时拉起多少个容器。
    # 在专用 CI runner 上没问题;在开发/生产共用的机器上不行 ——
    # 实测本机(8 核,同时跑着生产 hub、dashboard 与 ~200 个 agent session)
    # 一次 `qa.sh --l1` 把 load1 顶到 58,即 7.3x 超订。
    #
    # 默认上限取 nproc(而不是更激进的 nproc/2),因为要同时满足两件事:
    # 在小核 CI runner 上尽量不拖慢现有耗时,在大核共享机上把超订压下来。
    # 需要时用 QA_L1_MAX_PAR 覆盖;设成 0 表示不限(恢复旧行为)。
    # 注意:这里**不能**用 `$(jobs -rp | wc -l)` —— 命令替换会开子 shell,
    # 而 `jobs` 的作业表不跨子 shell 继承,那样数出来恒为 0、闸门形同虚设。
    # 实测过:用 jobs 版本、上限设 2,`docker ps` 采到的 anet-* 峰值仍是 3。
    # 改成在父 shell 里用 kill -0 数还活着的 pid。
    while [[ "$QA_L1_MAX_PAR" -gt 0 ]]; do
      live=0
      for _p in "${pids[@]:-}"; do
        [[ -n "$_p" ]] && kill -0 "$_p" 2>/dev/null && live=$((live+1))
      done
      (( live < QA_L1_MAX_PAR )) && break
      sleep 0.2
    done
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
