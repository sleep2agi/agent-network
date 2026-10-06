#!/usr/bin/env bash
# Board #672. Fake key against a local upstream. The first 401 is the CLI's
# token refresh and must be allowed to succeed (401 then 200 returns ok).
# A 401 that is still a 401 on the next attempt aborts, and the real
# no-retry-after shape must not keep requesting afterwards. A 429 must still
# reach the upstream a second time. Mutations of those decisions, of the
# abort-vs-403 short-circuit, and of the idle status hint, must go red.
set -euo pipefail

[[ "${TEST672_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST672_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST672_SOURCE_COMMIT"

HELPER=/src/claude-auth-retry.ts
CLI=/src/cli.ts
AUTH_ANCHOR='  if (error === "authentication_failed" || status === 401 || status === 403) return true;'
AUTH_REPL='  if (false && (error === "authentication_failed" || status === 401 || status === 403)) return true;'
CAPACITY_ANCHOR='  if (capacity) return false;'
CAPACITY_REPL='  if (capacity) return true;'
HINT_ANCHOR='  return { status: "error", task: CLAUDE_LOGIN_STATUS_HINT };'
HINT_REPL='  return { status: input.status, task: input.task };'
# Aborting on attempt 1 drops the refresh retry. The recover mock (401 then
# 200) is the case that must go red; the persistent-401 case can still pass.
ATTEMPT_ANCHOR='  if (attempt >= 2) {'
ATTEMPT_REPL='  if (attempt >= 1) {'
# The short-circuit lives in the helper the catch calls. Turning it off lets
# a region 403 thrown while aborting replace the login result.
GUARD_ANCHOR='  if (authAbortedThisAttempt) {'
GUARD_REPL='  if (false && authAbortedThisAttempt) {'
# cli.ts is not executed. These three anchors are a static guard: the same
# mutations the re-review applied, which used to leave the suite green.
CLI_FLAG_ANCHOR='              authAbortedThisAttempt = true;'
CLI_FLAG_REPL='              authAbortedThisAttempt = false;'
CLI_ABORT_ANCHOR='            if (authDecision.action === "abort") {'
CLI_ABORT_REPL='            if (false && authDecision.action === "abort") {'
CLI_CATCH_ANCHOR='      if (thrown.action === "stop") {'
CLI_CATCH_REPL='      if (false && thrown.action === "stop") {'

need_count() {
  local n
  n=$(grep -F -c "$1" "$2" || true)
  if [[ "$n" != "$3" ]]; then
    echo "FAIL: count of [$1] in $2 is $n, expected $3"
    exit 1
  fi
}

need_count "$AUTH_ANCHOR" "$HELPER" 1
need_count "$CAPACITY_ANCHOR" "$HELPER" 1
need_count "$HINT_ANCHOR" "$HELPER" 1
need_count "$ATTEMPT_ANCHOR" "$HELPER" 1
need_count "$GUARD_ANCHOR" "$HELPER" 1
need_count 'aborting the attempt' "$CLI" 1
need_count 'claudeAuthRetryDecision(m)' "$CLI" 1
need_count 'claudeThrownErrorDisposition(msg, authAbortedThisAttempt)' "$CLI" 1
need_count "$CLI_FLAG_ANCHOR" "$CLI" 1
need_count "$CLI_ABORT_ANCHOR" "$CLI" 1
need_count "$CLI_CATCH_ANCHOR" "$CLI" 1
need_count 'claudeAuthStatusReport({' "$CLI" 1
need_count 'markClaudeLoginDead();' "$CLI" 2
if grep -F -q 'CLAUDE_CODE_MAX_RETRIES' "$CLI" || grep -F -q 'CLAUDE_CODE_MAX_RETRIES' "$HELPER"; then
  echo 'FAIL: product sets CLAUDE_CODE_MAX_RETRIES'
  exit 1
fi

run_probe() {
  ( cd /opt/sdk && bun /test672/probe.ts "$1" )
}

apply_mutation() {
  bun -e '
    const fs = require("fs");
    const path = process.argv[1];
    const anchor = process.argv[2];
    const repl = process.argv[3];
    const text = fs.readFileSync(path, "utf8");
    const n = text.split(anchor).length - 1;
    if (n !== 1) {
      console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
      process.exit(1);
    }
    fs.writeFileSync(path, text.replace(anchor, repl));
  ' "$1" "$2" "$3"
}

expect_red() {
  local label="$1" mode="$2" needle="$3"
  rm -rf /root/.bun/install/cache /tmp/bun-* "${HOME:-/root}/.bun/install/cache" 2>/dev/null || true
  set +e
  run_probe "$mode" > /tmp/test672-red.txt 2>&1
  local rc=$?
  set -e
  cat /tmp/test672-red.txt
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: $label stayed green"
    exit 1
  fi
  if ! grep -F -q "$needle" /tmp/test672-red.txt; then
    echo "FAIL: $label died for a reason other than: $needle"
    exit 1
  fi
  echo "$label red as required"
}

echo '== green: pure rules, cli wiring =='
run_probe pure
run_probe wiring

echo '== green: 401 then 200 recovers =='
run_probe recover

echo '== green: a 401 that is still a 401 aborts, real shape, no retry-after =='
run_probe auth

echo '== green: 429 is not aborted =='
run_probe capacity

echo '== red: 401 is no longer an auth failure =='
cp "$HELPER" /tmp/helper.bak
apply_mutation "$HELPER" "$AUTH_ANCHOR" "$AUTH_REPL"
expect_red 'auth predicate' auth 'FAIL: auth retry was not stopped'
cp /tmp/helper.bak "$HELPER"

echo '== red: capacity api_retry is treated as auth =='
apply_mutation "$HELPER" "$CAPACITY_ANCHOR" "$CAPACITY_REPL"
expect_red 'capacity predicate' capacity 'FAIL: capacity retry was aborted'
cp /tmp/helper.bak "$HELPER"

echo '== red: idle report no longer publishes the hint =='
apply_mutation "$HELPER" "$HINT_ANCHOR" "$HINT_REPL"
expect_red 'status hint' pure 'FAIL: idle report must publish the login hint'
cp /tmp/helper.bak "$HELPER"

echo '== red: attempt 1 is aborted, so 401 then 200 cannot recover =='
apply_mutation "$HELPER" "$ATTEMPT_ANCHOR" "$ATTEMPT_REPL"
expect_red 'attempt threshold' recover 'FAIL: a 401 then 200 was treated as a dead login'
cp /tmp/helper.bak "$HELPER"

echo '== red: an aborted attempt is reclassified as the thrown 403 =='
apply_mutation "$HELPER" "$GUARD_ANCHOR" "$GUARD_REPL"
expect_red 'abort short-circuit' pure 'FAIL: aborted attempt must not be reclassified'
cp /tmp/helper.bak "$HELPER"

echo '== red: static guard, cli.ts does not set authAbortedThisAttempt (M6) =='
cp "$CLI" /tmp/cli.bak
apply_mutation "$CLI" "$CLI_FLAG_ANCHOR" "$CLI_FLAG_REPL"
expect_red 'cli abort flag' wiring 'FAIL: authAbortedThisAttempt is not set on abort'
cp /tmp/cli.bak "$CLI"

echo '== red: static guard, cli.ts catch branch is off (M7) =='
apply_mutation "$CLI" "$CLI_CATCH_ANCHOR" "$CLI_CATCH_REPL"
expect_red 'cli catch branch' wiring 'FAIL: cli catch branch was removed'
cp /tmp/cli.bak "$CLI"

echo '== red: static guard, cli.ts abort branch is off (M8) =='
apply_mutation "$CLI" "$CLI_ABORT_ANCHOR" "$CLI_ABORT_REPL"
expect_red 'cli abort branch' wiring 'FAIL: cli abort branch was removed'
cp /tmp/cli.bak "$CLI"

echo 'TEST672_OK'
