#!/usr/bin/env bash
# test739 — board #739 (step 3 of #734): a codex co-presence node pins WHICH codex it runs.
# config.json codexBin = the binary the launch AND the #734 version probe use (one resolution);
# config.json codexVersion = that binary's `--version` must match at start, or nothing starts.
# Neither set = bare `codex`, as before. Real codex 0.133.0 and 0.159.2 side by side, the real
# POSIX launcher (`anet node start`); the login-shell PATH puts the "wrong" codex first.
set -euo pipefail
cd /workspace
echo "T739 source=${T739_SOURCE_COMMIT:-unknown}"
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ] && [ "${T739_SOURCE_COMMIT:-}" != "$EXPECTED_SOURCE_COMMIT" ]; then
  echo "FAIL: source provenance mismatch image=${T739_SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"; exit 1
fi
SUITE=tests/test739-codex-bin-pin
C133=/opt/codex-0.133.0/bin/codex
C159=/opt/codex-0.159.2/bin/codex
export ANET_START_MEM_GATE=0
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL $*"; }

echo "── L1 unit"
l1=0
(cd agent-network && bun test src/codex-bin-pin.test.ts src/codex-copresence-rollout-guard.test.ts) || l1=1
if [ "$l1" -ne 0 ]; then echo "FAIL L1 unit — not running later layers"; exit 1; fi
pass "L1 unit"

echo "── L2 fixture: a thread REAL codex 0.159.2 wrote (paginated)"
TPL=/root/t739-template
mkdir -p "$TPL"; chmod 700 "$TPL"
printf '{"OPENAI_API_KEY":"sk-fake-t739"}\n' > "$TPL/auth.json"; chmod 600 "$TPL/auth.json"
TID=$(CODEX_HOME=$TPL python3 "$SUITE/codex-rpc.py" new "$C159" /root/t739-cwd)
TPL_ROLLOUT=$(find "$TPL/sessions" -name "rollout-*-$TID.jsonl")
head1=$(head -n 1 "$TPL_ROLLOUT" | grep -o '"history_mode":"[a-z]*"' || true)
if [ "$head1" = '"history_mode":"paginated"' ]; then pass "L2 thread $TID is paginated"
else fail "L2 fixture not paginated ($head1) — not running later layers"; echo "T739 PASS=$PASS FAIL=$FAIL"; exit 1; fi

echo "── L3 the REAL POSIX launcher: anet node start (co-presence)"
PAIRED_VERSION="$(node -p "require('/workspace/agent-node/package.json').version")"
PAIR_ROOT="/root/t739-paired/node_modules/@sleep2agi/agent-node"
mkdir -p "$PAIR_ROOT/dist"
printf '{"name":"@sleep2agi/agent-node","version":"%s","publishConfig":{"tag":"preview"},"bin":{"agent-node":"dist/cli.js"}}\n' "$PAIRED_VERSION" > "$PAIR_ROOT/package.json"
printf '%s\n' '#!/usr/bin/env node' 'if (process.argv.includes("--help")) { console.log("--runtime codex-app-server"); process.exit(0); }' 'await new Promise(() => {});' > "$PAIR_ROOT/dist/cli.js"
chmod 755 "$PAIR_ROOT/dist/cli.js"
export ANET_AGENT_NODE_BIN="$PAIR_ROOT/dist/cli.js"
HUB_PORT=9293
HUB="http://127.0.0.1:$HUB_PORT"
export COMMHUB_AUTH_TOKEN="t739-hub-token"
(cd /workspace/server && PORT=$HUB_PORT COMMHUB_DB=/root/t739-hub.db bun run src/index.ts > /root/t739-hub.log 2>&1 &)
for _ in $(seq 60); do curl -fsS -o /dev/null "$HUB/health" 2>/dev/null && break; sleep 0.5; done
WORK=$(mktemp -d /root/t739-work.XXXXXX)
ANET=(bun /workspace/agent-network/bin/cli.ts)
(cd "$WORK" && { printf '\n' | "${ANET[@]}" init --hub "$HUB" || true; "${ANET[@]}" register --username t739 --password pass123456 || true; "${ANET[@]}" login --username t739 --password pass123456 || true; }) > /root/t739-anet-setup.log 2>&1

# first_on_path DIR → anet's PATH and the login shell's PATH (the launch's `bash -lc`) both
# find DIR/codex first.
first_on_path() { printf 'export PATH=%s:$PATH\n' "$1" > /root/.bash_profile; LAUNCH_PATH="$1:$PATH"; }
NODE_N=0
# launch FIXTURE(thread|fresh) CONFIG-JSON → a fresh node, config.json merged with CONFIG-JSON,
# real start (no --codex-bin). Sets LOG RC APPSRV (codex app-server argv while up) SESSIONS INFO.
# The bridge here is a stub that never registers, so a start that gets through the codex stages
# waits at "② bridge" until `timeout` (RC=124); a refusal exits 1 before any session.
launch() {
  NODE_N=$((NODE_N + 1))
  local node="t739n$NODE_N" fixture=$1 patch=$2 nd nh
  (cd "$WORK" && "${ANET[@]}" node create "$node" --runtime codex-cli --hub "$HUB") >> /root/t739-anet-setup.log 2>&1 || true
  nd="$WORK/.anet/nodes/$node"; nh="$nd/codex-home"
  mkdir -p "$nh"; chmod 700 "$nh"; cp "$TPL/auth.json" "$nh/auth.json"; chmod 600 "$nh/auth.json"
  if [ "$fixture" = thread ]; then cp -a "$TPL/sessions" "$nh/sessions"; patch=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['codexThreadId']=sys.argv[2]; print(json.dumps(d))" "$patch" "$TID"); fi
  python3 - "$nd/config.json" "$patch" <<'PY'
import json, sys
p, patch = sys.argv[1:]
c = json.load(open(p)); c.update(json.loads(patch))
json.dump(c, open(p, "w"), indent=2)
PY
  LOG="/root/t739-start-$node.log"
  RC=0
  (cd "$WORK" && env PATH="$LAUNCH_PATH" timeout --foreground 45 "${ANET[@]}" node start "$node" --accept-dev-channels < /dev/null) > "$LOG" 2>&1 || RC=$?
  APPSRV=$(ps -eo args | grep -F ' app-server' | grep -v -e grep -e 'bash -' || true)
  SESSIONS=$(tmux ls 2>/dev/null | grep -F "$node" || true)
  INFO=$(cd "$WORK" && "${ANET[@]}" info "$node" 2>&1 || true)
  (cd "$WORK" && timeout 30 "${ANET[@]}" node stop "$node") >/dev/null 2>&1 || true
}
runs_only() { # VERSION-DIR → the running app-server is that codex, and no other
  printf '%s\n' "$APPSRV" | grep -Fq "$1/" && ! printf '%s\n' "$APPSRV" | grep -v -F "$1/" | grep -Fq /opt/codex-
}
pinned_ok() { # codexBin=0.159.2 + codexVersion=0.159.2 with 0.133 first on PATH
  grep -Fq "codex: $C159 = 0.159.2 (pinned in config.json)" "$LOG" && grep -Fq "thread: $TID" "$LOG" \
    && runs_only /opt/codex-0.159.2
}
refused_nothing_started() { # EXPECTED-LINE
  [ "$RC" -eq 1 ] && grep -Fq "$1" "$LOG" && grep -Fq 'Nothing was started' "$LOG" \
    && [ -z "$APPSRV" ] && [ -z "$SESSIONS" ]
}

first_on_path /opt/codex-0.133.0/bin
launch thread "{\"codexBin\":\"$C159\",\"codexVersion\":\"0.159.2\"}"
if pinned_ok; then pass "L3 codexBin=0.159.2 + codexVersion=0.159.2, PATH has 0.133 first: runs 0.159.2 on the paginated thread"
else fail "L3 pinned"; tail -30 "$LOG"; echo "appsrv: $APPSRV"; fi
if printf '%s\n' "$INFO" | grep -Fq "codexBin: $C159" && printf '%s\n' "$INFO" | grep -Fq 'codexVersion: 0.159.2'; then pass "L3 anet info shows codexBin and codexVersion"
else fail "L3 anet info"; printf '%s\n' "$INFO"; fi

launch fresh "{\"codexBin\":\"$C133\",\"codexVersion\":\"0.159.2\"}"
if refused_nothing_started "expected 0.159.2, got 0.133.0, path $C133"; then pass "L3 codexVersion mismatch: refused before launch, nothing started, clear error"
else fail "L3 mismatch"; tail -30 "$LOG"; echo "appsrv: $APPSRV sessions: $SESSIONS"; fi

launch fresh '{"codexVersion":"0.159.2"}'
if refused_nothing_started "expected 0.159.2, got 0.133.0, path codex"; then pass "L3 codexVersion only, PATH codex is 0.133: refused, nothing started"
else fail "L3 version-only mismatch"; tail -30 "$LOG"; fi

launch fresh '{}'
if grep -Fq '② bridge' "$LOG" && runs_only /opt/codex-0.133.0 && ! grep -Fq 'pinned in config.json' "$LOG" && ! printf '%s\n' "$INFO" | grep -Fq codexVersion; then
  pass "L3 neither set: bare codex from PATH (0.133 here), as before; anet info shows no pin"
else fail "L3 neither set"; tail -30 "$LOG"; echo "appsrv: $APPSRV"; fi

# The #734 probe follows codexBin: login PATH 0.159.2, codexBin 0.133 → the guard sees 0.133.
first_on_path /opt/codex-0.159.2/bin
launch thread "{\"codexBin\":\"$C133\"}"
if [ "$RC" -eq 1 ] && grep -Fq "refusing to start codex 0.133.0 ($C133)" "$LOG" && [ -z "$APPSRV" ]; then
  pass "L3 probe = launch binary: codexBin=0.133 with 0.159.2 on PATH is refused by the #734 guard"
else fail "L3 probe follows codexBin"; tail -30 "$LOG"; fi
first_on_path /opt/codex-0.133.0/bin

echo "── mutations of the shipped source (each must go red)"
CLI=agent-network/bin/cli.ts
PIN=agent-network/src/codex-bin-pin.ts
# mutate NAME FILE PYTHON-REPLACE-FROM PYTHON-REPLACE-TO CHECK   (test738 form; anchors are literals)
mutate() {
  local name=$1 file=$2 from=$3 to=$4 check=$5 bak
  bak=$(mktemp); cp "$file" "$bak"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1:]
s = open(p).read()
assert s.count(a) == 1, f"mutation anchor not found exactly once in {p}: {a!r}"
open(p, "w").write(s.replace(a, b))
PY
  local red=0
  case "$check" in
    pinned) launch thread "{\"codexBin\":\"$C159\",\"codexVersion\":\"0.159.2\"}"; pinned_ok || red=1 ;;
    mismatch) launch fresh "{\"codexBin\":\"$C133\",\"codexVersion\":\"0.159.2\"}"; refused_nothing_started "expected 0.159.2, got 0.133.0" || red=1 ;;
  esac
  cp "$bak" "$file"; rm -f "$bak"
  if [ "$red" -eq 1 ]; then pass "mutation $name → red ($check)"; else fail "mutation $name stayed green ($check)"; fi
}
mutate M1-launch-ignores-codexBin "$CLI" '    `exec ${shellQuote(opts.codexBin)} app-server`' '    `exec codex app-server`' pinned
mutate M2-config-codexBin-ignored "$PIN" '  return flag || configuredCodexBin(profile) || "codex";' '  return flag || "codex";' pinned
mutate M3-version-check-skipped "$CLI" '  if (opts.codexVersion) {' '  if (false && opts.codexVersion) {' mismatch
mutate M4-probe-uses-another-binary "$CLI" '    : probeCodexVersionViaShell(copresenceVersionProbeScript(opts.codexHome, bin), { loginShell: true });' '    : probeCodexVersionViaShell(copresenceVersionProbeScript(opts.codexHome, "codex"), { loginShell: true });' pinned

echo "T739 PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
