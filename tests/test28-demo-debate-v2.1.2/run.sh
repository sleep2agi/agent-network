#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR=/tmp/anet-demo-debate-v2.1.2
HOME_DIR=/tmp/anet-demo-home
NETWORK_SUFFIX="$(date +%s)-$RANDOM"
OUT_MD="$LOG_DIR/debate-output.md"
mkdir -p "$LOG_DIR" "$HOME_DIR"
export HOME="$HOME_DIR"
export COMMHUB_URL="http://127.0.0.1:9200"
export ANET_HUB="$COMMHUB_URL"

cleanup() {
  set +e
  tmux kill-server >/dev/null 2>&1
  pkill -f commhub-server >/dev/null 2>&1
  pkill -f agent-network-dashboard >/dev/null 2>&1
}
trap cleanup EXIT

section() { echo ""; echo "========== $* =========="; }
fail() {
  echo "FAIL: $*" >&2
  echo ""
  echo "---- anet -v ----"; tail -80 "$LOG_DIR/anet-version.log" 2>/dev/null || true
  echo "---- hub ----"; tail -120 "$LOG_DIR/hub.log" 2>/dev/null || true
  echo "---- login ----"; tail -80 "$LOG_DIR/login.log" 2>/dev/null || true
  echo "---- demo ----"; tail -160 "$LOG_DIR/demo.log" 2>/dev/null || true
  exit 1
}
pass() { echo "PASS: $*"; }

section "Install v2.1.2"
npm install -g @sleep2agi/agent-network@2.1.2 >"$LOG_DIR/npm-install.log" 2>&1 || fail "npm install failed"
command -v anet >/dev/null || fail "anet binary missing"
anet -v >"$LOG_DIR/anet-version.log" 2>&1 || fail "anet -v failed"
grep -q "auto-fetched on first use" "$LOG_DIR/anet-version.log" || fail "anet -v missing auto-fetched wording"
if grep -q "not installed$" "$LOG_DIR/anet-version.log"; then
  fail "anet -v still reports bare 'not installed'"
fi
pass "anet v2.1.2 installed and version wording verified"

section "Start isolated local hub"
anet hub start --host 127.0.0.1 --token testtoken >"$LOG_DIR/hub.log" 2>&1 &
HUB_PID=$!
for _ in $(seq 1 90); do
  if curl -fsS "$COMMHUB_URL/health" >"$LOG_DIR/health.json" 2>/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS "$COMMHUB_URL/health" >/dev/null || fail "hub did not become healthy"
pass "hub healthy on 127.0.0.1 only"

section "Start dashboard smoke"
timeout 90s anet hub dashboard --host 127.0.0.1 --port 3000 >"$LOG_DIR/dashboard.log" 2>&1 &
DASH_PID=$!
sleep 8
if kill -0 "$DASH_PID" >/dev/null 2>&1; then
  pass "dashboard process started"
else
  echo "WARN: dashboard exited during smoke"
  tail -80 "$LOG_DIR/dashboard.log" || true
fi

section "Verify legacy admin/anethub login"
set +e
anet login --username admin --password anethub >"$LOG_DIR/login-legacy.log" 2>&1
anet whoami >"$LOG_DIR/whoami-legacy.log" 2>&1
LEGACY_WHOAMI=$?
set -e
if [ "$LEGACY_WHOAMI" -eq 0 ] && ! grep -qi "Login failed\\|invalid" "$LOG_DIR/login-legacy.log"; then
  pass "legacy admin/anethub login works"
else
  echo "WARN: legacy admin/anethub login failed; falling back to generated bootstrap credentials"
  tail -20 "$LOG_DIR/login-legacy.log" || true
  BOOT_USER="$(awk -F': ' '/username:/ {print $2; exit}' "$LOG_DIR/hub.log")"
  BOOT_PASS="$(awk -F': ' '/password:/ {print $2; exit}' "$LOG_DIR/hub.log")"
  if [ -z "$BOOT_USER" ] || [ -z "$BOOT_PASS" ]; then
    fail "could not parse generated bootstrap credentials"
  fi
  anet login --username "$BOOT_USER" --password "$BOOT_PASS" >"$LOG_DIR/login.log" 2>&1 || true
  anet whoami >"$LOG_DIR/whoami.log" 2>&1 || fail "whoami failed after generated credential login"
  pass "generated bootstrap credential login works"
fi

section "Run debate demo"
set +e
MINIMAX_KEY="${MINIMAX_KEY:-test_key}" timeout 900s anet demo debate \
  --topic "test" \
  --rounds 1 \
  --step-timeout 45 \
  --suffix "$NETWORK_SUFFIX" \
  --out "$OUT_MD" \
  >"$LOG_DIR/demo.log" 2>&1
DEMO_CODE=$?
set -e
if [ "$DEMO_CODE" -ne 0 ]; then
  fail "demo exited non-zero: $DEMO_CODE"
fi
if grep -q "agent-node is not installed or cannot report a version" "$LOG_DIR/demo.log"; then
  fail "agent-node first-use bootstrap failed"
fi
if grep -q "流程失败" "$LOG_DIR/demo.log"; then
  fail "demo flow failed"
fi

grep -q "创建 6 个 agent" "$LOG_DIR/demo.log" || fail "demo did not reach 6-agent create step"
grep -q "启动 6 个 agent" "$LOG_DIR/demo.log" || fail "demo did not reach 6-agent start step"
grep -q "驱动辩论流程" "$LOG_DIR/demo.log" || fail "demo did not reach task dispatch step"
grep -q "写入实录" "$LOG_DIR/demo.log" || fail "demo did not write transcript"
grep -q "清理完成" "$LOG_DIR/demo.log" || fail "demo cleanup did not complete"
test -s "$OUT_MD" || fail "transcript markdown missing or empty"
grep -q "# 辩论赛实录" "$OUT_MD" || fail "transcript markdown header missing"
pass "demo command completed and wrote transcript"

section "Verify network cleanup"
anet network ls >"$LOG_DIR/networks-after.log" 2>&1 || fail "network ls failed"
if grep -q "debate-$NETWORK_SUFFIX" "$LOG_DIR/networks-after.log"; then
  fail "temporary debate network still present after cleanup"
fi
pass "temporary network cleaned up"

section "Key log excerpt"
tail -50 "$LOG_DIR/demo.log"

echo ""
echo "RESULT: PASS"
