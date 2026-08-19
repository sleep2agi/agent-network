#!/usr/bin/env bash
set -euo pipefail

ROOT=/src
source "$ROOT/tests/lib/safe-rm.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }

DIRECT_TRUE='{"ok":true,"message_id":"m1"}'
DIRECT_FALSE='{"ok":false,"error":"alias_not_found"}'
SSE_TRUE='data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"ok\":true,\"message_id\":\"m2\"}"}]}}'
SSE_FALSE='data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"ok\":false,\"error\":\"permission_denied\"}"}]}}'
BARE_FALSE='{"ok":false}'
PLAIN_MCP_TRUE='{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"ok\":true}"}]}}'
RPC_ERROR='data: {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Invalid arguments"}}'

if printf '%s\n' "$SSE_FALSE" | grep -q 'ok'; then
  echo "WITNESSED_RED: legacy grep accepts an inner ok:false MCP response"
else
  fail "legacy witnessed-red fixture did not exercise the old assertion"
fi

WEAK_COUNT=$(python3 - "$ROOT/tests/docker-e2e.sh" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
# 🔴 2026-08-19：原正则是 r"grep -q ['\"]ok['\"]" —— 它要求引号后**紧跟** ok
# 再**紧跟**收尾引号。而 docker-e2e.sh 里的真实形态是：
#     echo "$X" | grep -q '"ok":true' && pass ... || fail ...
# 引号后第一个字符是 `"` 不是 `o`，且 ok 后面是 `":` 不是收尾引号。
# ⇒ 实测：原正则命中 **0** 行，真实形态有 **14** 行。
#   `WEAK_COUNT` 因此结构性恒为 0，下面那句
#   "docker-e2e has no weak grep-ok assertions" 是**恒真**的，这道门永远不可能红。
# 🔴 而它的见证红夹具用的是 `grep -q 'ok'`（正则**能**匹配的字面形态）——
#   变异在夹具上自证，对真实对象一次都没生效。
print(sum(bool(re.search(r"""grep -q ['"]"ok":true['"]""", line)) for line in text.splitlines()))
PY
)
echo "weak_assertions=$WEAK_COUNT"

if [[ ! -f "$ROOT/tests/lib/response-json.sh" ]]; then
  fail "structured response parser is missing"
  fail "docker-e2e still has $WEAK_COUNT weak grep-ok assertions"
  echo "RESULT: $PASS passed, $FAIL failed"
  echo "source_commit=${TEST292_SOURCE_COMMIT}"
  exit 1
fi
source "$ROOT/tests/lib/response-json.sh"

expect_ok() {
  local name=$1 payload=$2
  if response_json_ok "$payload"; then pass "$name"; else fail "$name"; fi
}

expect_not_ok() {
  local name=$1 payload=$2
  if response_json_ok "$payload"; then fail "$name"; else pass "$name"; fi
}

expect_ok "direct REST ok:true" "$DIRECT_TRUE"
expect_not_ok "direct REST ok:false" "$DIRECT_FALSE"
expect_ok "SSE-wrapped MCP inner ok:true" "$SSE_TRUE"
expect_not_ok "SSE-wrapped MCP inner ok:false" "$SSE_FALSE"
expect_ok "plain JSON-RPC MCP inner ok:true" "$PLAIN_MCP_TRUE"
expect_not_ok "JSON-RPC error is not success" "$RPC_ERROR"
expect_not_ok "malformed response fails closed" 'not-json ok'
expect_not_ok "empty response fails closed" ''

# 🔴 棘轮，不是 ==0。修好正则之后这个数是 14，直接要求 0 会让本套件恒红；
#   而把它改回「恒真的 0」等于把刚发现的洞盖回去。⇒ 只许降不许升，目标 0。
WEAK_CEILING=14
if [[ "$WEAK_COUNT" -le "$WEAK_CEILING" ]]; then
  if [[ "$WEAK_COUNT" -lt "$WEAK_CEILING" ]]; then
    pass "weak grep-ok assertions down to $WEAK_COUNT (ceiling $WEAK_CEILING) —— 请把 WEAK_CEILING 调到 $WEAK_COUNT"
  else
    pass "weak grep-ok assertions held at $WEAK_COUNT (ceiling $WEAK_CEILING, 目标 0)"
  fi
else
  fail "docker-e2e still has $WEAK_COUNT weak grep-ok assertions"
fi

# 🔴 2026-08-19：这里原本是 `[[ "$ROBUST_CALLS" == "16" ]]` —— **逐字相等**，
#    而且它的 pass 文案写的是「**all** 16 legacy success assertions use the structured parser」。
#    两处都有问题：
#
#    ① 逐字相等：有人多写一条结构化断言（17 > 16，是**改进**）就判红。
#       实测就是这么红的：`FAIL: expected 16 structured response assertions, got 17`。
#       （同一形状 #1071 在 test292-e2e-residual-fixtures 上修过。）
#
#    ② 🔴 更要紧的是那句「all」是**假的**。数出「有 16 个结构化的」
#       **推不出**「全部都是结构化的」—— 这条判据从来没检查过「还剩几个没转」。
#       实测 2026-08-19 origin/main：
#           结构化  response_json_ok "$…"        17 处
#           未转    … | grep -q '"ok":true'      **14 处**
#       也就是 31 条里有 14 条（45%）根本不是结构化的。
#
#    而未转的那个写法确实更弱 —— 它是**子串匹配**。实测两种判定相反的载荷：
#        {"ok":false,"detail":{"ok":true}}   裸 grep 通过 / response_json_ok 拒绝
#        garbage "ok":true garbage           裸 grep 通过 / response_json_ok 拒绝
#    ⇒ 一个明确失败的响应、以及一段根本不是 JSON 的文本，都会被裸 grep 放行。
#
#    改法：结构化数改**地板**（越多越好，不该判红）；
#          未转数改**棘轮**（只许降不许升），并把「应当降到 0」写在这里。
ROBUST_CALLS=$(grep -c 'response_json_ok "\$' "$ROOT/tests/docker-e2e.sh" || true)
ROBUST_FLOOR=17
if [[ "$ROBUST_CALLS" -ge "$ROBUST_FLOOR" ]]; then
  pass "structured response assertions: $ROBUST_CALLS (floor $ROBUST_FLOOR)"
else
  fail "structured response assertions dropped to $ROBUST_CALLS (floor $ROBUST_FLOOR) —— 有人把结构化断言改回去了"
fi


MUT=$(mktemp -d /tmp/test292-mut.XXXXXX)
trap 'safe_rm_rf "$MUT"' EXIT
cp "$ROOT/tests/lib/response-json.sh" "$MUT/response-json.sh"
sed -i 's/value.get("ok") is True/value.get("ok") is not None/' "$MUT/response-json.sh"
if cmp -s "$ROOT/tests/lib/response-json.sh" "$MUT/response-json.sh"; then
  fail "mutation: exact true predicate was not changed"
fi
set +e
bash -c 'source "$1"; response_json_ok "$2"' _ "$MUT/response-json.sh" "$BARE_FALSE"
MUT_RC=$?
set -e
if [[ "$MUT_RC" -eq 0 ]]; then
  pass "mutation: weakening exact true check turns red"
else
  fail "mutation: weakened parser still rejected bare ok:false"
fi

echo "RESULT: $PASS passed, $FAIL failed"
echo "source_commit=${TEST292_SOURCE_COMMIT}"
[[ "$FAIL" -eq 0 ]]
