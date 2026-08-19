#!/bin/bash
# Layer 0 + Layer 2 runtime smoke test

# SHA 绑定（形态同 tests/test746-setup-bun-pin/run.sh:8）：scripts/qa.sh 缺 ARG 时
# **不传且不报错**，断言写在这里才会让缺失显形。
[[ "${TEST8_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST8_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST8_SOURCE_COMMIT"

PASS=0
FAIL=0
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"
BASE="http://127.0.0.1:9200"
TMP="/tmp/test8-runtime"
mkdir -p "$TMP"

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

# 🔴 master token 已被产品废弃（server/src/server.ts:169-170）：
#   const readOnlyApi = u.pathname.startsWith("/api/") && (req.method === "GET" || ...);
#   if (!readOnlyApi) return Response.json({ ok:false,
#     error:"master-token auth is deprecated; use admin utok_" }, { status:401 });
# 本套件此前全程用它，于是 SSE / mcp_call / 部分 /api 调用全部 401 —— 不是回归。
# UTOK 在 main() 里注册后赋值；注册这一步仍用 master token（与 tests/test-npm-api 同一写法，实测可用）。
UTOK=""
api_get() {
  curl -s -H "Authorization: Bearer ${UTOK:-$AUTH_TOKEN}" "$@"
}

mcp_call() {
  local tool="$1"
  local args="$2"
  local tok="${3:-${UTOK:-$AUTH_TOKEN}}"   # 第三参数可指定令牌；默认 utok_
  # 统一在 helper 里注入 network_id：逐个改调用点正是上一版漏掉第三处的原因
  if [ -n "${NET_ID:-}" ]; then
    args=$(printf '%s' "$args" | python3 -c 'import json,sys; d=json.load(sys.stdin); d.setdefault("network_id", sys.argv[1]); print(json.dumps(d))' "$NET_ID" 2>/dev/null || printf '%s' "$args")
  fi
  timeout 10 curl -s -X POST "${BASE}/mcp" \
    -H "Authorization: Bearer ${tok}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"t\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}" 2>/dev/null || true
}

wait_for_status_alias() {
  local alias="$1"
  local timeout_s="${2:-12}"
  local i
  for i in $(seq 1 "$timeout_s"); do
    if api_get "${BASE}/api/status?network_id=${NET_ID}" | grep -q "\"alias\":\"${alias}\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo ""
echo "═══ Test 8: Runtime + SSE Smoke ═══"
echo ""

echo "1. Server health"
cd /app/server && COMMHUB_AUTH_TOKEN="${AUTH_TOKEN}" bun run src/index.ts >"${TMP}/server.log" 2>&1 &
sleep 4
curl -s "${BASE}/health" | grep -q '"ok":true' && pass "server started" || fail "server start"
curl -s "${BASE}/health" | grep -q '"transport":"streamable-http"' && pass "streamable HTTP enabled" || fail "transport mode"
echo ""

echo "2. agent-node binary"
agent-node --version 2>&1 | grep -q "agent-node" && pass "agent-node installed" || fail "agent-node missing"
echo ""

echo "2.5 admin utok_ + master-token 废弃边界"
REG=$(curl -s -X POST "${BASE}/api/auth/register" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" -H "Content-Type: application/json" \
  -d '{"username":"test8admin","password":"pass123456"}')
UTOK=$(echo "$REG" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
NET_ID=$(echo "$REG" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("network_id",""))' 2>/dev/null)
# 🔴 utok_ 没有隐式 network（守卫原文：
#   {"ok":false,"error":"network_id required (utok has no implicit network; pass ?network_id=<id>)"}）
# ⇒ 下面四类调用点都必须显式带 network：
#   A /api/status 查询(2 处) B mcp_call(2 处) C 节点 config.json D agent-node --network
# 我上一版就是只改了两处 helper、漏了第三处内联 curl，所以这次先数清楚再改。
[ -n "$NET_ID" ] && pass "network_id resolved ($NET_ID)" || fail "no network_id in register response"
# 🔴 agent-node 不读本脚本的变量，它读 /root/.anet/config.json ——
# 而 Dockerfile 第 20 行往里塞的是 master token，于是它自己的 report_status 也 401：
#   SB [CommHubError]: callCommHub(report_status) HTTP 401 after 3 retries
# 这是同一条废弃规则的**第三个到达路径**（脚本 helper / 内联 SSE curl / 节点配置）。
# 🔴 节点注册必须用 **ntok_**，不是 utok_。给 utok 时 Hub 应用层拒绝：
#   SB [CommHubError]: app-level rejection: network_token_required
#   payload: { ok: false, error: 'network_token_required' }
# 而且按 #203 身份守卫，ntok 的 node_name 必须与节点 alias 一致（这里 test8-http），
# 否则 report_status 会被 alias_identity_mismatch 拒（见 tests/test198-from-alias）。
if [ -n "$UTOK" ]; then
  NODETOK=$(curl -s -X POST "${BASE}/api/auth/node-token" \
    -H "Authorization: Bearer ${UTOK}" -H "Content-Type: application/json" \
    -d "{\"network_id\":\"${NET_ID}\",\"node_name\":\"test8-http\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
  case "$NODETOK" in
    ntok_*) pass "node token (ntok_) minted for test8-http" ;;
    *) fail "could not mint ntok_ for test8-http" ;;
  esac
  printf '{"hub":"%s","token":"%s","network_id":"%s"}\n' "$BASE" "$NODETOK" "$NET_ID" > /root/.anet/config.json
fi
[ -n "$UTOK" ] && pass "admin utok_ obtained" || { echo "$REG"; fail "could not obtain utok_"; }

# 🔴 新增的负向断言：把「本套件原来依赖的那条路」钉成【必须被拒】。
# 只把 AUTH_TOKEN 换成 UTOK 是「让它能过」；再加这一条，才是把废弃边界真正测住。
DEPR=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/networks" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" -H "Content-Type: application/json" -d '{"name":"should-be-rejected"}')
[ "$DEPR" = "401" ] && pass "master token rejected on write (deprecated)" || fail "master token write expected 401 got $DEPR"
echo ""

echo "3. codex-sdk runtime startup"
if command -v codex >/dev/null 2>&1; then
  timeout 8 agent-node --alias test8-codex --runtime codex-sdk >"${TMP}/codex.log" 2>&1 &
  sleep 5
  if wait_for_status_alias "test8-codex" 8; then
    pass "codex-sdk runtime registered"
  else
    cat "${TMP}/codex.log"
    fail "codex-sdk runtime did not register"
  fi
else
  pass "codex binary absent, codex-sdk startup skipped by design"
fi
echo ""

echo "4. claude-agent-sdk runtime startup"
# 🔴 原来是 --runtime http-api。agent-node --help 现在列出的白名单是：
#   claude-agent-sdk (default) | codex-sdk | codex-app-server | grok-build-acp
#   | grok-build-cli | opencode-cli
# http-api 已不在其中（同 #1112 ③ 那条 anet 侧白名单）。不是回归。
# 换成 claude-agent-sdk（默认运行时，注册发生在任何模型调用之前，mock key 足够）。
ANTHROPIC_API_KEY="mock-api-key" timeout 8 agent-node --alias test8-http --runtime claude-agent-sdk >"${TMP}/http.log" 2>&1 &
sleep 5
if wait_for_status_alias "test8-http" 8; then
  pass "claude-agent-sdk runtime registered with mock key"
else
  cat "${TMP}/http.log"
  fail "claude-agent-sdk runtime did not register"
fi
echo ""

echo "5. SSE connect"
# 🔴 第 5 个调用点。utok_ 订阅 SSE 也要显式 network —— 守卫原文 server/src/server.ts:860-864：
#   if (!scopedNetId) return ... "network_id required (utok has no implicit network; pass ?network_id=<id>)"
# 我上一版「先数清调用点」数的是【认证头】，而 network 作用域的要求落在**另一组**端点上
# （任何 utok 认证的端点，包括这个 SSE URL）。两组不重合，是我漏它的原因。
# ⚠️ 注释必须放在整条命令【之前】：反斜杠续行中间插注释会截断命令，
#    而那样产生的失败长得跟「SSE 连不上」一模一样（我就这么骗过自己一轮）。
timeout 10 curl -N -s \
  -H "Authorization: Bearer ${UTOK:-$AUTH_TOKEN}" \
  "${BASE}/events/test8-http?network_id=${NET_ID}" >"${TMP}/sse.log" 2>&1 &
sleep 2
grep -q '"type":"connected"' "${TMP}/sse.log" && pass "SSE connected" || fail "SSE did not connect"
echo ""

echo "6. send_task push"
SEND_RESP=$(mcp_call "send_task" '{"alias":"test8-http","task":"runtime layer2 task","from_session":"test8","priority":"high"}')
sleep 2
if grep -q '"type":"new_task"' "${TMP}/sse.log"; then
  pass "send_task triggered SSE new_task"
else
  echo "$SEND_RESP"
  cat "${TMP}/sse.log"
  fail "send_task did not reach SSE subscriber"
fi
echo ""

echo "7. report_status visibility"
# 🔴 report_status 也要 network token —— 用 utok_ 调会被应用层拒：
#   {"ok":false,"error":"network_token_required"}
# 先把这条【新增】成一条负向断言（它此前无人覆盖），再用对的令牌走 happy path。
DENIED=$(mcp_call "report_status" '{"resume_id":"test8-deny","alias":"test8-status","status":"idle"}' "$UTOK")
echo "$DENIED" | grep -q 'network_token_required' \
  && pass "report_status via utok_ is rejected (network_token_required)" \
  || fail "utok_ report_status expected network_token_required, got: $(echo "$DENIED" | head -c 120)"

# happy path：铸一个 node_name 与别名一致的 ntok_（#203 要求一致）
STATTOK=$(curl -s -X POST "${BASE}/api/auth/node-token" \
  -H "Authorization: Bearer ${UTOK}" -H "Content-Type: application/json" \
  -d "{\"network_id\":\"${NET_ID}\",\"node_name\":\"test8-status\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
STATUS_RESP=$(mcp_call "report_status" '{"resume_id":"test8-manual","alias":"test8-status","status":"idle","task":"runtime status check"}' "$STATTOK")
sleep 1
if api_get "${BASE}/api/status?network_id=${NET_ID}" | grep -q '"alias":"test8-status"'; then
  pass "report_status visible in /api/status"
else
  echo "$STATUS_RESP"
  fail "report_status missing from /api/status"
fi
echo ""

echo "═══════════════════════════════════"
echo "  Test 8 Result: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ $FAIL -eq 0 ] && exit 0 || exit 1
