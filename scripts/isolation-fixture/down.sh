#!/usr/bin/env bash
# #4063-A —— 共享 Server 隔离夹具（停 + 清理）
#
# 幂等：没有 pid 文件、进程已死、目录不存在，都算成功。
# 只删 ROOT（默认 /tmp/anet-isolation），绝不碰其它路径。

set -uo pipefail

ROOT=${ROOT:-/tmp/anet-isolation}

stop_one() {
  local name=$1
  local pidfile="$ROOT/$name/pid"
  if [[ -f "$pidfile" ]]; then
    local pid; pid=$(cat "$pidfile" 2>/dev/null || true)
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

stop_one a
stop_one b

# #4063-A2：本地 Hub 也要一起停（pid 记在 $ROOT/hub.pid，dir 一删就找不到了）
if [[ -f "$ROOT/hub.pid" ]]; then
  hubpid=$(cat "$ROOT/hub.pid" 2>/dev/null || true)
  if [[ -n "${hubpid:-}" ]] && kill -0 "$hubpid" 2>/dev/null; then
    kill "$hubpid" 2>/dev/null || true
    for _ in $(seq 1 25); do kill -0 "$hubpid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$hubpid" 2>/dev/null || true
  fi
  rm -f "$ROOT/hub.pid"
fi

# 兜底：按端口清掉本夹具的残留（只匹配我们这个 ROOT 下的 serve）
pkill -f "serve --port 4611 --pure" 2>/dev/null || true
pkill -f "serve --port 4612 --pure" 2>/dev/null || true

rm -rf "$ROOT"
echo "fixture down: $ROOT removed"
