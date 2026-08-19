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
  "rest-write-scope:server/src/rest-write-network-resolution.test.ts"
  # observer-avatar-http.test.ts 不进 L0：它启真 HTTP server，import 链需要
  # MCP SDK，而 CI 的 L0 层按设计不跑 bun install（ms 级零依赖预算）。
  # 它的 CI 归属是会安装依赖的层级；本地跑法见该文件头注释的门禁命令。
)
L1_TESTS=(
  # 这道闸门自己的回归。放在最前:它跑的是本脚本,若闸门坏了应当最先暴露。
  # (注册这一步不是可选的 —— 一个没被任何东西调用的套件等于不存在。)
  "test823-l1-concurrency-cap"
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
  # 2026-08-19 补注册。它一直是孤儿(docs/test-suite-orphan-baseline.txt),
  # 而在此之前套件里有 3 处字面量随一次改名过期(#1072):1 条 production grep
  # 0 命中、2 条变异锚点 0 命中 ⇒ 变异是 no-op。修好之后它有三条成立的见证红,
  # 才够格进这里 —— **先让它真的能红，再让 CI 跑它**。
  # 按 qa.sh 的真实调法(docker run --rm，不挂 /artifacts)实测 rc=0。
  "test236-dashboard-codex-goal"
  # 2026-08-19 补注册。孤儿，但它本来就够格:两条 sed 变异后面都紧跟
  # `grep -F '<变异后形态>' … >/dev/null`(锚点过期会当场红,而不是让变异变成 no-op),
  # 且 :23-25 拿 resolver 的输出和【真实已安装的 SDK 版本】比,不是自证。
  # 按 qa.sh 的真实调法(docker run --rm,不挂 /artifacts)实测 rc=0 pass=5 fail=0,
  # 两条见证红都成立。耗时 build 105s + run 2s。
  "test657-claude-native-version-pin"
  # 2026-08-19 补注册。它之前是孤儿里 sed 最多(4 条)、也是唯一一处守卫都没有的，
  # 所以 #1078 那轮我**没有**先接它 —— 先接只会把「有覆盖」的假象固定下来。
  # #1079 补上 assert_mutated 之后才够格(那四条不能用 grep 写法:第 1 条变异后的形态
  # 是原文的子串、后两条是删行，所以只能比对文件有没有变)。
  # 按 qa.sh 真实调法(docker run --rm，不挂 /artifacts)实测 rc=0 RESULT pass=14 fail=0，
  # 四条见证红全成立；耗时 build 104s + run 39s(L1 里较重的一个)。
  "test654-dashboard-managed-launch"
  # 2026-08-19 补注册。它此前是孤儿**而且在 main 上就是红的** ——
  # `[[ "$SDK_VERSION" == 0.3.226 ]]` 是逐字相等，而 package.json 是 `^0.3.226`、
  # 本套件 Dockerfile 不拷 lockfile ⇒ 解析到当时最新的 0.3.x，上游发到 0.3.235 就红。
  # #1082 改成地板之后才够格（先修红、再登记）。
  # 实测（按 qa.sh 真实调法 docker run --rm，不挂 /artifacts）：rc=0 RESULT pass=8 fail=0。
  # 🔴 耗时按**冷构建**记：build 107s + run 33s = 140s（warm 只有 37s，会误导）。
  # 推算：L1 24 条=3.50min → 25 条=5.32min；再加这个同量级的 ≈7min，
  # 在 qa.yml:414 那个 10 分钟守卫内（那个守卫上一轮刚从 5 调到 10，原因见该处注释）。
  "test656-claude-sdk-tool-aliases"
  # 2026-08-19 补注册这三个纯单元套件。它们一直是孤儿 ——
  # 61 条测试（19+19+23）此前不被任何 CI 跑到，而内容偏安全（token 生成/口令字典/认证校验）。
  # 极便宜：各 build 2s + run 1~2s，没有 apt/install。
  # 🔴 登记前先给它们补了 ARG SOURCE_COMMIT —— 原来三个都没有，
  #   qa.sh 会在【没有 SHA 绑定】的情况下跑它们，而输出看起来一切正常
  #   （这正是本文件上面那段注释警告过的形状）。绑了还让它们把 source_commit 打进输出。
  "qa-ut-01-auth-tokens"
  "qa-ut-02-password-dict"
  "qa-ut-03-auth-validate"
  # 2026-08-19 补注册。它此前是孤儿**而且在 main 上就是红的**，而且红得**完全没有输出**：
  # 变异存活时那句裸的 `test "$X_rc" -ne 0` 在 set -e 下静默终止（#1096 让它说话），
  # 说出来才发现是真覆盖洞：getUserAllNetworks() 的两条可达路径一条都没被测到（#1097 补上）。
  # 三条见证红现在全部成立；按 qa.sh 真实调法实测 rc=0，build 3s + run 5s（很便宜）。
  "test647-rest-explicit-columns"
  # 2026-08-19 补注册这两个。它们此前是孤儿，**而且在干净检出上是红的**：
  #   error: Could not resolve: "zod" ... at /agent-node-src/src/commhub-mcp.ts:31:19
  # 根因不在测试逻辑，在 Dockerfile —— COPY 了 agent-node 源码却没 bun install。
  # 🔴 它们之所以以前看着能过：仓里没有 .dockerignore，构建上下文会把开发者本地的
  #    agent-node/node_modules 一起 COPY 进去 ⇒ 绿是【借来的】，取决于跑的人
  #    有没有在本地 bun install 过。在干净检出／CI runner 上必红。
  # 本 PR 给两个 Dockerfile 补了 `bun install --frozen-lockfile`，
  # 干净 worktree（确认无 agent-node/node_modules）+ --no-cache 实测：
  #   修前 run rc=1（zod 无法解析）→ 修后 run rc=0（OVERALL: PASS，各 34 expect）
  # 便宜：build 含 bun install，run ~1s。
  "test230-opencode-sender-label"
  "test228-opencode-inbox-concurrency"
  # 2026-08-19 补注册。它此前是孤儿**且在 main 上是红的**，而红因有三层，
  # 全部是「产品前进、套件写在它之前」，一条回归都没有：
  #   ① #203 身份守卫（server/src/tools.ts 的 alias_identity_mismatch）——
  #      产品**有意移除**了「ntok 用旧别名铸造、report_status 报新别名会被调和」这个行为，
  #      理由写在守卫注释里：漂移的 ALIAS 会改写 api_tokens.name，导致此后该 token
  #      的每一次 send_task 都被归到漂移别名上（#203 现象：grokB 的发送显示成 from=grokA）。
  #   ② alias_not_found（tools.ts:411）：套件往【从未注册过】的 总指挥 发消息。
  #      这一层之前发现不了，因为它在 ① 就死了。
  # 🔴 修法是**倒过来断言现在真实存在的边界**，不是把断言删掉：
  #   漂移别名必须被 alias_identity_mismatch 拒绝（#203 那道守卫此前**无人覆盖**）
  #   ＋ 正控（换成绑定别名必须成功）＋ 原有的 from_session 防冒充断言一条没少（只是两侧对调）。
  # 见证红：把漂移那次改用绑定别名 ⇒ 那条断言变红
  #   FAIL: drifted alias was NOT rejected by the #203 guard, got: {"ok":true,...}
  "test198-from-alias"
  # 2026-08-20 补注册。它此前是孤儿**且在 main 上是 4 passed / 4 failed**，
  # 红因共 6 层，**没有一条是回归** —— 全是产品前进、套件写在它之前：
  #   ① 脚本全程用 master token（server/src/server.ts:169-170 已废弃它的写操作）
  #   ② 我修 ① 时只改了两个 helper，**漏了内联的 SSE curl**（同一规则的第三个调用点）
  #   ③ agent-node 自己读 /root/.anet/config.json，里面也是 master token
  #   ④ utok_ 没有隐式 network，四类调用点都要显式带（含 SSE URL —— 我又漏过一次，
  #      因为我数的是「认证头」，而 network 作用域落在**另一组端点**上）
  #   ⑤ 节点注册要 **ntok_**（app-level rejection: network_token_required），
  #      且按 #203 其 node_name 必须与别名一致
  #   ⑥ --runtime http-api 已移出 agent-node 白名单（同 #1112③）
  # 🔴 修法方向是**加断言不是减断言**：8 → 13 条，其中 3 条是新增的负向/边界断言
  #   （master token 写操作必须 401 · utok_ 调 report_status 必须 network_token_required
  #     · ntok_ 铸造别名一致）。
  # 干净 worktree + --no-cache 实测：修前 4 passed/4 failed → 修后 **13 passed/0 failed**。
  "test8-runtime"
  # 2026-08-19 批量补注册这 7 个。全部按 qa.sh 的真实调法（docker run --rm，不挂 /artifacts）
  # 实测 rc=0；本机耗时（build+run）：
  #   test652 3+4s · test653 8+4s · test-goal-cli 21+2s · test702 23+33s
  #   test584 23+55s · test696 93+5s · test520-dashboard-attachment-read 134+21s
  # 🔴 其中 test520-dashboard-attachment-read 与 test-goal-cli 原来**没有 ARG SOURCE_COMMIT**，
  #    本 PR 一并补上（同 #1094 的形态：ARG/ENV 放 ENTRYPOINT 之前 + run.sh 里打印）。
  # ⚠️ 一次加 7 个会让 L1 变慢。上一次我因为拿一个**被超时截断的观测**去外推而估错过
  #    （#1092 那轮：25 条 5.32min 是斧头落下的位置，不是完成时间），所以这次不外推，
  #    直接看本 PR 上 L0+L1 job 的实测时长再决定要不要拆批。守卫是 qa.yml:414 的 10 分钟。
  "test520-dashboard-attachment-read"
  "test584-dashboard-codex-delivery"
  "test-goal-cli"
  "test652-admin-network-list"
  "test653-batch-workdir"
  "test696-human-low-value-reply"
  "test702-primary-network"
  # 2026-08-19 补注册。它此前是孤儿**而且在 main 上就是红的**，
  # 而红的表面原因（逐字计数 16 vs 17）底下藏着一道**恒真的门**：
  # WEAK_COUNT 的正则对真实文件命中 0 行，那句
  # "docker-e2e has no weak grep-ok assertions" 永远不可能红（#1088 修）。
  # 修好之后 rc=0、weak_assertions=14（真实值），才够格接进来。
  "test292-e2e-ok-assertions"
  # 2026-08-18 补注册 —— 这四个是 #863 修好的那批(commit 61f7203a,「静默失效 6 周」
  # 实跑 4/4 从红到绿),但修完之后**没有注册到任何地方**,于是回到了同一个位置:
  # 没有任何东西会跑它们。#861 的实测把最后一个未知量补上了。
  #
  # 实测(通信IM马,隔离 tree,顺序 build+run):
  #   warm cache   10:7+6  11:1+3  12:1+4  13:7+6   合计 35s
  #   🔴 warm 是误导 —— 四个共享 node:20-slim + apt + bun.sh + `bun install server/`
  #      的层。单独用 --no-cache 测 qa-hub-10 是 **22s**(比 warm 的 7s 多 15s)。
  #      CI 冷跑的形状是「第一个 ~22s,后 3 个各 1-7s,4 个 run 合计 19s」⇒ 约 44-50s。
  #   L0+L1 job 近 4 次 main 实测 137-165s / 预算 300s ⇒ 加完约 181-215s,余 85-119s。
  #
  # 依赖:这四个**不需要活 hub、不需要外网、不需要凭据**。每个 run.sh 自己在
  # loopback 上起 hub(端口 9210/9211/9212/9213 写死互不撞),跑完 trap kill 掉自己的
  # HUB_PID。run 阶段完全离网;build 阶段要外网(bun.sh + apt),与既有套件同形。
  "qa-hub-10-network-scope-regressions"
  "qa-hub-11-node-delete-sse"
  "qa-hub-12-servers-endpoint"
  "qa-hub-13-server-health-agents"
  "qa-node-02-success-reply"
  "qa-node-03b-task-events"
  "test686-rest-shape-golden"
  "test765-batch-runtime-gate"
  "test766-bunx-preflight"
  "test746-setup-bun-pin"
  # 2026-08-13 扫出三个从没进 CI 的完整 Docker 门(test224 / test597 / test679),
  # 一度想加在这里,但 L1 是「~16s 并行」的快层、job 预算 5 分钟,实测在 CI 上
  # 已经用掉 141–148s;而 qa.sh 的 build 是**串行**的(只有 docker run 并行),
  # 那三个套件单跑就要 39s / 15s / 36s,还要各加一次 build(test679 带
  # javascript-obfuscator)。塞进来是拿余量赌。
  # 它们改放在 qa.yml 的独立 job(预算 12 分钟),同单测门的形状。
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
  # 🔴 必须先校验再用。下面的闸门条件是 `[[ "$QA_L1_MAX_PAR" -gt 0 ]]`,而 bash
  # 在算术上下文里把非数字当 0 —— 而 0 的语义恰好是「不限」。于是一个笔误
  # (`QA_L1_MAX_PAR=two`、`=4x`)会**静默恢复本节要消除的无上限行为**,
  # 而下面那行 note 还会照打「L1 并发上限 = two」,输出主动确认一个不存在的上限。
  # 这里 fail-closed:值不合法就退回默认,并大声说出来。
  if [[ ! "$QA_L1_MAX_PAR" =~ ^[0-9]+$ ]]; then
    _bad="$QA_L1_MAX_PAR"
    QA_L1_MAX_PAR="$(nproc 2>/dev/null || echo 4)"
    note "⚠ QA_L1_MAX_PAR='${_bad}' 不是非负整数 —— 已退回默认 ${QA_L1_MAX_PAR}(否则闸门会静默失效)"
  fi
  # 全数字还不够:bash 把前导零当八进制,`[[ "08" -gt 0 ]]` 会报
  # `value too great for base` 并返回非零 —— 闸门照样静默失效。
  # 这个洞是写完上面那段校验之后、跑对照表时才发现的(用例里放了 08)。
  QA_L1_MAX_PAR=$((10#$QA_L1_MAX_PAR))
  note "L1 并发上限 = ${QA_L1_MAX_PAR}(0 = 不限;用 QA_L1_MAX_PAR 覆盖)"
  pids=()
  declare -A pid_to_test
  for t in "${L1_TESTS[@]}"; do
    # Build (cached if recent)
    note "build $t"
    # build-arg 的名字**从套件自己的 Dockerfile 里读**,不靠套件名推导 ——
    # 硬编码 if/elif 链的失效方式是静默的:把套件加进 L1_TESTS 却忘了加分支,
    # 它会在**没有 SHA 绑定**的情况下跑,而输出看起来一切正常。
    # 等价性已核:对原链覆盖的 test686/765/766/746 四个套件,推导结果与硬编码
    # 逐字相同;test224/test597 用的是不带前缀的 ARG SOURCE_COMMIT,
    # 正是原链无法表达、只能再加分支的那种形状。
    #
    # 🔴 `|| true` 不是装饰:本脚本是 set -euo pipefail,而多数套件的 Dockerfile
    # 根本没有 ARG SOURCE_COMMIT —— grep 无命中退 1,pipefail 把它传给整个
    # 命令替换,set -e 于是在第一个这样的套件上把 runner 打死。
    # 第一版就是这么挂的:CI 在 `build qa-cli-01-hub-start` 处 exit 1,
    # 一个套件都没跑成,而失败看起来像「L1 挂了」而不是「参数推导写错了」。
    build_args=""
    arg_name=$(grep -oE '^ARG (SOURCE_COMMIT|TEST[0-9]+_SOURCE_COMMIT)' \
      "tests/$t/Dockerfile" 2>/dev/null | head -1 | awk '{print $2}' || true)
    # 🔴 git 调用必须是非致命的。test823 会在一个**只装了 bash/coreutils/procps、
    # 没有 git** 的容器里重放这个脚本(它桩了 docker 和 npm,但没桩 git)。
    # 直接写 $(git rev-parse HEAD):容器里 git 不存在 → 127 → set -e 当场中断
    # → docker 桩一次都没被调用 → 峰值恒为 0 → 闸门自己的回归「通过」得毫无意义。
    _qa_sha="$(git rev-parse HEAD 2>/dev/null || true)"
    if [[ -n "$arg_name" && -n "$_qa_sha" ]]; then
      build_args="--build-arg $arg_name=$_qa_sha"
    fi
    # blob 绑定:光验 SOURCE_COMMIT 的格式不够(任何 40 位十六进制都能过,
    # 而那个 SHA 可能根本不含镜像里被测的文件)。套件的 Dockerfile 声明了
    # ARG RUNSH_BLOB 时才供给 —— 同样从 Dockerfile 读,不猜。
    if grep -qE '^ARG RUNSH_BLOB' "tests/$t/Dockerfile" 2>/dev/null; then
      _qa_blob="$(git rev-parse "HEAD:tests/$t/run.sh" 2>/dev/null || true)"
      [ -n "$_qa_blob" ] && build_args="$build_args --build-arg RUNSH_BLOB=$_qa_blob"
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
    # 注意:这里**不能**用 `$(jobs -rp | wc -l)` —— 它在这个位置**系统性少数**,
    # 于是上限 N 实际表现成 N+1/N+2。实测过:用 jobs 版本、上限设 2,
    # `docker ps` 采到的 anet-* 峰值仍是 3。
    #
    # 合并时复核了一次这条注释的**机制**部分(bash 5.2.21,脚本非交互):
    # 原文写「数出来恒为 0」——不准确。同样的循环里采样序列是
    # `0 1 1 1 0 1 0 1`:它**不是恒 0,而是从来到不了上限值**,
    # 所以 `(( n < MAX ))` 永远为真、闸门永远放行。
    # 结论和修法都不变(少数就够坏了),但机制说清楚一点,免得下一个人
    # 照着「恒为 0」去排查,发现不是 0 就以为这条注释过时了。
    # 改成在父 shell 里用 kill -0 数还活着的 pid —— 它数的是进程本身,
    # 不依赖 shell 的作业表。
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
