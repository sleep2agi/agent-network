#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
SERVER=$ROOT/tests/helpers/mock-llm-server.ts
MOCK_MODULE=$ROOT/agent-network/src/mock-llm.ts
FIXTURES=$ROOT/tests/test30-mock-llm-smoke/fixtures
PORT=32130
PASS=0
FAIL=0
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT=$ARTIFACT_DIR/report-test30-mock-llm-protocol.txt

mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$REPORT") 2>&1

pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }
finish() {
  if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap finish EXIT

echo "# test30 — deterministic mock LLM protocol"
echo "source_commit=${TEST30_SOURCE_COMMIT:-unknown}"

(cd "$ROOT/agent-network" && bun run typecheck >/tmp/test30.typecheck 2>&1) \
  && pass "agent-network typecheck" || { cat /tmp/test30.typecheck; fail "agent-network typecheck"; }

start_server() {
  : > /tmp/test30.stdout
  : > /tmp/test30.stderr
  MOCK_LLM_REPLIES_FILE=$FIXTURES/replies.jsonl MOCK_LLM_PORT=$PORT \
    bun "$SERVER" >/tmp/test30.stdout 2>/tmp/test30.stderr &
  server_pid=$!
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$PORT/health" >/tmp/test30.health && return 0
    sleep 0.1
  done
  cat /tmp/test30.stdout /tmp/test30.stderr
  return 1
}

reply() {
  curl -fsS -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg prompt "$1" '{prompt:$prompt}')" \
    "http://127.0.0.1:$PORT/reply"
}

start_server
jq -e '.ok == true and .rules == 4' /tmp/test30.health >/dev/null && pass "health exposes immutable rule count" || fail "health"

first=$(reply 'please review security now')
jq -e '.matched == true and .rule_index == 0 and .reply == "broad review response"' <<<"$first" >/dev/null \
  && pass "first matching rule wins" || fail "first match"

step_a=$(reply 'step-1 introduce yourself')
step_b=$(reply 'step-2 yesterday')
jq -e '.reply == "Hi, I am reviewer A."' <<<"$step_a" >/dev/null \
  && jq -e '.reply == "Yesterday I reviewed PR 42."' <<<"$step_b" >/dev/null \
  && pass "step discriminators support multi-turn fixtures" || fail "step fixtures"

repeat_a=$(reply 'step-1 introduce yourself')
repeat_b=$(reply 'step-1 introduce yourself')
[[ "$repeat_a" == "$repeat_b" ]] && pass "repeated prompt is stateless and deterministic" || fail "stateless repeat"

fallback=$(reply 'no fixture matches this prompt')
jq -e '.matched == false and .rule_index == null and .reply == "(mock LLM: no rule matched)"' <<<"$fallback" >/dev/null \
  && grep -Fq '[mock-llm] warning: no rule matched prompt' /tmp/test30.stderr \
  && pass "unmatched prompt returns fallback and warns" || fail "fallback warning"

bad_status=$(curl -sS -o /tmp/test30.bad -w '%{http_code}' -H 'Content-Type: application/json' --data '{' "http://127.0.0.1:$PORT/reply")
[[ "$bad_status" == 400 ]] && jq -e '.error == "invalid_json"' /tmp/test30.bad >/dev/null \
  && pass "invalid request JSON fails closed" || fail "invalid request"

kill "$server_pid"
wait "$server_pid" || true
unset server_pid

set +e
MOCK_LLM_REPLIES_FILE=$FIXTURES/invalid.jsonl MOCK_LLM_PORT=$PORT bun "$SERVER" >/tmp/test30.invalid.out 2>/tmp/test30.invalid.err
invalid_rc=$?
set -e
[[ "$invalid_rc" -ne 0 ]] && grep -Fq 'invalid JSON on line 2' /tmp/test30.invalid.err \
  && pass "malformed rules fail before listen" || fail "malformed rules"

set +e
MOCK_LLM_REPLIES_FILE=$FIXTURES/unknown-key.jsonl MOCK_LLM_PORT=$PORT bun "$SERVER" >/tmp/test30.schema.out 2>/tmp/test30.schema.err
schema_rc=$?
set -e
[[ "$schema_rc" -ne 0 ]] && grep -Fq 'must contain exactly one in_substring and one out' /tmp/test30.schema.err \
  && pass "unknown rule keys fail before listen" || fail "unknown rule keys"

set +e
MOCK_LLM_REPLIES_FILE=$FIXTURES/duplicate-key.jsonl MOCK_LLM_PORT=$PORT bun "$SERVER" >/tmp/test30.duplicate.out 2>/tmp/test30.duplicate.err
duplicate_rc=$?
MOCK_LLM_REPLIES_FILE=$FIXTURES/non-string.jsonl MOCK_LLM_PORT=$PORT bun "$SERVER" >/tmp/test30.type.out 2>/tmp/test30.type.err
type_rc=$?
set -e
[[ "$duplicate_rc" -ne 0 ]] && grep -Fq 'must contain exactly one in_substring and one out' /tmp/test30.duplicate.err \
  && pass "duplicate rule keys fail before listen" || fail "duplicate rule keys"
[[ "$type_rc" -ne 0 ]] && grep -Fq 'out must be a non-empty string' /tmp/test30.type.err \
  && pass "non-string rule values fail before listen" || fail "non-string rule values"

echo "L1 real demo orchestration with deterministic replies"
demo_home=/tmp/test30-demo-home
mkdir -p "$demo_home"
MOCK_LLM_REPLIES_FILE=$FIXTURES/demo-replies.jsonl HOME=$demo_home \
  bun "$ROOT/agent-network/bin/cli.ts" demo pr-review \
    --diff "$FIXTURES/sample.diff" --suffix mock30 --out /tmp/test30-review.md \
    >/tmp/test30.demo.out 2>/tmp/test30.demo.err
grep -Fq '[3/6] 广播 review task 给 3 reviewer (parallel)' /tmp/test30.demo.out \
  && grep -Fq '[4/6] barrier 收齐 3 份 review' /tmp/test30.demo.out \
  && grep -Fq '[6/6] 写入 review' /tmp/test30.demo.out \
  && grep -Fq '**决议：** LGTM' /tmp/test30-review.md \
  && grep -Fq '无安全问题。' /tmp/test30-review.md \
  && grep -Fq '无性能问题。' /tmp/test30-review.md \
  && grep -Fq '无风格问题。' /tmp/test30-review.md \
  && pass "real pr-review fan-out, barrier, and markdown use deterministic replies" \
  || fail "real demo orchestration"

env -u MOCK_LLM_REPLIES_FILE HOME=$demo_home \
  bun "$ROOT/agent-network/bin/cli.ts" demo pr-review \
    --diff "$FIXTURES/sample.diff" --suffix real30 --out /tmp/test30-real.md \
    >/tmp/test30.real.out 2>/tmp/test30.real.err
grep -Fq "没有 hub" /tmp/test30.real.err \
  && ! grep -Fq '使用确定性 mock LLM' /tmp/test30.real.out \
  && [[ ! -e /tmp/test30-real.md ]] \
  && pass "unset mock env preserves the real Hub preflight" \
  || fail "unset env fail-safe"

echo "L2 witnessed-red: first-match ordering is load-bearing"
cp "$MOCK_MODULE" /tmp/test30.module.orig
sed -i 's/rules\.findIndex((rule) => prompt\.includes(rule\.in_substring))/rules.findLastIndex((rule) => prompt.includes(rule.in_substring))/' "$MOCK_MODULE"
if cmp -s "$MOCK_MODULE" /tmp/test30.module.orig; then
  echo "MUTATION_NOOP: first-match"
  exit 1
fi
start_server
mutated=$(reply 'please review security now')
if jq -e '.rule_index == 0 and .reply == "broad review response"' <<<"$mutated" >/dev/null; then
  echo "MUTATION_FALSE_GREEN: first-match"
  exit 1
fi
echo "MUTATION_RED: first-match"
kill "$server_pid"
wait "$server_pid" || true
unset server_pid
cp /tmp/test30.module.orig "$MOCK_MODULE"

echo "L3 witnessed-red: fallback warning is load-bearing"
sed -i '/warn(`\[mock-llm\] warning: no rule matched prompt/d' "$MOCK_MODULE"
if cmp -s "$MOCK_MODULE" /tmp/test30.module.orig; then
  echo "MUTATION_NOOP: fallback-warning"
  exit 1
fi
start_server
reply 'still unmatched' >/tmp/test30.mut-fallback
if grep -Fq '[mock-llm] warning: no rule matched prompt' /tmp/test30.stderr; then
  echo "MUTATION_FALSE_GREEN: fallback-warning"
  exit 1
fi
echo "MUTATION_RED: fallback-warning"
kill "$server_pid"
wait "$server_pid" || true
unset server_pid
cp /tmp/test30.module.orig "$MOCK_MODULE"

echo "L4 witnessed-red: removing the explicit opt-in gate cannot pass"
CLI=$ROOT/agent-network/bin/cli.ts
cp "$CLI" /tmp/test30.cli.orig
sed -i 's/const mockMode = Object\.prototype\.hasOwnProperty\.call(process\.env, "MOCK_LLM_REPLIES_FILE");/const mockMode = true;/' "$CLI"
if cmp -s "$CLI" /tmp/test30.cli.orig; then
  echo "MUTATION_NOOP: mock-opt-in"
  exit 1
fi
set +e
env -u MOCK_LLM_REPLIES_FILE HOME=$demo_home \
  bun "$CLI" demo pr-review --diff "$FIXTURES/sample.diff" --suffix mutated30 --out /tmp/test30-mutated.md \
  >/tmp/test30.mut-optin.out 2>/tmp/test30.mut-optin.err
mut_optin_rc=$?
set -e
if [[ "$mut_optin_rc" -eq 0 ]] || grep -Fq "没有 hub" /tmp/test30.mut-optin.err; then
  echo "MUTATION_FALSE_GREEN: mock-opt-in"
  exit 1
fi
grep -Fq 'MOCK_LLM_REPLIES_FILE is required' /tmp/test30.mut-optin.err
echo "MUTATION_RED: mock-opt-in"
cp /tmp/test30.cli.orig "$CLI"

echo "RESULT: PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
