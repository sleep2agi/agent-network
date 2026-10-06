#!/usr/bin/env bash
# #622 —— daemon 逐 runtime 自检(runtime_readiness)端到端:真 hub + 真 `anet daemon up`。
#
# 单测验不了、这里验的:
#   - daemon 开机自检的结果真的一路走到 /api/host-supervisors(app 读的那个接口)
#   - CLI 解析看的是**子进程 PATH**(minimalEnv),装在 /usr/local/bin 的假 CLI 被找到
#   - 故意缺一个 CLI(grok)→ missing_cli;故意缺一个登录(codex)→ not_logged_in;
#     有 CLI 有登录但 provider 不通(opencode.ai 被代理拒)→ no_network;其余 ready
#   - 网络探测走 daemon 的 HTTPS_PROXY(容器 --network none,代理是容器内的假 CONNECT 代理)
#   - 埋在凭据文件和 daemon 环境里的假 key 不出现在 hub 响应和 daemon 日志里
#   - can_create_nodes 仍然在、语义不变
#
# 全程在容器里:HOME=$(mktemp -d),hub 在非 9200 端口。
set -uo pipefail

if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite installs fake CLIs into /usr/local/bin and boots a hub; run it in its container." >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE_COMMIT=${RR622_SOURCE_COMMIT:-}
RUNSH_BLOB=${RR622_RUNSH_BLOB:-}
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: RR622_SOURCE_COMMIT must be one full lowercase Git SHA (got '${SOURCE_COMMIT:-unset}')" >&2
  exit 1
fi
_self="$SCRIPT_DIR/run.sh"
_actual=$( { printf 'blob %d\0' "$(wc -c < "$_self")"; cat "$_self"; } | sha1sum | cut -d' ' -f1 )
if [[ "$_actual" != "$RUNSH_BLOB" ]]; then
  echo "FAIL: run.sh in the image is not the one SOURCE_COMMIT=$SOURCE_COMMIT claims (expected blob $RUNSH_BLOB, actual $_actual)" >&2
  exit 1
fi
echo "provenance: source_commit=$SOURCE_COMMIT run.sh blob=$_actual (verified)"

HUB_PORT=9264
PROXY_PORT=9265
HUB_BASE="http://127.0.0.1:$HUB_PORT"
HUB_DB=$(mktemp -u /tmp/qa-rr622-XXXXXX.db)
ADMIN_USER="rr622admin"
ADMIN_PW="rr622_TestPass_1234!"
DAEMON_NAME="rr-daemon"
PLANT_CRED="PLANTED-622-claude-oauth-c0ffee"
PLANT_ENV="PLANTED-622-openai-key-beef"

export HOME=$(mktemp -d /tmp/qa-rr622-home-XXXXXX)
DAEMON_DIR="$HOME/$DAEMON_NAME"

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }

cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  for p in $(pgrep -f "agent-node.*--alias $DAEMON_NAME( |\$)" 2>/dev/null); do kill "$p" 2>/dev/null; done
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# ── 0. 机器形状:装 claude / codex / opencode 假 CLI,故意不装 grok ──────────
note "0. host shape (fake CLIs on the child PATH, grok deliberately absent)"
for spec in "claude:2.1.290 (Claude Code)" "codex:codex-cli 0.155.1" "opencode:1.14.30"; do
  name=${spec%%:*}; ver=${spec#*:}
  printf '#!/bin/sh\necho "%s"\n' "$ver" > "/usr/local/bin/$name"
  chmod 0755 "/usr/local/bin/$name"
done
if command -v grok >/dev/null 2>&1; then bad "precondition: grok must NOT be on PATH ($(command -v grok))"; exit 1; fi
ok "grok absent from PATH (missing-CLI case)"
mkdir -p "$HOME/.claude"
printf '{"claudeAiOauth":{"accessToken":"%s"}}\n' "$PLANT_CRED" > "$HOME/.claude/.credentials.json"
[[ ! -e "$HOME/.codex/auth.json" ]] && ok "no ~/.codex/auth.json (missing-login case)" || { bad "codex auth.json exists"; exit 1; }

# ── 1. 假 CONNECT 代理:放行 anthropic / chatgpt,拒绝其余 ─────────────────
note "1. fake CONNECT proxy :$PROXY_PORT"
cat > /tmp/rr622-proxy.mjs <<'JS'
import { createServer } from "node:net";
const allow = new Set(["api.anthropic.com:443", "chatgpt.com:443"]);
createServer((s) => {
  s.on("error", () => {});
  s.once("data", (d) => {
    const line = d.toString("latin1").split("\r\n")[0];
    const m = /^CONNECT (\S+) HTTP/.exec(line);
    console.log("proxy:", line);
    s.end(m && allow.has(m[1]) ? "HTTP/1.1 200 Connection established\r\n\r\n" : "HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
}).listen(Number(process.argv[2]), "127.0.0.1");
JS
node /tmp/rr622-proxy.mjs "$PROXY_PORT" >/tmp/rr622-proxy.log 2>&1 &
PROXY_PID=$!
sleep 0.5
kill -0 "$PROXY_PID" 2>/dev/null && ok "proxy up" || { bad "proxy did not start"; exit 1; }

# ── 2. hub + daemon ─────────────────────────────────────────────────────
note "2. isolated hub :$HUB_PORT + \`anet daemon up\` (HOME=$HOME)"
[[ "$HUB_PORT" != 9200 ]] && ok "hub port is not 9200" || { bad "refusing to use 9200"; exit 1; }
(cd /app/server && PORT="$HUB_PORT" HOST=127.0.0.1 NODE_ENV=test COMMHUB_DB="$HUB_DB" exec bun run src/index.ts) >/tmp/hub-rr622.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 60); do curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HUB_BASE/health" >/dev/null 2>&1 && ok "hub /health 200" || { bad "hub did not start"; tail -30 /tmp/hub-rr622.log; exit 1; }

REG=$(curl -sS -X POST "$HUB_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"email\":\"rr622@test.local\"}")
UTOK=$(printf '%s' "$REG" | jq -r .token)
[[ "$UTOK" == utok_* ]] && ok "admin utok minted" || { bad "utok mint failed: $REG"; exit 1; }
NET_ID=$(curl -sS "$HUB_BASE/api/auth/me" -H "Authorization: Bearer $UTOK" | jq -r '.networks[0].network_id')
[[ -n "$NET_ID" && "$NET_ID" != null ]] && ok "network = $NET_ID" || { bad "no network"; exit 1; }

mkdir -p "$HOME/.anet" "$DAEMON_DIR"
printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$HUB_BASE" "$UTOK" "$NET_ID" > "$HOME/.anet/config.json"
export ANET_BIN_ABS=$(realpath -e "$(command -v anet)")
export ANET_DAEMON_ALLOW_ENV_BIN=1
# daemon 环境:代理 + 一个**不会**传给子进程的 key(只用于检验 reason 提示且值不外泄)。
(cd "$DAEMON_DIR" && HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT" NO_PROXY="127.0.0.1,localhost" \
   OPENAI_API_KEY="$PLANT_ENV" exec anet daemon up "$DAEMON_NAME") >/tmp/daemon-rr622.log 2>&1 &
DAEMON_PID=$!

HS=""; RR=""
for _ in $(seq 1 90); do
  HS=$(curl -sS "$HUB_BASE/api/host-supervisors?network_id=$NET_ID" -H "Authorization: Bearer $UTOK")
  RR=$(printf '%s' "$HS" | jq -c --arg a "$DAEMON_NAME" '.daemons[]? | select(.alias==$a) | .runtime_readiness // empty' 2>/dev/null)
  [[ -n "$RR" ]] && [[ $(printf '%s' "$RR" | jq 'length') -ge 7 ]] && break
  sleep 1
done
[[ -n "$RR" ]] && ok "runtime_readiness reached /api/host-supervisors" \
  || { bad "runtime_readiness never appeared"; echo "$HS"; tail -40 /tmp/daemon-rr622.log; exit 1; }
echo "$RR" | jq .

# ── 3. 逐 runtime 断言 ───────────────────────────────────────────────────
note "3. per-runtime states"
st() { printf '%s' "$RR" | jq -r --arg r "$1" '.[$r].state // "absent"'; }
expect_state() {
  local rt="$1" want="$2" got; got=$(st "$rt")
  [[ "$got" == "$want" ]] && ok "$rt → $want" || bad "$rt → expected $want, got $got"
}
expect_state claude-agent-sdk ready
expect_state claude-code-cli  ready
expect_state codex-sdk        not_logged_in
expect_state codex-app-server not_logged_in
expect_state grok-build-acp   missing_cli
expect_state grok-build-cli   missing_cli
expect_state opencode-cli     no_network

v=$(printf '%s' "$RR" | jq -r '."claude-code-cli".version // ""')
[[ "$v" == "2.1.290" ]] && ok "claude version from child-PATH CLI = $v" || bad "claude version = '$v'"
ok_ready=$(printf '%s' "$RR" | jq -r '."claude-code-cli".ok')
ok_missing=$(printf '%s' "$RR" | jq -r '."grok-build-acp".ok')
[[ "$ok_ready" == true && "$ok_missing" == false ]] && ok "ok flag matches state" || bad "ok flags: ready=$ok_ready missing=$ok_missing"
reason=$(printf '%s' "$RR" | jq -r '."codex-app-server".reason')
[[ "$reason" == *"codex login"* ]] && ok "not_logged_in reason carries the fix" || bad "codex reason: $reason"
[[ "$reason" == *"OPENAI_API_KEY"* ]] && ok "reason says the daemon-only key does not reach children" || bad "codex reason lacks OPENAI_API_KEY hint: $reason"
net=$(printf '%s' "$RR" | jq -r '."grok-build-acp".network')
[[ "$net" == skipped ]] && ok "missing CLI → network skipped" || bad "grok network = $net"
grep -q "CONNECT api.anthropic.com:443" /tmp/rr622-proxy.log && ok "network probe went through HTTPS_PROXY" || bad "proxy never saw CONNECT"
grep -q "CONNECT opencode.ai:443" /tmp/rr622-proxy.log && ok "opencode.ai probed via proxy (refused → no_network)" || bad "opencode.ai not probed"

# ── 4. 不变量 ────────────────────────────────────────────────────────────
note "4. invariants"
cc=$(printf '%s' "$HS" | jq -r --arg a "$DAEMON_NAME" '.daemons[] | select(.alias==$a) | .can_create_nodes')
[[ "$cc" == true ]] && ok "can_create_nodes unchanged (true)" || bad "can_create_nodes = $cc"
for f in "$HUB_BASE/api/host-supervisors?network_id=$NET_ID"; do
  body=$(curl -sS "$f" -H "Authorization: Bearer $UTOK")
  if printf '%s' "$body" | grep -q "PLANTED-622"; then bad "planted secret leaked into hub response"; else ok "no planted secret in hub response"; fi
done
if grep -q "PLANTED-622" /tmp/daemon-rr622.log; then bad "planted secret leaked into daemon log"; else ok "no planted secret in daemon log"; fi
if printf '%s' "$RR" | grep -q "$HOME"; then bad "machine HOME path leaked into readiness"; else ok "no HOME path in readiness"; fi

printf "\n==== qa-runtime-readiness: PASS=%d FAIL=%d ====\n" "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  tail -40 /tmp/daemon-rr622.log
  exit 1
fi
exit 0
