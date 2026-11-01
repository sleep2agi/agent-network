#!/usr/bin/env bash
# #2756 —— pm2 日志按大小原地轮转（不需要 root，也不装 pm2-logrotate）。
#
# 为什么不用 pm2-logrotate：
#   这台机上 `pm2 install` 会调用 bun 而不是 npm，装出来的模块布局对不上
#   （报 ENOENT .../modules/pm2-logrotate/node_modules/pm2-logrotate/package.json）。
#   而系统 logrotate 需要 root。所以用「按大小原地截断」这个最小方案。
#
# 为什么是「原地截断」而不是「改名 + 新建」：
#   pm2 的工作进程持有该文件的 fd。改名后进程仍写旧 inode，
#   于是新文件永远为空、旧文件继续长大 —— 那个坑比不轮转更难查。
#   这里用 `cat > 同一路径`（O_TRUNC），fd 不变，进程继续写同一个文件。
#
# 用法：crontab 里每 30 分钟跑一次；也可以手工执行。
set -uo pipefail

MAX_BYTES=$((100 * 1024 * 1024))   # 100 MB
KEEP_BYTES=$((2 * 1024 * 1024))    # 截断后保留尾部 2 MB
LOG_DIR="/home/vansin/.commhub"
STATE="$LOG_DIR/log-rotate.log"

rotate_one() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size
  size=$(stat -c%s "$f" 2>/dev/null || echo 0)
  [ "$size" -le "$MAX_BYTES" ] && return 0

  local tmp
  tmp=$(mktemp "${f}.rot.XXXXXX") || return 1
  # 保留尾部，内容不丢光（最近的还在）
  tail -c "$KEEP_BYTES" "$f" > "$tmp" || { rm -f "$tmp"; return 1; }
  # 原地写回：O_TRUNC 但 inode 不变 ⇒ pm2 的 fd 继续有效
  cat "$tmp" > "$f" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  printf '%s rotated %s (%s -> %s bytes)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" "$size" "$(stat -c%s "$f")" >> "$STATE"
}

# 2026-11-01 —— 原来是四个**写死的路径**，而实测其中两个根本不存在
# （`.commhub/anet-dashboard-*.log` 不存在；真正的 pm2 日志在 `.pm2/logs/`，
#  且名字是 `-error.log` 不是 `-err.log`）。同时最大的那个 84M 的
# `weixin-listen-out.log` 完全不在名单里 —— 名单写死了，世界变了，而它不报错。
# 改成**按目录遍历**：任何超过阈值的 *.log 都轮转。
for d in "$LOG_DIR" "${HOME:-/home/vansin}/.pm2/logs"; do
  [ -d "$d" ] || continue
  for f in "$d"/*.log; do
    [ -f "$f" ] || continue
    # 自己的状态日志不参与（它另有尾部截断）
    [ "$f" = "$STATE" ] && continue
    rotate_one "$f"
  done
done

# 状态日志自身也别无限长
[ -f "$STATE" ] && [ "$(stat -c%s "$STATE")" -gt $((1024 * 1024)) ] && tail -c 262144 "$STATE" > "$STATE.tmp" && cat "$STATE.tmp" > "$STATE" && rm -f "$STATE.tmp"
exit 0
