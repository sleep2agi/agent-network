#!/usr/bin/env bash
# #4063-A2 —— 隔离夹具里的**本地 Hub**（用于端到端跑 N1/N2/N4）
#
# 目的：起一个只在本机、只用临时 DB 的 Hub，让 A/B 两个节点有地方「经 Hub」发起目录/会话请求。
# 这样 #4063-B 里「Hub 路径已被既有测试覆盖」之外的那一半（真 Hub + 两个节点 + 真授权对象）才有地方跑。
#
# 🔴 边界（比 up.sh 更严）：
#   · 端口只绑 127.0.0.1，DB 只在 $ROOT/hub.db；
#   · 不连生产 Hub、不读生产 DB、不碰任何线上节点；
#   · 不写 ~/.anet、不改 ~/.commhub 的任何状态；进程 pid 记在 $ROOT/hub.pid，由 down.sh 清。
#
# 用法：
#   ROOT=/tmp/anet-isolation scripts/isolation-fixture/hub.sh
#   ROOT=/tmp/anet-isolation scripts/isolation-fixture/hub.sh --stop
#
# 幂等：重复起会先停旧的；--stop 在没有进程时也返回 0。

set -euo pipefail

ROOT=${ROOT:-/tmp/anet-isolation}
PORT=${HUB_PORT:-4633}
REPO=${ANET_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
BUN=${BUN_BIN:-$(command -v bun || true)}

stop_hub() {
  local pidfile="$ROOT/hub.pid"
  if [[ -f "$pidfile" ]]; then
    local pid; pid=$(cat "$pidfile" 2>/dev/null || true)
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 25); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

if [[ "${1:-}" == "--stop" ]]; then
  stop_hub
  echo "hub stopped (port $PORT)"
  exit 0
fi

[[ -n "$BUN" ]] || { echo "FAIL: bun not found (set BUN_BIN=...)" >&2; exit 1; }
[[ -f "$REPO/server/src/index.ts" ]] || { echo "FAIL: $REPO/server/src/index.ts 不存在（ANET_REPO_ROOT 指错了？）" >&2; exit 1; }

mkdir -p "$ROOT"
stop_hub
rm -f "$ROOT/hub.db" "$ROOT/hub.db-wal" "$ROOT/hub.db-shm"

(
  cd "$REPO/server"
  PORT="$PORT" \
  COMMHUB_DB="$ROOT/hub.db" \
  COMMHUB_SERVER=1 \
  ANET_HUB_LOCAL_FIXTURE=1 \
  nohup "$BUN" run src/index.ts >"$ROOT/hub.log" 2>&1 &
  echo $! > "$ROOT/hub.pid"
)

for _ in $(seq 1 60); do
  code=$(curl -sS -o "$ROOT/hub-health.json" -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null) || code=000
  if [[ "$code" == "200" ]]; then
    python3 - "$ROOT" "$PORT" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]); port = int(sys.argv[2])
h = json.loads((root / "hub-health.json").read_text())
print(json.dumps({"url": f"http://127.0.0.1:{port}", "version": h.get("version"),
                  "status": h.get("status"), "sessions": h.get("sessions_count"),
                  "db": str(root / "hub.db")}, ensure_ascii=False, indent=2))
PY
    echo "hub up: $ROOT/hub.log（pid $(cat "$ROOT/hub.pid")）"
    exit 0
  fi
  sleep 0.5
done

echo "FAIL: hub 没起来（看 $ROOT/hub.log）" >&2
tail -20 "$ROOT/hub.log" >&2 || true
stop_hub
exit 1
