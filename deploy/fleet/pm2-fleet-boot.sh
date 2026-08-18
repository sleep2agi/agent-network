#!/usr/bin/env bash
# 开机把 pm2 军团拉回来（commhub-hub / anet-dashboard / weixin-*）。
# 由 ~/.config/systemd/user/pm2-fleet.service 调用（user 单元 + linger，无需 sudo）。
#
# 🔴 幂等设计：pm2 里已经有进程就直接 no-op 退出。
#    理由：resurrect 打在活着的 pm2 上可能拉出重复进程，而这些进程占 9200/3001 端口。
#    有了这个守卫，本单元在任何时刻手动 start 都安全 —— 也才能在不重启整机的前提下真验证。
set -uo pipefail
# 🔴 路径参数化（#894）：原来三处写死了那台机的家目录。nvm 版本仍然钉死 ——
#    钉的是 node 版本（可重现性），不是钉某个人的家目录。
NODE_BIN="${ANET_NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin}"
export PATH="$NODE_BIN:$PATH"
PM2="$NODE_BIN/pm2"
log() { echo "[pm2-fleet-boot $(date '+%F %T')] $*"; }

jlist=$("$PM2" jlist 2>/dev/null)
jlist_rc=$?
if [ "$jlist_rc" -ne 0 ]; then
  log "🔴 pm2 jlist 失败（rc=$jlist_rc），无法确认现有进程数；拒绝 resurrect"
  exit 1
fi
n=$(printf '%s' "$jlist" | "$NODE_BIN/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);if(!Array.isArray(v))throw new Error("not array");process.stdout.write(String(v.length))}catch{process.exit(2)}})')
parse_rc=$?
if [ "$parse_rc" -ne 0 ] || ! [[ "$n" =~ ^[0-9]+$ ]]; then
  log "🔴 pm2 jlist 返回无法解析的进程清单；拒绝 resurrect"
  exit 1
fi
if [ "$n" -gt 0 ] 2>/dev/null; then
  log "pm2 已有 $n 个进程在跑 → no-op 退出（不做 resurrect，避免重复拉起占端口）"
  exit 0
fi
DUMP="${PM2_HOME:-$HOME/.pm2}/dump.pm2"
if [ ! -f "$DUMP" ]; then
  log "🔴 没有 $DUMP，恢复不出任何东西；需要先在活着的系统上跑一次 pm2 save"
  exit 1
fi
log "pm2 无进程 → resurrect"
"$PM2" resurrect
rc=$?
log "resurrect 退出码 $rc"
"$PM2" list --no-color 2>/dev/null | sed 's/^/    /'
exit $rc
