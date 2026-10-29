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
  # app#225 —— 节点规则文件(CLAUDE.md/AGENTS.md)读写的安全边界:只依赖 node 内置模块,
  # 无需 bun install,ms 级。hub 侧那半在 server/src/rules-file-transport.test.ts,
  # 由 test798(server unit)按 find *.test.ts 自动收进去。
  "rules-file:agent-node/src/runtime/rules-file.test.ts"
  # observer-avatar-http.test.ts 不进 L0：它启真 HTTP server，按 ms 级预算不属于这一层。
  # 它的 CI 归属是 server unit 那一层；本地跑法见该文件头注释的门禁命令。
  # 🔴 #466:CI 的 L0 job 在跑本脚本之前会 `bun install --frozen-lockfile`(server/)——
  #    L0 的测试 import server/src,而 db.ts 的 import 链会长(#2247 起经 node-health-store 带上 zod)。
  #    本地跑 --l0 之前同样先装:(cd server && bun install --frozen-lockfile)。
)
# #675 —— L1 套件改为**按目录登记**：每个进 L1 的套件自己放一个空标记文件
# tests/<套件名>/qa.l1，这里用 glob 收齐并按名字排序。
#
# 为什么不再用共享数组：并行 PR 每次都在同一段列表里插一行，冲突不断
# （#2456/#2463 就是这样撞的）。按目录登记后，新增套件只要在自己目录里加一个
# 空文件，不再触碰共享名单，并行 PR 之间也就不会为同一行打架。
# 每条套件原来的说明（board 引用等）已经搬进各自目录的 qa.l1 里，就近可读。
#
# 只收 tests/*/qa.l1 —— 不是收所有 tests/*/run.sh：孤儿基线是**故意**留在 L1 外面的。
L1_TESTS=()
while IFS= read -r _marker; do
  L1_TESTS+=("$(basename "$(dirname "$_marker")")")
done < <(find "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests" -mindepth 2 -maxdepth 2 -name qa.l1 | sort)


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

# docs-only PR 的轻量路径:qa.yml 的 changes job(.github/scripts/ci-docs-only.py)
# 只把「镜像里有 docs-site」的 L1 套件放进 QA_L1_ONLY。空/未设 = 全部 L1。
# 名字必须逐字在 L1_TESTS 里（#675 起 = tests/<名字>/qa.l1 存在）—— 拼错一个不是「少跑一个」,是红。
if [[ -n "${QA_L1_ONLY:-}" ]]; then
  _l1_keep=()
  for _t in $QA_L1_ONLY; do
    _hit=0
    for _u in "${L1_TESTS[@]}"; do [[ "$_u" == "$_t" ]] && _hit=1; done
    if (( ! _hit )); then fail "QA_L1_ONLY: $_t 不在 L1_TESTS 里"; exit 2; fi
    _l1_keep+=("$_t")
  done
  note "QA_L1_ONLY: 只跑 ${#_l1_keep[@]}/${#L1_TESTS[@]} 个 L1 套件(docs-only PR)"
  L1_TESTS=("${_l1_keep[@]}")
fi

# #2800 —— L1 分片：墙钟地板是「L0+L1 单个 job 跑 66 个套件 25.8 分钟」，
# 并行度再高也压不下去。这里按索引取模切片，由 qa.yml 的 matrix 传 QA_L1_SHARD=i/n。
# 判据：各分片并集 == 全集（顺序无关），且每片至少 1 个套件。
if [[ -n "${QA_L1_SHARD:-}" ]]; then
  if [[ ! "$QA_L1_SHARD" =~ ^([0-9]+)/([0-9]+)$ ]]; then
    fail "QA_L1_SHARD 格式应为 i/n（例 1/3），收到: $QA_L1_SHARD"; exit 2
  fi
  _i=${BASH_REMATCH[1]}; _n=${BASH_REMATCH[2]}
  if (( _n < 1 || _i < 1 || _i > _n )); then
    fail "QA_L1_SHARD 越界: $_i/$_n"; exit 2
  fi
  _l1_shard=(); _idx=0
  for _t in "${L1_TESTS[@]}"; do
    if (( _idx % _n == _i - 1 )); then _l1_shard+=("$_t"); fi
    _idx=$((_idx+1))
  done
  if (( ${#_l1_shard[@]} == 0 )); then
    fail "QA_L1_SHARD=$_i/$_n 分到 0 个套件（总数 ${#L1_TESTS[@]}）"; exit 2
  fi
  note "QA_L1_SHARD=$_i/$_n: 本片 ${#_l1_shard[@]}/${#L1_TESTS[@]} 个 L1 套件"
  L1_TESTS=("${_l1_shard[@]}")
fi

# #2871 —— 单个 L1 套件的 build 命令，**唯一来源**。
# 预构建阶段与主循环都必须调它：任何一边复制一份命令字符串，都会让两边悄悄分叉。
# （2026-10-28 踩过：预构建漏了 $build_args，而它装着 SOURCE_COMMIT —— 那是 provenance 门的输入。）
_qa_l1_build_cmd() {
  local t="$1" build_args="" arg_name _qa_sha _qa_blob _heavy
  arg_name=$(grep -oE '^ARG (SOURCE_COMMIT|TEST[0-9]+_SOURCE_COMMIT)' "tests/$t/Dockerfile" 2>/dev/null | head -1 | awk '{print $2}' || true)
  _qa_sha="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$arg_name" && -n "$_qa_sha" ]]; then
    build_args="--build-arg $arg_name=$_qa_sha"
    _qa_blob="$(git rev-parse "HEAD:tests/$t/run.sh" 2>/dev/null || true)"
    [ -n "$_qa_blob" ] && build_args="$build_args --build-arg RUNSH_BLOB=$_qa_blob"
  fi
  case "$t" in
    test8-runtime|test1203-btw-production-e2e) _heavy=1 ;;
    *) _heavy=0 ;;
  esac
  if [[ "$_heavy" == "1" && "${QA_BUILDX_CACHE:-0}" == "1" ]] && docker buildx version >/dev/null 2>&1; then
    printf 'docker buildx build --load %s --cache-from type=gha,scope=l1h-%s --cache-to type=gha,mode=min,scope=l1h-%s -t anet-%s -f tests/%s/Dockerfile .' \
      "$build_args" "$t" "$t" "$t" "$t"
  else
    printf 'docker build -q %s -t anet-%s -f tests/%s/Dockerfile .' "$build_args" "$t" "$t"
  fi
}

START=$(date +%s)

# #2871 —— 可选并行预构建（默认关闭；QA_L1_BUILD_PAR<=1 时这段完全不执行）。
# build 占了 L1 墙钟的 90%（实测 shard1 344/384s、shard2 496/549s），而它是串行 for。
# 这里先用同一个 _qa_l1_build_cmd 并行构建，主循环凭 /tmp/qa-l1-<t>-prebuilt 跳过 build。
# 失败语义：预构建失败的套件**不写标记**，主循环会照常再串行构建一次并在那里报错 ——
# 也就是最坏情况退化成今天的行为，不会因为并行而少报错。
_l1_bpar="${QA_L1_BUILD_PAR:-1}"
if [[ "$_l1_bpar" =~ ^[0-9]+$ ]] && (( _l1_bpar > 1 )); then
  note "L1 预构建并发 = ${_l1_bpar}（QA_L1_BUILD_PAR）"
  rm -f /tmp/qa-l1-*-prebuilt
  : > /tmp/qa-l1-prebuild.log
  _pb0=$SECONDS
  for _pt in "${L1_TESTS[@]}"; do
    while (( $(jobs -rp | wc -l) >= _l1_bpar )); do wait -n 2>/dev/null || true; done
    (
      _pcmd="$(_qa_l1_build_cmd "$_pt")"
      if eval "$_pcmd" >"/tmp/qa-l1-$_pt-build.log" 2>&1; then
        touch "/tmp/qa-l1-$_pt-prebuilt"
      else
        printf '%s\n' "$_pt" >> /tmp/qa-l1-prebuild.log
      fi
    ) &
  done
  wait
  note "L1 预构建完成，用时 $(( SECONDS - _pb0 ))s；失败 $(wc -l < /tmp/qa-l1-prebuild.log) 个（主循环将串行重试）"
fi
FAILED=0

# 🔴 启动时清掉**上一轮**的日志。复用的 runner 上,`/tmp/qa-l0-*.log` 与
#    `/tmp/qa-l1-*-run.log` 会留在原地,而 `check-test-margin.py` 的 hook 按
#    glob 读它们 ⇒ 报告里的 `tests=`/`near=`/`slowest=` 会描述**本次没跑**的
#    套件(比如 `QA_L1_ONLY` 只跑 docs-only 子集时),跨 run 对照就没意义了。
#    在这里清一次,那行 glob 就是本轮的(顺序:必须早于下面的 hook)。
rm -f /tmp/qa-l0-*.log /tmp/qa-l1-*-run.log

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
      # 按路径首段进对应的包目录跑(server / agent-node / agent-network):bun test
      # 只在当前包里找文件,从 server/ 里传一个 agent-node/... 路径会被当成
      # 过滤器,匹配 0 个文件而报错(app#225 那条 L0 在 CI 首跑就是这么红的)。
      pkg="${path%%/*}"
      if (cd "$pkg" && COMMHUB_DB=/tmp/qa-l0-$name.db bun test "${path#$pkg/}" \
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

# 🔴 #1593 —— 单个 L1 套件的 wait 硬超时(秒)。见下面 wait 处的长注释。
#    默认 300 = L1 最慢套件(test823-l1-concurrency-cap, 125s)的 2.4 倍。
#    只接受纯数字;写坏了就退回默认,**不让一个笔误把超时变成 0**(0 会让看门狗
#    立刻杀掉每一个套件,而那个失效读起来像"所有套件都挂了")。
L1_WAIT_TIMEOUT="${L1_WAIT_TIMEOUT:-300}"
case "$L1_WAIT_TIMEOUT" in
  ''|*[!0-9]*) L1_WAIT_TIMEOUT=300 ;;
esac
[ "$L1_WAIT_TIMEOUT" -lt 1 ] && L1_WAIT_TIMEOUT=300
note "L1 单套件 wait 超时 = ${L1_WAIT_TIMEOUT}s(用 L1_WAIT_TIMEOUT 覆盖)"
  note "L1 并发上限 = ${QA_L1_MAX_PAR}(0 = 不限;用 QA_L1_MAX_PAR 覆盖)"
  rm -f /tmp/qa-l1-timing.tsv
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
    _b0=$SECONDS
    _build="$(_qa_l1_build_cmd "$t")"
    if [[ -f "/tmp/qa-l1-$t-prebuilt" ]]; then
      # #2871 预构建阶段已成功（同一函数、同一条命令）⇒ 跳过 build
      rm -f "/tmp/qa-l1-$t-prebuilt"
      printf '· build done %s  [prebuilt]\n' "$t"
    elif ! dockerrun "$_build" >/tmp/qa-l1-$t-build.log 2>&1; then
      printf '· build fail %s  [%ss]\n' "$t" "$(( SECONDS - _b0 ))"
      fail "L1 $t — build failed, see /tmp/qa-l1-$t-build.log"
      FAILED=$((FAILED+1))
      continue
    fi
    printf '· build done %s  [%ss]\n' "$t" "$(( SECONDS - _b0 ))"
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
    # #1333: 每个套件记下**相对 L1 起点的开始/结束偏移**。
    #
    # 为什么记偏移而不只记时长:失败分析要回答的是「炸在第几分钟」——
    # 实测同一个 job 内 L0 时刻 CI/本机 ≈5.6x,而 L2 时刻至少 8.8x
    # (由「它撞了 5000ms hook 预算」反推)。也就是说**机器在一次 job 内越跑越慢**,
    # 只看时长看不出这条曲线,只有偏移能。
    #
    # 🔴 由子进程自己记,不在 wait 处记:`wait` 按 pids 数组顺序返回、
    #    **不按完成顺序**。在 wait 返回时取 date,先完成的套件会被记上
    #    「它前面那个慢套件的结束时刻」—— 数字看起来完全正常,只是错的。
    (
      _s=$(( $(date +%s) - START ))
      # 🔴 `|| _rc=$?` 不是风格,是这一行**唯一**能拿到非零 rc 的写法。
      #    本脚本第 17 行是 `set -euo pipefail`。写成
      #        dockerrun …
      #        _rc=$?
      #    时,`docker run` 一旦非零,**子 shell 在第一行就被 set -e 打死**,
      #    下面的 `_rc=$?`、TSV 落盘、`· L1 done … rc=%s` 一行都不会执行。
      #    于是:**失败的套件既没有 rc、也没有时间线**,而成功的两样都有。
      #
      #    实测(run 33301710195 / job 99231846024):该 job 打出 67 行 `· L1 done`,
      #    **rc 全部是 0**;而当次真正失败的 qa-dash-10-incremental-poll
      #    **一行 `L1 done` 都没有**。也就是说 `rc=%s` 这个占位符
      #    **在它被加进来之后,从来没有打印过 0 以外的值** —— 它只在不需要它的时候工作。
      #
      #    这正是本文件上面 #1333 那条注释说的那件事的另一半:
      #    「唯一需要这条时间线的场合,正是它打不出来的场合」——
      #    那条讲的是整个 job 被 30 分钟天花板 kill,而**每一次单套件失败也是**。
      _rc=0
      # Resource limits only. A suite may ship tests/$t/docker-run.args
      # (one flag per line). Mounts, network mode, and privileged stay rejected.
      _run_flags=(--rm)
      if [[ -f "tests/$t/docker-run.args" ]]; then
        while IFS= read -r _flag || [[ -n "${_flag:-}" ]]; do
          [[ -z "${_flag:-}" || "$_flag" == \#* ]] && continue
          case "$_flag" in
            --memory=[0-9]*|--memory-swap=[0-9]*|--cpus=[0-9]*) _run_flags+=("$_flag") ;;
            *) printf 'bad docker-run.args flag for %s: %s\n' "$t" "$_flag" >&2; exit 1 ;;
          esac
        done < "tests/$t/docker-run.args"
      fi
      _qa_run_flags=""
      if [[ "$t" == "test658-codex-adopt-stop" ]]; then _qa_run_flags="--init --cpus=2 --network none"; fi
      if [[ "$t" == "test674-binding-generation" ]]; then _qa_run_flags="--init --cpus=2 --network none"; fi
      if [[ "$t" == "test-agent-team-whoami" ]]; then _qa_run_flags="--init --cpus=2 --network none"; fi
      if [[ "$t" == "test703-codex-turn-receipts" ]]; then _qa_run_flags="--init --cpus=2 --network none"; fi
      if [[ "$t" == "test710-late-task-replies" ]]; then _qa_run_flags="--init --cpus=2 --network none"; fi
      _run_cmd="docker run"
      for _f in "${_run_flags[@]}"; do _run_cmd+=" ${_f}"; done
      _run_cmd+=" ${_qa_run_flags} anet-$t"
      dockerrun "$_run_cmd" >/tmp/qa-l1-$t-run.log 2>&1 || _rc=$?
      _e=$(( $(date +%s) - START ))
      printf '%s\t%s\t%s\n' "$t" "$_s" "$_e" >> /tmp/qa-l1-timing.tsv
      # 🔴 **完成即打印**,不要只留给结尾的汇总。
      #    2026-08-27 一次 L0+L1 顶到 30 分天花板被 kill(run 33126449082,1815s):
      #    18 个 build 起来了,而时间线**一行都没有** —— 因为汇总只在所有 wait 结束后才跑,
      #    而那一跑根本没走到那里。**唯一需要这条时间线的场合,正是它打不出来的场合。**
      #    (被 kill 的观测本身也只是下界:1815s 不是它跑完要多久,是它被杀时已经跑了多久。)
      printf '· L1 done %s  [L1+%ss..%ss, %ss] rc=%s\n' "$t" "$_s" "$_e" "$(( _e - _s ))" "$_rc"
      exit $_rc
    ) &
    pid=$!
    pids+=("$pid")
    pid_to_test["$pid"]="$t"
  done

  # #1333: 从子进程写的 TSV 里取每个套件的偏移。取不到就留空,不编数字。
  _l1_window() {
    local _t="$1" _line
    # 🔴 用 awk 精确比字段,不用 `grep -P "^\Q…\E\t"`:
    #    -P 和 \Q\E 是 GNU grep 扩展。本脚本会被 test823 在一个只装
    #    bash/coreutils/procps 的容器里重放(见本文件上面那条注释),那里未必有。
    #    退化行为是「安静地取不到时间」而不是报错,但那正是最难发现的一种坏 ——
    #    输出少了一段,谁也不会注意到。awk 是字段比较,不涉及正则方言。
    _line=$(awk -F'\t' -v t="$_t" '$1==t{last=$0} END{if(last)print last}' /tmp/qa-l1-timing.tsv 2>/dev/null || true)
    [ -z "$_line" ] && return 0
    local _a _b
    _a=$(printf '%s' "$_line" | cut -f2); _b=$(printf '%s' "$_line" | cut -f3)
    printf 'L1+%ss..%ss, %ss' "$_a" "$_b" "$(( _b - _a ))"
  }
  for pid in "${pids[@]}"; do
    t="${pid_to_test[$pid]}"
    _w=$(_l1_window "$t")
    # 🔴 #1593 —— 这一行只在「wait 挂住」时才有用,而那正是它存在的理由。
    #    实测两次(run 33486670271,同一 PR 连续两次):所有套件都打完
    #    `· L1 done … rc=0`,随后这个循环静默 15 分钟,直到 30 分钟守卫把 job 掐死,
    #    runner 收尾时打出 `Terminate orphan process: pid (bash)/(docker)` ——
    #    也就是说**有子进程不退出,而 wait 在等它**。当时日志里没有任何东西
    #    说得出「在等谁」,只能靠事后 diff 两份 30 分钟的日志去猜。
    #    打出正在等的那个套件名,下次红的时候第一行就能看见。
    printf '· L1 wait %s\n' "$t"
    # 🔴 #1593 —— 给这个 wait 加一道**硬超时**。
    #    实测(2026-09-01,同一天六次运行):test225-node-stop-convergence 正常
    #    59-63s 完成,挂起时让整个 job 耗满 30 分钟守卫被 cancel —— 差 30 倍。
    #    它不是"变慢",是**彻底不返回**,所以任何"比平时慢"的判据都抓不到它。
    #    代价还不止 30 分钟 runner:job 被守卫杀掉时,**另外 69 个套件的结果一起没了**。
    #
    #    阈值 300s 的依据:L1 里最慢的套件是 test823-l1-concurrency-cap(125s),
    #    300 是它的 2.4 倍 —— 用的是本文件上面那条注释里已经写明的原则
    #    (「timeout-minutes 是 runaway 守卫,不是性能预算,该在典型值的 2-3 倍」)。
    #
    # 🔴 为什么是看门狗而不是轮询 `kill -0`:
    #    bash 的后台子进程退出后、被 wait 收割前是**僵尸**,而 `kill -0` 对僵尸
    #    **仍然返回成功** ⇒ 轮询版会让每个套件都白等满 300s,把 14 分钟变成几小时。
    #    而那个失效**在本地测不出来**(本地跑得快,僵尸窗口极短),只会在 CI 上
    #    表现成"又打满守卫"——与它本要修的症状一模一样。
    # 🔴 2026-09-01 修我自己在 #1732 引入的泄漏:原写法是
    #        ( sleep "$L1_WAIT_TIMEOUT"; kill -9 "$pid" ) & _l1_wd=$!
    #    收尾 `kill "$_l1_wd"` 杀的是**子 shell**,而它阻塞在 sleep 上时
    #    那个 sleep 会被孤儿化 —— 实测:改动前 `Terminate orphan process` = 0,
    #    改动后 = **70**(= L1 套件数),全是 `(sleep)`,日志从 55K 涨到 352K。
    #    它不会让任何 job 变红,所以只能靠对比两份日志才看得见。
    #
    #    换成「标志文件 + 短 sleep 循环」:收尾 `rm -f` 之后看门狗 1 秒内自退,
    #    残留的 `sleep 1` 也会自己结束。本地两向见证(基线 6 个 sleep):
    #      快任务 rc=0   残留回到 6      ← 不误杀、不泄漏
    #      慢任务 rc=137 耗时=阈值 残留 6 ← 准时开火、事后仍不泄漏
    #    ⚠️ 试过但被否掉的写法:`sleep N & _sl=$!; { wait "$_sl" && kill …; } &`
    #       —— 不泄漏,但**永不开火**:那个 `wait` 等的是**兄弟进程**,
    #       而 `wait` 只能等自己的孩子,立即返回错误于是 && 短路。
    _l1_wd_flag="/tmp/qa-l1-wd-$$-$t"
    : > "$_l1_wd_flag"
    (
      _i=0
      while [ -e "$_l1_wd_flag" ]; do
        sleep 1; _i=$(( _i + 1 ))
        [ "$_i" -ge "$L1_WAIT_TIMEOUT" ] && { kill -9 "$pid" 2>/dev/null; break; }
      done
    ) & _l1_wd=$!
    if wait "$pid"; then
      ok "L1 $t ($(tail -1 /tmp/qa-l1-$t-run.log))${_w:+ [$_w]}"
    else
      _rc_wait=$?
      # 137 = 128+9 ⇒ 被我们的看门狗 SIGKILL 掉的,说清是超时而不是套件自己失败。
      if [ "$_rc_wait" = "137" ]; then
        fail "L1 $t — **超过 ${L1_WAIT_TIMEOUT}s 未返回**,已终止并按失败计(不是套件自身断言失败)${_w:+ [$_w]}"
      else
        fail "L1 $t — see /tmp/qa-l1-$t-run.log${_w:+ [$_w]}"
      fi
      tail -10 /tmp/qa-l1-$t-run.log | sed 's/^/    /'
      FAILED=$((FAILED+1))
    fi
    # 看门狗还活着就收掉它,别让它在后面某个时刻打死一个无关的 pid。
    rm -f "$_l1_wd_flag"          # ← 看门狗看到标志没了,1 秒内自退,不留孤儿
    wait "$_l1_wd" 2>/dev/null || true
  done
  # 汇总一张按开始偏移排序的表:红的时候一眼看出「它排在第几批、L1 跑了多久时炸的」。
  if [ -s /tmp/qa-l1-timing.tsv ]; then
    echo
    echo "L1 时间线（相对 L1 起点，按开始偏移排序）— #1333"
    sort -t$'\t' -k2,2n /tmp/qa-l1-timing.tsv \
      | awk -F'\t' '{printf "  +%4ds .. +%4ds  (%3ds)  %s\n", $2, $3, $3-$2, $1}'
    # 🔴 #1627 —— 一行**格式固定**的摘要,专门为了「跨 run 比快慢」。
    #
    #    今天(2026-08-31)我能判定五次红都是「慢 runner 撞绝对超时」,
    #    靠的是去 `docs/tests/` 里翻某人手工写进报告的历史耗时
    #    (`…2000 delivered rows… [7809.55ms]`)。**那不是一个可依赖的机制** ——
    #    下次没人写,就没有基线可比。
    #
    #    而 GitHub 的 job 日志**本身就是历史存储**(`gh api …/jobs/<id>/logs`
    #    能取到任意历史 run 的全文),它缺的只是「一个稳定的、能 grep 的形状」。
    #    加这一行之后,拿基线就是一条命令:
    #      gh api repos/<o>/<r>/actions/jobs/<id>/logs | grep -o 'L1-TIMING v1 .*'
    #
    #    格式一旦定下就别改字段顺序 —— 改了,之前所有 run 的日志就对不上了。
    # ⚠ 时长是**算出来的**($3-$2),不是列 —— 不能直接 `sort -k4`。
    #   第一版我就这么写了,输出是一串带时长的套件名、**看起来完全合理**,
    #   实际是原文件顺序(漏掉真正第 3 慢的那个,混进一个 1s 的)。
    _slowest=$(awk -F'\t' '{print $3-$2"\t"$1}' /tmp/qa-l1-timing.tsv 2>/dev/null \
      | sort -k1,1nr \
      | awk -F'\t' 'NR<=5{printf "%s%s=%ds", (NR>1?",":""), $2, $1}')
    echo "L1-TIMING v1 total=$(( $(date +%s) - START ))s suites=$(wc -l < /tmp/qa-l1-timing.tsv | tr -d ' ') slowest=${_slowest}"
  fi
fi

# 🔴 #1627 / #1309 —— **per-test** 余量。`L1-TIMING v1` 只到**套件**粒度,而这个失效
#    模式发生在**单条测试**上:bun 默认 20000ms **不写在任何测试源码里**,所以套件级
#    仪表看不见它。(2026-08-31 一天三批红,其中一批来自一个只改两个 `.md` 的纯文档 PR。)
#    这里补上那一格:解析 L0/L1 日志里 bun 打的逐条耗时,比**该条自己声明的超时**
#    (没有就它所在 describe 的,再没有才用默认值),报出贴上限的条目。
#    🔴 分母必须是**有效**超时,不能是默认值 —— 按默认值算会把一条自己声明了
#       `}, 60_000)` 的测试报成 90% 高危(实测差点因此误判一条测试"未修")。
#    report-only:只说话,不改退出码 —— 与下面 `L1_SOFT_BUDGET_S` 同一套教义。
#    阈值用 `TEST_MARGIN_PCT` 覆盖(默认 50%);升成 ratchet 是后续独立一步。
#
# 🔴 `command -v python3` 不是可选的礼节:`test823-l1-concurrency-cap` 在
#    `node:22-bookworm-slim`(**没有 python3**)里跑的是**真的 qa.sh --l1**,
#    而且它会创建 `/tmp/qa-l1-*.log` ⇒ 少了这个守卫就会在那个容器里喷
#    `python3: command not found`。这里静默退化,套件行为不变。
if command -v python3 >/dev/null 2>&1 \
   && { ls /tmp/qa-l0-*.log >/dev/null 2>&1 || ls /tmp/qa-l1-*-run.log >/dev/null 2>&1; }; then
  python3 "$REPO_ROOT/scripts/check-test-margin.py" \
    --logs '/tmp/qa-l0-*.log' '/tmp/qa-l1-*-run.log' || true
fi

ELAPSED=$(( $(date +%s) - START ))
# 🔴 软预算 —— #1320。**放在 if 之前：红的那一跑同样消耗了时间，同样是「变慢」的证据。**
#    第一版我写在 FAILED==0 分支里,结果 816s 那次因为有 1 个失败,时长一个字都没报 ——
#    只在绿的时候报时长,等于把一半样本丢掉。
#    runaway 守卫从 15 分钟放到 30 分钟之后,「变慢」不再会撞墙,
#    而这个仓库**没有任何记时长比基线的机制**(在此之前唯一能发现变慢的就是它撞墙)。
#    所以在这里把「会说话」还回来:超过软预算只 warning,不改变退出码。
#    默认 900s ≈ 当前中位 828s(13.8 分钟)的 1.09 倍 —— 故意贴近,目的是**早说**,不是拦。
#    L1 每加一个套件约 +12s(串行 build,实测 790s/66);涨到 900s 说明又多了约 6 个。
: "${L1_SOFT_BUDGET_S:=900}"
if [[ "$L1_SOFT_BUDGET_S" != "0" && $ELAPSED -gt $L1_SOFT_BUDGET_S ]]; then
  echo "::warning::L1 用了 ${ELAPSED}s,超过软预算 ${L1_SOFT_BUDGET_S}s —— 套件数或单套件耗时在涨。见 #1320（调守卫只买时间,并行化才是量级改变）"
fi

echo
if [[ $FAILED -eq 0 ]]; then
  ok "ALL PASS in ${ELAPSED}s"
  exit 0
else
  fail "$FAILED test(s) failed in ${ELAPSED}s"
  # 🔴 #1627 —— 把「本次跑得慢」这件事放在**失败旁边**,而不是只放在上面那条
  #    ::warning:: 里。理由是实测出来的:2026-08-31 一天里有三批红,全部是
  #    「用绝对超时的测试撞上一台慢 runner」,而它们的报错读起来和真缺陷一模一样:
  #      · `[20832.89ms]` 下一行才是 `^ this test timed out after 20000ms.`
  #      · `(fail) (unnamed)` 下一行才是 `^ a beforeEach/afterEach hook timed out`
  #    ——套件名(例:`rest-shape-golden`)是唯一看起来有信息的东西,于是所有人
  #    先去查 REST 投影。而真正的线索是**这一跑的总耗时**,它当时在几千行之外。
  if [[ "$L1_SOFT_BUDGET_S" != "0" && $ELAPSED -gt $L1_SOFT_BUDGET_S ]]; then
    echo "" >&2
    echo "🔴 本次 L1 用了 ${ELAPSED}s,超过软预算 ${L1_SOFT_BUDGET_S}s —— 判定上面这些失败之前先读这段。" >&2
    echo "   在偏慢的 runner 上,**用绝对超时的测试**(bun 默认 20000ms、以及" >&2
    echo "   beforeEach/afterEach 钩子超时)会先红,而报错里点名的是套件名,不是超时。" >&2
    echo "   先重跑一次。" >&2
    echo "   ⚠ 若重跑**仍红**:那还不足以判定为真缺陷 —— 再比一次两次 attempt 的" >&2
    echo "   L1 总耗时和 main 的样本区间;两次都落在慢区间说明重跑并没有换掉那个变量。" >&2
    echo "   见 #1627。" >&2
  fi
  exit 1
fi
