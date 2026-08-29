#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

# test1225 — `anet node start <node> --copresence` 的**编排段**，以及它失败时说了什么。
#
# 为什么需要这个套件（#1225 立案时量到的缺口）：
#   • tests/test227-opencode-tui-copresence 的 harness 直接调
#     openOpenCodeCopresenceRuntime()，**从不经过 anet CLI**；而且 test227 在
#     .github/ 和 scripts/ 里的引用是 **0 处**，根本不在 CI 里跑；
#   • agent-network/src/opencode-copresence-cli.test.ts 是读 cli.ts 源文本的
#     结构断言，不启动任何进程。
#   ⇒ 「一条命令起完整共存流程」这条路径，在这个套件之前**零端到端覆盖**。
#      #1225 那次因此花掉一整个复现容器才定位到死因。
#
# 本套件覆盖什么：真的跑 `anet node create` + `anet node start --copresence`，
# 断言 CLI 写下的东西、起的 tmux 会话、以及**失败时用户实际看到什么**。
#
# 🔴 刻意不覆盖什么（写出来，不靠读者推断）：真 opencode 的 serve 与 TUI。
#    镜像里的 opencode 是 STUB、故意不 serve；那一半要网络和凭据，不该进一个
#    `--network none` 的镜像（同 test750 对 codex 的取舍）。**所以本套件跑的是
#    失败路径**：失败路径恰好正是 #1225 里唯一没有覆盖、且用户真撞上的那条。

ROOT=/workspace
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test1225.txt}"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"

log()  { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

log "# test1225 — opencode co-presence: 一条命令，以及它失败时说了什么"
log "date: $(date -Is)"
log "source_commit: ${TEST1225_SOURCE_COMMIT:-${SOURCE_COMMIT:-unset}}"

# ── L0 ───────────────────────────────────────────────────────────────────────
log "[L0] 隔离环境与取集分母"
[ ! -e "$ROOT/.git" ]  || fail "镜像里带进了宿主的 .git"
[ ! -e "$ROOT/.anet" ] || fail "镜像里带进了宿主的 .anet"
command -v tmux >/dev/null 2>&1 || fail "缺 tmux —— 缺了它 CLI 在编排开始前就退出，本套件测的那一段根本走不到"
node --version >>"$REPORT"; bun --version >>"$REPORT"; tmux -V >>"$REPORT"

# 🔴 stub 的版本号从**源码常量**派生，不写死第三份。
#    写死的话，哪天 OPENCODE_BUILTIN_PIN 升了，stub 还报旧版本 →
#    copresence 启动会在**更早**的 revalidatePinnedOpencodeBinary 处退出，
#    于是本套件想测的编排段走不到，而它**看起来照样绿**（同 test384 记着的坑）。
PIN_SRC="$ROOT/agent-network/src/opencode-pin.ts"
OPENCODE_PIN=$(sed -n 's/^export const OPENCODE_BUILTIN_PIN = "\([^"]*\)";$/\1/p' "$PIN_SRC")
[ -n "$OPENCODE_PIN" ] || fail "从 $PIN_SRC 读不出 OPENCODE_BUILTIN_PIN —— 常量改名了？"
log "opencode pin (源码派生): $OPENCODE_PIN"

cat >/usr/local/bin/opencode <<STUB
#!/bin/sh
if [ "\$1" = "--version" ]; then echo "$OPENCODE_PIN"; exit 0; fi
echo "test1225-opencode-stub: refusing to serve (by design)" >&2
exit 9
STUB
chmod 0755 /usr/local/bin/opencode
[ "$(opencode --version)" = "$OPENCODE_PIN" ] || fail "stub 版本没对上 pin"
pass "隔离环境就绪（tmux 在、opencode stub 报 $OPENCODE_PIN）"

# ── L1 ───────────────────────────────────────────────────────────────────────
log "[L1] 编排与诊断的单元判据"
cd "$ROOT/agent-network"
bun test src/opencode-copresence-cli.test.ts src/copresence-startup-diagnosis.test.ts >>"$REPORT" 2>&1 \
  || fail "opencode copresence 单元测试"
# 🔴 `bun test` 绿不等于这两个文件跑了 —— 路径打错会得到「0 tests」和 exit 0。
#    断言分母。
# 🔴 不写 `… | head -1`：head 读够就关管道，上游 grep 拿到 SIGPIPE → 退出码 141，
#    pipefail 传出来、set -e 打死脚本，而它和真失败**长得一模一样**（本仓 #990）。
_unit_raw=$(bun test src/opencode-copresence-cli.test.ts src/copresence-startup-diagnosis.test.ts 2>&1 \
  | grep -oE '^ *[0-9]+ pass' | grep -oE '[0-9]+')
UNIT_TOTAL=${_unit_raw%%$'\n'*}
[ "${UNIT_TOTAL:-0}" -ge 18 ] || fail "预期 >=18 条单元断言，实际跑了 ${UNIT_TOTAL:-0} —— 文件路径解析到了吗？"
pass "编排 + 诊断单元判据（$UNIT_TOTAL 条）"

# ── L2 ───────────────────────────────────────────────────────────────────────
log "[L2] create 写下的，正是 start 要读的"
PORT=9225
HUB="http://127.0.0.1:${PORT}"
export COMMHUB_AUTH_TOKEN="test1225-token"
cd "$ROOT/server" && PORT=$PORT bun run src/index.ts >/tmp/test1225-hub.log 2>&1 &
HUB_PID=$!
for _ in $(seq 60); do curl -fsS -o /dev/null "$HUB/health" 2>/dev/null && break; sleep 0.5; done
curl -fsS -o /dev/null "$HUB/health" 2>/dev/null \
  || { cat /tmp/test1225-hub.log >>"$REPORT"; fail "commhub-server 没在 $HUB 上健康起来"; }
log "hub up on $HUB"

WORK=$(mktemp -d)
cd "$WORK"
CLI="bun $ROOT/agent-network/bin/cli.ts"
printf "\n" | $CLI init --hub "$HUB" >>"$REPORT" 2>&1 || true
$CLI register --username t1225 --password pass123456 >>"$REPORT" 2>&1 || true
$CLI login --username t1225 --password pass123456   >>"$REPORT" 2>&1 || true

NODE=oc1225
$CLI node create "$NODE" --runtime opencode-cli >>"$REPORT" 2>&1 || fail "node create"
field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2]))" "$1" "$2"; }
CFG="$WORK/.anet/nodes/$NODE/config.json"
[ -f "$CFG" ] || fail "create 没写出 config.json"
[ "$(field "$CFG" runtime)" = "opencode-cli" ] || fail "runtime 没写成 opencode-cli"
pass "create 写出 opencode-cli 节点（$CFG）"

# ── L3 ───────────────────────────────────────────────────────────────────────
# 🔴 这一层实际红在哪，是**量出来的**，不是我设计时以为的那样：
#    我原以为 stub 会走到 copresence 启动然后 serve 失败。实测不是 ——
#    CLI 在**更早**的依赖预检就拒了（"Incompatible opencode-ai runtime … no trusted
#    exact opencode-ai package entrypoint found on PATH"），因为一个裸 shell 脚本
#    不是一个 opencode-ai npm 包。那条路径同样是用户真会撞上的失败，而且它的
#    remediation 文案正好由本层顺带钉住。**更深的那一层放在 L3b。**
log "[L3a] 🔴 一条命令：anet node start --copresence（依赖预检拒绝 ⇒ 桥快速退出）"
NODE_DIR="$WORK/.anet/nodes/$NODE"
BRIDGE_LOG="$NODE_DIR/logs/copresence-bridge.log"
START_OUT=/tmp/test1225-start.txt
set +e
timeout 120s $CLI node start "$NODE" --copresence >"$START_OUT" 2>&1
START_RC=$?
set -e
log "start exit=$START_RC"
{ echo "── start 输出 ──"; cat "$START_OUT"; } >>"$REPORT"

[ "$START_RC" -ne 0 ] || fail "stub 不 serve，start 却成功了 —— 要么 stub 没生效，要么就绪判据没在判真的东西"

# 判据①：copresence 模式**写进了 profile**（start 之前 saveProfile 那一步）
[ "$(field "$CFG" opencodeMode)" = "copresence" ] \
  || fail "--copresence 没把 opencodeMode 写进 profile"

# 判据②：失败输出必须指认**等的是哪个文件**
grep -Fq "$NODE_DIR/opencode-attach.sh" "$START_OUT" \
  || fail "失败输出没说它在等哪个 attach launcher"

# 判据③：必须说清 bridge 是死了还是还活着 —— 两者排查方向不同，且**只能是其中一个**
DEAD=$(grep -c '桥里的 agent-node 在写出 launcher 之前就结束了' "$START_OUT" || true)
ALIVE=$(grep -c 'bridge 还在跑' "$START_OUT" || true)
[ $((DEAD + ALIVE)) -eq 1 ] \
  || fail "bridge 存活状态没说清（死=$DEAD 活=$ALIVE，必须恰好一个）"

# 判据④：🔴 bridge 的输出**落盘**了，而且失败输出把路径给了用户。
#   这一条是整个套件的核心：#1225 那次两条取证路径同时为空
#   （会话已死 ⇒ capture-pane 空；崩溃走 stderr ⇒ 节点日志里也没有），
#   用户只拿到一行泛泛的超时。
[ -s "$BRIDGE_LOG" ] || fail "bridge 日志没落盘或是空的：$BRIDGE_LOG"
grep -Fq "$BRIDGE_LOG" "$START_OUT" || fail "失败输出没给出 bridge 日志路径"
grep -Fq "$NODE_DIR/logs" "$START_OUT" || fail "失败输出没给出节点日志目录"

# 判据⑤：落盘的内容**真的是桥里那个进程的输出**，不是空壳文件
if ! grep -qE 'agent-node|anet|opencode' "$BRIDGE_LOG"; then
  { echo "── bridge 日志 ──"; cat "$BRIDGE_LOG"; } >>"$REPORT"
  fail "bridge 日志里没有桥进程的任何输出"
fi
pass "失败输出指认了等待对象 / bridge 存活状态 / 落盘日志路径，且日志真有内容"

# 判据⑥：失败之后不留孤儿 tmux 会话
sleep 1
LEFT=$(tmux ls 2>/dev/null | grep -c "^${NODE}" || true)
[ "$LEFT" -eq 0 ] || { tmux ls >>"$REPORT" 2>&1; fail "失败之后还剩 $LEFT 个 ${NODE}* tmux 会话"; }
pass "失败之后没有孤儿 tmux 会话"

# ── L3b ──────────────────────────────────────────────────────────────────────
log "[L3b] 🔴 桥**活着但走不到写 launcher** ⇒ 诊断必须说的是另一句"
# 这一层把两个预检都喂饱，让 CLI 真的把桥拉起来：
#   ① 一个**真的 opencode-ai 包**形状（package.json + bin），PATH 上的 `opencode`
#      指向它 —— 裸脚本过不了包身份校验（L3a 就是被这条拦的）；
#   ② 一个**配对版本**的全局 agent-node（同 test750 的做法），它起来之后什么都不做。
# 两个版本号都从源码派生，不写死第三份。
PAIRED_NODE_VERSION=$(node -p "require('$ROOT/agent-node/package.json').version")
[ -n "$PAIRED_NODE_VERSION" ] || fail "读不出 agent-node 的配对版本"
log "paired agent-node (源码派生): $PAIRED_NODE_VERSION"

# 🔴 不能放 /tmp：包身份校验会拒绝「目录属主/权限不安全」的树（/tmp 是 1777），
#    实测报 "resolved opencode-ai package has unsafe directory ownership or mode at /tmp"。
#    放 /run/user/<uid> 并 chmod 700，同 test750 对配对 agent-node 的做法。
SAFE_BASE="/run/user/$(id -u)"
mkdir -p "$SAFE_BASE/test1225-fake-global" "$SAFE_BASE/test1225-paired"
chmod 755 /run/user 2>/dev/null || true
chmod 700 "$SAFE_BASE" "$SAFE_BASE/test1225-fake-global" "$SAFE_BASE/test1225-paired"
FAKE_OC="$SAFE_BASE/test1225-fake-global/node_modules/opencode-ai"
mkdir -p "$FAKE_OC/bin"
cat >"$FAKE_OC/package.json" <<JSON
{"name":"opencode-ai","version":"$OPENCODE_PIN","bin":{"opencode":"bin/opencode.exe"}}
JSON
cat >"$FAKE_OC/bin/opencode.exe" <<STUB
#!/bin/sh
if [ "\$1" = "--version" ]; then echo "$OPENCODE_PIN"; exit 0; fi
echo "test1225-fake-opencode: not serving (by design)" >&2
sleep 3600
STUB
chmod 0755 "$FAKE_OC/bin/opencode.exe"
ln -sf "$FAKE_OC/bin/opencode.exe" /usr/local/bin/opencode
[ "$(opencode --version)" = "$OPENCODE_PIN" ] || fail "fake opencode-ai 包的版本没对上 pin"

PAIR_ROOT="$SAFE_BASE/test1225-paired/node_modules/@sleep2agi/agent-node"
mkdir -p "$PAIR_ROOT/dist"
cat >"$PAIR_ROOT/package.json" <<JSON
{"name":"@sleep2agi/agent-node","version":"$PAIRED_NODE_VERSION","publishConfig":{"tag":"preview"},"bin":{"agent-node":"dist/cli.js"}}
JSON
cat >"$PAIR_ROOT/dist/cli.js" <<'JS'
#!/usr/bin/env node
// 起来之后什么都不做：桥**活着**，但永远写不出 attach launcher。
// 这正是诊断里"bridge 还在跑"那一支要覆盖的现实（慢/卡住，而不是崩了）。
if (process.argv.includes("--help")) { console.log("--runtime opencode-cli"); process.exit(0); }
await new Promise(() => {});
JS
chmod 0755 "$PAIR_ROOT/dist/cli.js"
export ANET_AGENT_NODE_BIN="$PAIR_ROOT/dist/cli.js"

safe_rm_rf "$NODE_DIR/logs"
set +e
timeout 180s $CLI node start "$NODE" --copresence >/tmp/test1225-start-b.txt 2>&1
START_B_RC=$?
set -e
log "start(L3b) exit=$START_B_RC"
{ echo "── start(L3b) 输出 ──"; cat /tmp/test1225-start-b.txt; } >>"$REPORT"
[ "$START_B_RC" -ne 0 ] || fail "桥永远写不出 launcher，start 却成功了"

DEAD_B=$(grep -c '桥里的 agent-node 在写出 launcher 之前就结束了' /tmp/test1225-start-b.txt || true)
ALIVE_B=$(grep -c 'bridge 还在跑' /tmp/test1225-start-b.txt || true)
[ "$ALIVE_B" -eq 1 ] && [ "$DEAD_B" -eq 0 ]   || fail "桥还活着，诊断却没说'bridge 还在跑'（死=$DEAD_B 活=$ALIVE_B）—— 两支说反了比不说更糟"
grep -Fq "$BRIDGE_LOG" /tmp/test1225-start-b.txt || fail "L3b 的失败输出没给出 bridge 日志路径"
pass "桥活着那一支说的是另一句，且两支互斥（L3a 死=1 活=0；L3b 死=0 活=1）"

sleep 1
LEFT=$(tmux ls 2>/dev/null | grep -c "^${NODE}" || true)
[ "$LEFT" -eq 0 ] || { tmux ls >>"$REPORT" 2>&1; fail "L3b 之后还剩 $LEFT 个 ${NODE}* tmux 会话"; }
unset ANET_AGENT_NODE_BIN

# ── L4 ───────────────────────────────────────────────────────────────────────
log "[L4] witnessed-red：拿掉落盘那一行，L3 的判据④必须红"
CLI_SRC="$ROOT/agent-network/bin/cli.ts"
cp "$CLI_SRC" /tmp/cli.bak
python3 - "$CLI_SRC" <<'PYX'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text(encoding="utf-8")
old = "    `exec > >(tee -a ${shellQuote(bridgeLog)}) 2>&1`,\n"
assert t.count(old) == 1, f"落盘那一行应恰好出现 1 次,实际 {t.count(old)} 次 —— 0 次通常意味着实现改了而这里没跟"
p.write_text(t.replace(old, ""), encoding="utf-8")
PYX
cmp -s /tmp/cli.bak "$CLI_SRC" && fail "变异是 no-op（文件逐字未变），红了也什么都没证明"
safe_rm_rf "$WORK/.anet/nodes/$NODE/logs"
set +e
timeout 120s $CLI node start "$NODE" --copresence >/tmp/test1225-mut.txt 2>&1
MUT_RC=$?
set -e
cp /tmp/cli.bak "$CLI_SRC"
cmp -s /tmp/cli.bak "$CLI_SRC" || fail "变异之后没能把 cli.ts 逐字还原"
[ "$MUT_RC" -ne 0 ] || fail "变异之后 start 反而成功了 —— 这不是本条要测的东西"
if [ -s "$BRIDGE_LOG" ]; then
  fail "拿掉落盘那一行之后 bridge 日志仍然存在 —— 判据④没有承重"
fi
log "  MUTATION_RED bridge-log-not-persisted rc=$MUT_RC（日志缺失，判据④会红）"
# 还原后必须回绿：否则上面那个红可能来自别的原因
safe_rm_rf "$WORK/.anet/nodes/$NODE/logs"
set +e; timeout 120s $CLI node start "$NODE" --copresence >/dev/null 2>&1; set -e
[ -s "$BRIDGE_LOG" ] || fail "还原之后 bridge 日志没有回来 —— 那个红不是这行变异造成的"
pass "落盘那一行承重（拿掉→日志消失，还原→日志回来）"

# 失败之后不留孤儿（变异轮同样要清干净）
sleep 1
LEFT=$(tmux ls 2>/dev/null | grep -c "^${NODE}" || true)
[ "$LEFT" -eq 0 ] || { tmux ls >>"$REPORT" 2>&1; fail "变异轮之后还剩 $LEFT 个 ${NODE}* tmux 会话"; }

kill "$HUB_PID" 2>/dev/null || true
log ""
log "OVERALL: PASS"
log "trailer: test1225 opencode 共存一条龙 —— create → start --copresence → 失败诊断与落盘 — PASS"
