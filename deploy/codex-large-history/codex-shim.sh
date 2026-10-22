#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CODEX_ACTUAL_BIN="${ANET_CODEX_ACTUAL_BIN:-codex}"
runtime_file="${CODEX_HOME:-/nonexistent}/../large-history-start.json"
if [[ -f "$runtime_file" ]]; then
  CODEX_ACTUAL_BIN="${ANET_CODEX_ACTUAL_BIN:-$(node -p 'require(process.argv[1]).codexBin' "$runtime_file")}"
  ANET_CODEX_TUI_PROXY_PORT="${ANET_CODEX_TUI_PROXY_PORT:-$(node -p 'require(process.argv[1]).proxyPort' "$runtime_file")}"
fi
if [[ "${1:-}" != resume ]]; then exec "$CODEX_ACTUAL_BIN" "$@"; fi
declare -a codex_args=("$@")
upstream=""; thread=""
for ((i=0; i<${#codex_args[@]}; i++)); do
  if [[ "${codex_args[i]}" == --remote ]]; then
    upstream="${codex_args[i+1]}"
    thread="${codex_args[i+2]}"
    proxy_port="${ANET_CODEX_TUI_PROXY_PORT:-24701}"
    codex_args[i+1]="ws://127.0.0.1:$proxy_port"
    break
  fi
done
if [[ -z "$upstream" || -z "$thread" ]]; then exec "$CODEX_ACTUAL_BIN" "$@"; fi
proxy_log_dir="${CODEX_HOME:?CODEX_HOME must be set}/log"
mkdir -p -- "$proxy_log_dir"
chmod 700 "$proxy_log_dir"
node "$SCRIPT_DIR/preview-proxy.cjs" "$upstream" "$proxy_port" "$thread" >>"$proxy_log_dir/anet-tui-preview-proxy.log" 2>&1 &
proxy_pid=$!
cleanup() { kill "$proxy_pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
for ((i=0; i<100; i++)); do
  kill -0 "$proxy_pid" 2>/dev/null || exit 1
  if node -e 'const net=require("node:net"); const s=net.connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));' "$proxy_port"; then break; fi
  sleep 0.1
done
"$CODEX_ACTUAL_BIN" "${codex_args[@]}"
