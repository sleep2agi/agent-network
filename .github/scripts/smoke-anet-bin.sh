#!/usr/bin/env bash
# Smoke a standalone `anet` binary against the sidecar written by
# scripts/build-anet-bin.mjs (`*.build.json`).
#
#   bash .github/scripts/smoke-anet-bin.sh dist/anet-linux-x64 dist/anet-linux-x64.build.json
#
# Checks: --version (anet + bundle + embedded agent-node / commhub-server),
# --help, `__node --version` / `--help`, `__hub --version`, `__hub` /health,
# and the 110MB size gate. Does not publish.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: smoke-anet-bin.sh <binary> <build.json>" >&2
  exit 2
fi

bin=$1
meta=$2
if [[ ! -x "$bin" ]]; then
  echo "smoke: not an executable: $bin" >&2
  exit 1
fi

expect_env=$(mktemp)
trap 'rm -f "$expect_env"' EXIT
python3 - "$meta" <<'PY' >"$expect_env"
import json, shlex, sys
meta = json.load(open(sys.argv[1], encoding="utf-8"))
need = ("anet", "agentNode", "commhubServer", "bundle", "bytes")
missing = [k for k in need if k not in meta]
if missing:
    raise SystemExit(f"build.json missing {missing}")
for key in ("anet", "agentNode", "commhubServer", "bundle"):
    value = meta[key]
    if not isinstance(value, str) or not value or any(c in value for c in "\n\r"):
        raise SystemExit(f"bad {key} in build.json")
    print(f"{key}={shlex.quote(value)}")
print(f"bytes={int(meta['bytes'])}")
PY
# shellcheck disable=SC1090
source "$expect_env"
rm -f "$expect_env"
trap - EXIT

limit=115343360 # 110 MiB
actual=$(python3 -c 'import os,sys; print(os.path.getsize(sys.argv[1]))' "$bin")
if [[ "$actual" != "$bytes" ]]; then
  echo "smoke: binary size $actual != build.json bytes $bytes" >&2
  exit 1
fi
if [[ "$actual" -gt "$limit" ]]; then
  echo "smoke: $actual bytes exceeds ${limit} (110 MiB)" >&2
  exit 1
fi

out=$("$bin" --version)
first=${out%%$'\n'*}
if [[ "$first" != "anet v${anet}" ]]; then
  echo "smoke: --version first line [$first] expected [anet v${anet}]" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
case "$out" in
  *"standalone bundle v${bundle}"*) ;;
  *) echo "smoke: --version missing standalone bundle v${bundle}" >&2; printf '%s\n' "$out" >&2; exit 1 ;;
esac
case "$out" in
  *"agent-node v${agentNode}"*) ;;
  *) echo "smoke: --version missing agent-node v${agentNode}" >&2; printf '%s\n' "$out" >&2; exit 1 ;;
esac
case "$out" in
  *"commhub-server v${commhubServer}"*) ;;
  *) echo "smoke: --version missing commhub-server v${commhubServer}" >&2; printf '%s\n' "$out" >&2; exit 1 ;;
esac

"$bin" --help >/dev/null

node_out=$("$bin" __node --version)
node_first=${node_out%%$'\n'*}
if [[ "$node_first" != "agent-node v${agentNode}" ]]; then
  echo "smoke: __node --version [$node_first] expected [agent-node v${agentNode}]" >&2
  exit 1
fi
"$bin" __node --help >/dev/null

hub_out=$("$bin" __hub --version)
hub_first=${hub_out%%$'\n'*}
if [[ "$hub_first" != "$commhubServer" ]]; then
  echo "smoke: __hub --version [$hub_first] expected [$commhubServer]" >&2
  exit 1
fi

work=$(mktemp -d)
cleanup() {
  if [[ -n "${hub_pid:-}" ]]; then
    kill "$hub_pid" 2>/dev/null || true
    wait "$hub_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
db="$work/hub.db"
"$bin" __hub --port "$port" --host 127.0.0.1 --dev-open --db "$db" >"$work/hub.log" 2>&1 &
hub_pid=$!

health="$work/health.json"
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if ! kill -0 "$hub_pid" 2>/dev/null; then
    echo "smoke: embedded hub exited before /health" >&2
    cat "$work/hub.log" >&2 || true
    exit 1
  fi
  code=$(curl -sS -o "$health" -w '%{http_code}' "http://127.0.0.1:${port}/health" 2>>"$work/hub.log" || true)
  if [[ "$code" == "200" ]]; then
    ok=1
    break
  fi
  sleep 1
done
if [[ "$ok" != "1" ]]; then
  echo "smoke: /health did not return 200" >&2
  cat "$work/hub.log" >&2 || true
  exit 1
fi
python3 - "$health" "$commhubServer" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding="utf-8"))
version = sys.argv[2]
if body.get("ok") is not True:
    raise SystemExit(f"/health ok is {body.get('ok')!r}")
if body.get("version") != version:
    raise SystemExit(f"/health version {body.get('version')!r} != {version!r}")
PY

echo "smoke: ok ($actual bytes)"
