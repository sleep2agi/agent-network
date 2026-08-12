#!/bin/bash
# Agent Network Dashboard 启动脚本（生产 :3001）
#
# 为什么不直接 exec npx：
#   2026-07-29 曾把版本钉到一个尚未发布到 npm 的号上，npx 每次 ETARGET 立即退出，
#   pm2 无退避地重启了 34494 次，整夜在锤 npm registry。
#   这里加一道预检：版本不存在就"慢速失败"，让 pm2 退避生效，并在日志里说清原因。
#
# 脚本必须放在持久路径下。此前它在 /tmp/dash-start.sh，任何 /tmp 清理都会让
# dashboard 在下一次重启时彻底起不来。

set -uo pipefail

PKG="@sleep2agi/agent-network-dashboard"
VERSION="0.6.3-preview.55"
# 部署时按本机 node 安装位置设置，例如 NODE_BIN=$HOME/.nvm/versions/node/v20.20.0/bin
NODE_BIN="${NODE_BIN:-$(dirname "$(command -v node)")}"

# 端口/地址允许被环境变量覆盖，默认即生产值。
# 为什么要可覆盖：否则任何"验证这个脚本能不能跑"的尝试都会去抢生产的 3001，
# 结果既验证不了什么，还会在 pm2 里造出一个不停重启的失败条目。
# 要验证的必须是**这个脚本本身**，而不是一个长得像它的副本。
export PORT="${PORT:-3001}"
export HOST="${HOST:-127.0.0.1}"
export PATH="$NODE_BIN:$PATH"

# 端口已被监听就不启动 —— 避免起出第二个实例去抢同一个端口，
# 然后在 pm2 里无限重启（这个坑踩过）。
# 🔴 同 hub-daemon.sh：原写法 `ss ... 2>/dev/null | grep -q` 是 fail-open 的。
# ss 不在 PATH 时错误被吞、管道为空、grep 不匹配 → 判成"端口空闲"照常放行。
# 这里显式解析 ss，找不到就拒绝启动，而不是假装端口是空的。
SS_BIN="$(command -v ss 2>/dev/null || true)"
[ -x "$SS_BIN" ] || SS_BIN=/usr/bin/ss
if [ ! -x "$SS_BIN" ]; then
  echo "[dash-start $(date '+%Y-%m-%d %H:%M:%S')] 🔴 找不到 ss，无法判断端口占用，拒绝启动。"
  sleep 30
  exit 1
fi
if "$SS_BIN" -tln 2>/dev/null | grep -q ":${PORT}[[:space:]]"; then
  echo "[dash-start $(date '+%Y-%m-%d %H:%M:%S')] 端口 ${PORT} 已被监听，拒绝启动第二个实例。"
  sleep 30
  exit 1
fi

log() { echo "[dash-start $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# 2026-08-02：预检不再是启动的硬前提。
#
# 原因（实测复现）：本机 `PORT=39311 npm_config_registry=http://127.0.0.1:1`
# 跑这个脚本本身 → "预检失败 … 不会启动"。也就是**开机时网络还没起来，
# dashboard 就永远不会启动** —— 而 daemon 的意义正是活过重启。
#
# 为什么可以放宽：真正被执行的是下面写死的 RUNTIME_BIN（一份已经装好的
# 固化安装），跑它完全不需要联网。脚本自己的注释也写着"启动不再需要联网解包"。
# 预检查的是 npm 上的 VERSION，和实际执行的东西不是一回事。
#
# 7-29 那道防线保留在真正需要它的场景：RUNTIME_BIN 不存在时（那时才必须
# 依赖 npm），仍然慢速失败，避免无退避重启锤 registry。
# 2026-08-04: Dashboard Chat HA (#82), source/build commit 54150269.
# The npm version remains preview.54; this pinned runtime is built from the
# reviewed main commit, so the directory name is the deployment identity.
RUNTIME_BIN="$HOME/.commhub/dashboard-runtime-v55/node_modules/.bin/agent-network-dashboard"

if ! resolved="$("$NODE_BIN/npm" view "${PKG}@${VERSION}" version 2>/dev/null)" || [ -z "$resolved" ]; then
  if [ -x "$RUNTIME_BIN" ]; then
    log "⚠️ 预检未通过（${PKG}@${VERSION} 查不到，或 registry 不可达）。"
    log "   本地固化安装存在，按它启动 —— 启动不依赖 npm。"
    log "   注意：这说明 VERSION 与 registry 不一致，请择机核对，但不阻塞启动。"
  else
    log "预检失败：${PKG}@${VERSION} 在 npm 上不存在，或 registry 暂时不可达。"
    log "且本地固化安装缺失（$RUNTIME_BIN），无从启动。"
    log "当前 preview 标签指向：$("$NODE_BIN/npm" view "$PKG" dist-tags.preview 2>/dev/null || echo '查询失败')"
    # 慢速失败：给 pm2 退避留出时间，避免像 34494 次那样锤 registry
    sleep 30
    exit 1
  fi
else
  log "预检通过：${PKG}@${resolved}，监听 ${HOST}:${PORT}"
fi
# 🔴 不再走 npx：npx 把包解到 ~/.npm/_npx/<hash>/ 并从那里执行，
# 也就是说**生产服务跑在一个 npm 缓存目录里** —— 任何人一条
# `npm cache clean --force` 就能删掉线上服务的运行目录。
# 2026-07-29 实测：_npx 下 70 个条目共 15G，只有 1 个在用；
# 我按引用扫描清掉 69 个无引用条目回收 13.6G，当时差一点连在用的一起清。
# 改为直接 exec 固化安装（~/.commhub/dashboard-runtime），
# 启动不再依赖任何缓存目录，也不再需要联网解包。
if [ ! -x "$RUNTIME_BIN" ]; then
  echo "[dash-start] 🔴 固化安装缺失：$RUNTIME_BIN"
  echo "[dash-start]    重建：cd ~/.commhub/dashboard-runtime && npm install"
  echo "[dash-start]    慢速失败 30 秒，让 pm2 退避生效。"
  sleep 30
  exit 1
fi
exec "$RUNTIME_BIN"
