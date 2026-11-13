#!/usr/bin/env bash
# #4063-A —— 共享 Server 隔离夹具（起）
#
# 目的：在同一台机器上起**两个互不共享 HOME/数据目录**的 OpenCode Server，
# 用来做「节点 A 能不能读到节点 B 的目录/会话」这类正负控实验。
#
# 🔴 边界：
#   · 只写 ROOT（默认 /tmp/anet-isolation），不动 ~/.local/share/opencode、不动任何线上节点；
#   · 不连 Hub（本脚本只负责「机器上的两个 Server」这一层；Hub 注册是另一步）；
#   · 不打印凭据值；凭据写在 $ROOT/credentials.env（chmod 600），state.json 里只有非敏感信息。
#
# 用法：
#   ROOT=/tmp/anet-isolation scripts/isolation-fixture/up.sh
#   scripts/isolation-fixture/down.sh          # 幂等，可重复执行
#
# 幂等：重复执行会先 down 再 up，避免残留进程占端口。

set -euo pipefail

ROOT=${ROOT:-/tmp/anet-isolation}
PORT_A=${PORT_A:-4611}
PORT_B=${PORT_B:-4612}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

OC=${OPENCODE_BIN:-$(command -v opencode || true)}
[[ -n "$OC" ]] || { echo "FAIL: opencode not found on PATH (set OPENCODE_BIN=...)" >&2; exit 1; }

# 先清理，保证幂等
"$SCRIPT_DIR/down.sh" >/dev/null 2>&1 || true

mkdir -p "$ROOT"/{a,b}/{home,xdg,proj}
printf 'SECRET-A\n' > "$ROOT/a/proj/marker.txt"
printf 'SECRET-B\n' > "$ROOT/b/proj/marker.txt"

: > "$ROOT/credentials.env"
chmod 600 "$ROOT/credentials.env"

rand() { python3 -c 'import secrets; print(secrets.token_hex(16))'; }

start_one() {
  local name=$1 port=$2
  local user="isolation-$name"
  local pass; pass=$(rand)
  printf 'OPENCODE_SERVER_USERNAME_%s=%s\nOPENCODE_SERVER_PASSWORD_%s=%s\n' \
    "$name" "$user" "$name" "$pass" >> "$ROOT/credentials.env"
  (
    cd "$ROOT/$name/proj"
    HOME="$ROOT/$name/home" XDG_DATA_HOME="$ROOT/$name/xdg" \
      OPENCODE_SERVER_USERNAME="$user" OPENCODE_SERVER_PASSWORD="$pass" \
      nohup "$OC" serve --port "$port" --pure >"$ROOT/$name/serve.log" 2>&1 &
    echo $! > "$ROOT/$name/pid"
  )
}

start_one a "$PORT_A"
start_one b "$PORT_B"

# 等两个端口都开始回 HTTP（401 也算「起来了」——无凭据本来就该被拒）
wait_up() {
  local name=$1 port=$2
  for _ in $(seq 1 40); do
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$port/" 2>/dev/null) || code=000
    [[ "$code" != "000" ]] && { echo "$code" > "$ROOT/$name/http_code"; return 0; }
    sleep 0.5
  done
  echo "FAIL: $name (port $port) did not start; see $ROOT/$name/serve.log" >&2
  return 1
}

wait_up a "$PORT_A"
wait_up b "$PORT_B"

python3 - "$ROOT" "$PORT_A" "$PORT_B" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]); pa = int(sys.argv[2]); pb = int(sys.argv[3])
state = {
  "root": str(root),
  "nodes": {
    "a": {"port": pa, "url": f"http://127.0.0.1:{pa}", "home": str(root/"a/home"),
          "xdg": str(root/"a/xdg"), "project": str(root/"a/proj"),
          "http_code_without_creds": (root/"a/http_code").read_text().strip()},
    "b": {"port": pb, "url": f"http://127.0.0.1:{pb}", "home": str(root/"b/home"),
          "xdg": str(root/"b/xdg"), "project": str(root/"b/proj"),
          "http_code_without_creds": (root/"b/http_code").read_text().strip()},
  },
  "credentials_file": str(root/"credentials.env"),
  "note": "凭据只写在 credentials_file(600)；本文件不含密码。",
}
(root/"state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(state["nodes"], ensure_ascii=False, indent=2))
PY

echo "fixture up: $ROOT/state.json"
echo "credentials: $ROOT/credentials.env (chmod 600, 不打印内容)"
