#!/bin/bash
# CommHub 生产中枢启动脚本（供 pm2 守护）
#
# 由来：hub 是全军团单点，此前是裸 nohup 进程 + cron 看门狗。
# 2026-07-29 09:46 被误杀后 95 个 agent 掉线，只能靠人巡检发现。
# dashboard 有 pm2 所以同类事故能自愈，hub 反而没有 —— 这是结构性缺陷。
#
# 本脚本同时修掉一个潜伏更久的问题：
#   原 start-hub.sh 用 `bunx --bun @sleep2agi/commhub-server@<版本>`，
#   实际执行的二进制落在 /tmp/bunx-1000-.../node_modules/.bin/commhub-server。
#   **生产中枢在从 /tmp 里跑。** 任何 /tmp 清理都会让下一次启动直接失败，
#   而"当前进程还活着"完全掩盖这一点（同 dashboard 那次 /tmp/dash-start.sh）。
#   这里改为跑 ~/.commhub/runtime 下的固化安装，不在启动路径上碰网络和 /tmp。
#
# 设计约束：
#   1. 缺 vault 密钥 → 拒绝启动（fail-closed）。带着空密钥起来会让密文静默解不开，
#      比起不来更难查。
#   2. 端口已被监听 → 拒绝启动。绝不允许第二个 hub 抢同一个 DB。
#   3. 预检失败一律"慢速失败"，给 pm2 退避留时间，不要空转锤日志。
#   4. 端口/DB 可由环境变量覆盖 —— 这样旁路验证跑的是**同一个脚本**，
#      而不是一个长得像它的副本（否则验证等于没验证）。

set -uo pipefail

# 版本切换点。回滚就是把这一行指回上一个 runtime-vNN 目录并重启 —— 旧目录保留不删。
# 2026-07-30 06:1x: runtime-v22 → runtime-v23
#   内容 = #500 文件下载归属校验（P0 活漏洞）+ #497 节点属性 + #502/#504 回复规则
# 2026-07-30 09:5x: runtime-v23 → runtime-v24
#   内容 = #505 /health 的 sse_sessions 按 network_members 租户隔离
#          修的是我关 #473 泄漏时造成的回归：dashboard 整页显示 197 节点全离线
#   回滚目标 = runtime-v23（0.9.0-preview.23），目录仍在
# 2026-07-30 11:3x: runtime-v24 → runtime-v25（0.9.0-preview.25）
#   内容 = #509/#510 文件下载改用索引里记的 date_bucket，不再用运行时时钟
#          症状：blob 按 uploads/YYYY-MM-DD/ 分目录存，读的时候却拿「今天」去拼路径，
#          于是**过了午夜，前一天上传的文件全部 404**。Vincent 那个 PPT 打不开、
#          大小异常，就是客户端把 404 的响应体当成文件存下来了。
#   证据链 = 独立验证者在 oven/bun:1.2.22 容器里跑打包产物：前置门 + Door 3 + Door 4 全过；
#            被验 SHA c9e0aff6 与 main 上 squash 后的 781df0e8 tree 完全相同
#            (4a29701545fd60d80537f84a9954d984dadeb530)，所以验的就是这份代码
#   回滚目标 = runtime-v24（0.9.0-preview.24），目录仍在
# 2026-08-01 02:1x: runtime-v25 → runtime-v26（0.9.0-preview.26；#550 avatar 同源相对路径校验放宽 /avatars/<name>.<ext>）
#   旁路验证 :9226 独立 COMMHUB_DB=/tmp 六用例全过（相对/绝对/js:/protocol-rel/traversal/null）
#   回滚目标 = runtime-v25（0.9.0-preview.25），目录仍在
# 2026-08-04 07:5x: runtime-v26 → runtime-v27-dashboard-delivery-bb41d94f
#   内容 = #571 REST 身份绑定 + #575 durable idempotency + #577 Dashboard→Codex TUI auth stamp/steer
#   证据 = Test584 Docker PASS；高位端口实跑 ntok spoof=403、同 client_request_id 仅一行
#   回滚目标 = runtime-v26（0.9.0-preview.26），脚本备份 hub-daemon.sh.before-dashboard-delivery-20260804

# 2026-08-11: runtime-v32-run-terminal-d5199bc9 → runtime-v33-upload-bridge-17b8223f
#   内容 = #693 agent controlled local upload → Hub file_id bridge (Vincent GO)
#   回滚目标 = runtime-v32-run-terminal-d5199bc9，目录仍在；hub-daemon 备份见 rollback-693-*
# 2026-08-13 00:5x: runtime-v33 → runtime-v34-preview29(0.9.0-preview.29;含 #698 peer-reply 终结原任务、#697 model 注入)
#   回滚目标 = runtime-v33-upload-bridge-17b8223f(0.9.0-preview.27),目录仍在
RUNTIME_DIR="$HOME/.commhub/runtime-v34-preview29"
ENTRY="$RUNTIME_DIR/node_modules/@sleep2agi/commhub-server/bin/commhub.ts"
ENV_FILE="${HUB_ENV_FILE:-$HOME/.commhub/hub.env}"
# bun 解析：显式路径优先，其次走 PATH。
# 注意 bun 是通过 nvm 下的 npm 装的，路径里带 node 版本号
# (~/.nvm/versions/node/vX/bin/bun) —— **升级 node 会让这个路径失效**。
# 所以不硬编死一个路径，找不到就 fail-closed 报出来，而不是静默起不来。
_resolve_bun() {
  [ -n "${BUN_BIN:-}" ] && { echo "$BUN_BIN"; return; }
  local nvm_bun="$HOME/.nvm/versions/node/v20.20.0/bin/bun"
  [ -x "$nvm_bun" ] && { echo "$nvm_bun"; return; }
  command -v bun 2>/dev/null && return
  # 兜底：扫 nvm 下任意 node 版本里的 bun，容忍 node 升级
  local found
  found=$(ls -1 "$HOME"/.nvm/versions/node/*/bin/bun 2>/dev/null | tail -1)
  [ -n "$found" ] && echo "$found"
}
BUN_BIN="$(_resolve_bun)"

# 可覆盖，默认即生产值
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-9200}"

log() { echo "[hub-daemon $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

fail_slow() {
  log "🔴 预检失败：$*"
  log "不启动。修好后 pm2 会自动重试。"
  sleep 30
  exit 1
}

# --- 预检 1：bun 可执行 ---
[ -x "$BUN_BIN" ] || fail_slow "找不到 bun：$BUN_BIN"

# --- 预检 2：固化安装存在（不依赖 /tmp、不依赖启动时联网）---
[ -f "$ENTRY" ] || fail_slow "固化安装缺失：$ENTRY（在 $RUNTIME_DIR 跑 npm install 重建）"

# --- 预检 3：vault 密钥必须存在且非空（fail-closed）---
[ -f "$ENV_FILE" ] || fail_slow "缺少 $ENV_FILE，无法取得 vault 密钥"
if ! grep -q '^ANET_HUB_SECRET_VAULT_KEY=.\+' "$ENV_FILE"; then
  fail_slow "$ENV_FILE 里没有非空的 ANET_HUB_SECRET_VAULT_KEY"
fi

# --- 预检 4：端口必须没人监听，否则会起出第二个 hub 抢同一个 DB ---
#
# 🔴 这道门原本写成 `ss -tln 2>/dev/null | grep -q ...`，是**fail-open** 的：
#    ss 不在 PATH 时，`2>/dev/null` 把 "command not found" 吞掉 → 管道里是空输出
#    → grep 不匹配 → 判定"端口空闲" → 照常放行启动。
#    **这道门唯一的目的就是不许起第二个 hub 抢同一个 DB，静默失效正好把它废掉。**
#    独立复核实测：端口明明被占，脚本仍打印"预检通过"并 exec（生产当前 PATH 不触发，
#    风险在换机 / 换基础镜像 / PATH 被精简的 spawn 环境）。
#    改法：显式解析 ss，找不到就 fail-closed，而不是当作"端口空闲"。
# SS_BIN 可由环境变量覆盖，理由同 PORT/DB：旁路验证必须跑**这个脚本本身**。
#
# 🔴 显式覆盖必须是权威的，不能再回退。
#    第一版写成「覆盖了但不可执行 → 回退 /usr/bin/ss」，结果是：
#    我拿 SS_BIN=/nonexistent/ss 去验"ss 缺失会不会 fail-closed"，
#    脚本默默回退到真的 ss，打印"预检通过"—— **我根本没测到那条分支，
#    却差点当成验过了。** 一道无法被转红的门，等于没验过。
#    顺带这也是更正确的行为：被静默忽略的显式覆盖本身就是个陷阱。
if [ -n "${SS_BIN:-}" ]; then
  [ -x "$SS_BIN" ] || fail_slow "显式指定的 SS_BIN 不可执行：$SS_BIN（不回退，拒绝在看不见端口的情况下启动）"
else
  SS_BIN="$(command -v ss 2>/dev/null || true)"
  [ -x "$SS_BIN" ] || SS_BIN=/usr/bin/ss
  [ -x "$SS_BIN" ] || fail_slow "找不到 ss，无法判断端口是否被占用 —— 拒绝在看不见的情况下启动"
fi
if "$SS_BIN" -tln 2>/dev/null | grep -q ":${PORT}[[:space:]]"; then
  fail_slow "端口 ${PORT} 已被监听 —— 已有 hub 在跑，拒绝启动第二个"
fi

# 载入密钥。用 set -a 而非 export $(...)：后者在 grep 没命中时会裸 export 整个环境。
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

log "预检通过：entry=${ENTRY}"
log "监听 ${HOST}:${PORT}，DB=${COMMHUB_DB:-<默认 ~/.commhub/commhub.db>}"

exec "$BUN_BIN" "$ENTRY"
