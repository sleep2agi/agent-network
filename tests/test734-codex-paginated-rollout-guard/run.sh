#!/usr/bin/env bash
# test734 — board #734: codex >= 0.145 writes "paginated" rollouts (every line has an ordinal).
# If codex < 0.145 then appends to one, codex >= 0.145 refuses the thread for good
# ("final paginated rollout record at <path> is missing an ordinal"). anet must refuse to start
# an old codex on such a thread, and must explain the failure when it already happened.
# Real codex 0.133.0 / 0.159.2 for the version probe, the owned app-server, the real resume
# failure and the real POSIX launcher; synthetic rollouts (mk-rollout.py). Every layer has a
# witnessed red (mutations M1-M4 of the shipped source).
set -euo pipefail
cd /workspace
echo "T734 source=${T734_SOURCE_COMMIT:-unknown}"
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ] && [ "${T734_SOURCE_COMMIT:-}" != "$EXPECTED_SOURCE_COMMIT" ]; then
  echo "FAIL: source provenance mismatch image=${T734_SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"; exit 1
fi
SUITE=tests/test734-codex-paginated-rollout-guard
TID=01a11846-d796-72f1-af68-8d9215a65dc8
C133=/opt/codex-0.133.0/bin/codex
C159=/opt/codex-0.159.2/bin/codex
export ANET_START_MEM_GATE=0
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL $*"; }

# home MODE → a fresh CODEX_HOME holding one rollout of that shape (MODE=none: no rollout)
home() {
  local h; h=$(mktemp -d /tmp/t734-home.XXXXXX)
  printf '{"OPENAI_API_KEY":"sk-fake-t734"}\n' > "$h/auth.json"; chmod 600 "$h/auth.json"
  if [ "$1" != "none" ]; then python3 "$SUITE/mk-rollout.py" "$h" "$TID" "$1" >/dev/null; fi
  echo "$h"
}
rollout_of() { local f; f=$(find "$1/sessions" -name "rollout-*-$TID.jsonl"); echo "$f"; }
# field JSON PY-EXPR → value printed by python (r = parsed result)
field() { T734_JSON="$1" python3 -c "import json,os; r=json.loads(os.environ['T734_JSON']); print($2)"; }
probe() { local out; out=$(bun "$SUITE/probe.ts" "$@" 2>&1 || true); printf '%s\n' "$out" | sed -n 's/^T734 //p'; }

echo "── L1 unit"
l1=0
(cd agent-node && bun test src/runtime/codex-rollout-history-guard.test.ts) || l1=1
(cd agent-network && bun test src/codex-copresence-rollout-guard.test.ts) || l1=1
if [ "$l1" -ne 0 ]; then echo "FAIL L1 unit — not running later layers"; exit 1; fi
pass "L1 unit"

# L2: the shipped guard with the REAL binaries' --version
l2_case() { # NAME MODE BIN WANT(blocked|allowed)
  local h r b; h=$(home "$2"); r=$(probe guard "$h" "$TID" "$3")
  if [ -z "$r" ]; then fail "L2 $1: no result"; return; fi
  b=$(field "$r" 'r["blocked"]')
  if { [ "$4" = blocked ] && [ "$b" = True ]; } || { [ "$4" = allowed ] && [ "$b" = False ]; }; then pass "L2 $1 → $4"
  else fail "L2 $1: want $4, got blocked=$b"; echo "$r"; fi
}
echo "── L2 guard × real codex --version"
l2_case "0.133 on paginated" paginated "$C133" blocked
l2_case "0.159.2 on paginated" paginated "$C159" allowed
l2_case "0.133 on legacy" legacy "$C133" allowed
l2_case "0.133, rollout missing" none "$C133" allowed
h=$(home paginated); r=$(probe guard "$h" "$TID" "$C133")
if field "$r" '"\n".join(r["block"])' | grep -Fq 'codex 0.133.0 would append lines without an ordinal'; then pass "L2 block message explains the consequence"; else fail "L2 block message"; echo "$r"; fi

echo "── L3 bounded first-line read on a 300 MB rollout"
BIGH=$(home big); BIG=$(rollout_of "$BIGH")
echo "   size=$(stat -c %s "$BIG") bytes"
l3_check() { # → 0 when bounded
  local r; r=$(probe firstline "$BIG")
  echo "   $r"
  [ -n "$r" ] && [ "$(field "$r" 'r["ok"] and r["verdict"]=="block" and r["kernelReadBytes"] < 1048576 and r["ms"] < 1000')" = True ]
}
if l3_check; then pass "L3 reads < 1 MiB of a 300 MB file and still blocks"; else fail "L3 bounded read"; fi

echo "── L4 agent-node owned app-server (real binaries)"
h=$(home paginated); sum0=$(sha256sum "$(rollout_of "$h")")
r=$(probe owned "$h" "$TID" "$C133")
if [ -n "$r" ] && [ "$(field "$r" '"board #734" in r["error"] and not r["spawned"] and any("refusing to start codex 0.133.0" in l for l in r["lines"])')" = True ]; then
  pass "L4 0.133 on paginated: refused before spawning app-server"
else fail "L4 0.133 on paginated"; echo "$r"; fi
if [ "$sum0" = "$(sha256sum "$(rollout_of "$h")")" ]; then pass "L4 rollout untouched"; else fail "L4 rollout changed"; fi
h=$(home mixed); sum0=$(sha256sum "$(rollout_of "$h")")
r=$(probe owned "$h" "$TID" "$C159")
if [ -n "$r" ] && [ "$(field "$r" '"missing an ordinal" in r["error"] and r["spawned"] and any("mixes codex versions" in l for l in r["lines"]) and any("Read-only check" in l for l in r["lines"])')" = True ]; then
  pass "L4 real 0.159.2 resume of a mixed rollout fails closed with the diagnosis"
else fail "L4 mixed diagnosis"; echo "$r"; fi
if [ "$sum0" = "$(sha256sum "$(rollout_of "$h")")" ]; then pass "L4 mixed rollout untouched"; else fail "L4 mixed rollout changed"; fi

echo "── L5 the REAL POSIX launcher: anet node start (co-presence)"
PAIRED_VERSION="$(node -p "require('/workspace/agent-node/package.json').version")"
PAIR_ROOT="/root/t734-paired/node_modules/@sleep2agi/agent-node"
mkdir -p "$PAIR_ROOT/dist"
printf '{"name":"@sleep2agi/agent-node","version":"%s","publishConfig":{"tag":"preview"},"bin":{"agent-node":"dist/cli.js"}}\n' "$PAIRED_VERSION" > "$PAIR_ROOT/package.json"
printf '%s\n' '#!/usr/bin/env node' 'if (process.argv.includes("--help")) { console.log("--runtime codex-app-server"); process.exit(0); }' 'await new Promise(() => {});' > "$PAIR_ROOT/dist/cli.js"
chmod 755 "$PAIR_ROOT/dist/cli.js"
export ANET_AGENT_NODE_BIN="$PAIR_ROOT/dist/cli.js"
HUB_PORT=9273
HUB="http://127.0.0.1:$HUB_PORT"
export COMMHUB_AUTH_TOKEN="t734-hub-token"
(cd /workspace/server && PORT=$HUB_PORT COMMHUB_DB=/root/t734-hub.db bun run src/index.ts > /root/t734-hub.log 2>&1 &)
for _ in $(seq 60); do curl -fsS -o /dev/null "$HUB/health" 2>/dev/null && break; sleep 0.5; done
WORK=$(mktemp -d /root/t734-work.XXXXXX)
ANET=(bun /workspace/agent-network/bin/cli.ts)
(cd "$WORK" && { printf '\n' | "${ANET[@]}" init --hub "$HUB" || true; "${ANET[@]}" register --username t734 --password pass123456 || true; "${ANET[@]}" login --username t734 --password pass123456 || true; }) > /root/t734-anet-setup.log 2>&1
NODE_N=0
LAST_LOG=""
# launch MODE CODEX_BIN → runs a fresh node's real start; sets LAST_LOG, LAST_ROLLOUT
launch() {
  NODE_N=$((NODE_N + 1))
  local node="t734n$NODE_N" nh cfg
  : > /tmp/t734-appserver-argv.log
  (cd "$WORK" && "${ANET[@]}" node create "$node" --runtime codex-cli --hub "$HUB") >> /root/t734-anet-setup.log 2>&1 || true
  nh="$WORK/.anet/nodes/$node/codex-home"; mkdir -p "$nh"; chmod 700 "$nh"
  printf '{"OPENAI_API_KEY":"sk-fake-t734"}\n' > "$nh/auth.json"; chmod 600 "$nh/auth.json"
  python3 "$SUITE/mk-rollout.py" "$nh" "$TID" "$1" >/dev/null
  cfg="$WORK/.anet/nodes/$node/config.json"
  python3 - "$cfg" "$TID" <<'PY'
import json, sys
p, tid = sys.argv[1:]
c = json.load(open(p)); c["codexThreadId"] = tid
json.dump(c, open(p, "w"), indent=2)
PY
  LAST_ROLLOUT=$(rollout_of "$nh")
  LAST_SUM=$(sha256sum "$LAST_ROLLOUT")
  LAST_LOG="/root/t734-start-$node.log"
  (cd "$WORK" && timeout 120 "${ANET[@]}" node start "$node" --accept-dev-channels --codex-bin "$2") > "$LAST_LOG" 2>&1 || true
  (cd "$WORK" && timeout 30 "${ANET[@]}" node stop "$node") >/dev/null 2>&1 || true
}
launcher_blocks() { grep -Fq 'refusing to start codex 0.133.0' "$LAST_LOG" && [ ! -s /tmp/t734-appserver-argv.log ]; }
launch paginated /usr/local/bin/codex-stub-0.133.0
if launcher_blocks; then pass "L5 launcher refuses codex 0.133 on a paginated thread; no app-server started"; else fail "L5 launcher block"; tail -25 "$LAST_LOG"; fi
if [ "$LAST_SUM" = "$(sha256sum "$LAST_ROLLOUT")" ]; then pass "L5 rollout untouched"; else fail "L5 rollout changed"; fi
launch paginated /usr/local/bin/codex-stub-0.159.2
if ! grep -Fq 'refusing to start' "$LAST_LOG" && [ -s /tmp/t734-appserver-argv.log ]; then pass "L5 launcher lets codex 0.159.2 start the app-server"; else fail "L5 launcher allow"; tail -25 "$LAST_LOG"; fi
launch legacy /usr/local/bin/codex-stub-0.133.0
if ! grep -Fq 'refusing to start' "$LAST_LOG" && [ -s /tmp/t734-appserver-argv.log ]; then pass "L5 launcher lets codex 0.133 start on a legacy thread"; else fail "L5 launcher legacy"; tail -25 "$LAST_LOG"; fi
launch mixed "$C159"
if grep -Fq 'missing an ordinal' "$LAST_LOG" && grep -Fq 'mixes codex versions' "$LAST_LOG" && grep -Fq 'Fail-closed' "$LAST_LOG"; then
  pass "L5 launcher + real codex 0.159.2 on the mixed rollout: fail-closed with the diagnosis"
else fail "L5 launcher diagnosis"; tail -40 "$LAST_LOG"; fi
if [ "$LAST_SUM" = "$(sha256sum "$LAST_ROLLOUT")" ]; then pass "L5 mixed rollout untouched"; else fail "L5 mixed rollout changed"; fi
echo "   --- diagnosis as printed by the launcher ---"
grep -F '[codex]' "$LAST_LOG" | sed 's/^/   /' || true

echo "── mutations of the shipped source (each must go red)"
GUARD_AN=agent-network/src/codex-rollout-history-guard.ts
GUARD_NODE=agent-node/src/runtime/codex-rollout-history-guard.ts
CLI=agent-network/bin/cli.ts
mutate() { # NAME CHECK FILE FROM TO [FILE FROM TO]...
  local name=$1 check=$2; shift 2
  local files=() baks=()
  while [ $# -ge 3 ]; do
    local bak; bak=$(mktemp); cp "$1" "$bak"; files+=("$1"); baks+=("$bak")
    python3 - "$1" "$2" "$3" <<'PY'
import sys
p, a, b = sys.argv[1:]
s = open(p).read()
assert s.count(a) == 1, f"mutation anchor not found exactly once in {p}: {a!r}"
open(p, "w").write(s.replace(a, b))
PY
    shift 3
  done
  local red=0 h r
  case "$check" in
    l2-block) h=$(home paginated); r=$(probe guard "$h" "$TID" "$C133"); [ "$(field "$r" 'r["blocked"]')" = True ] || red=1 ;;
    l3) l3_check || red=1 ;;
    l5-block) launch paginated /usr/local/bin/codex-stub-0.133.0; launcher_blocks || red=1 ;;
  esac
  local i; for i in "${!files[@]}"; do cp "${baks[$i]}" "${files[$i]}"; rm -f "${baks[$i]}"; done
  if [ "$red" -eq 1 ]; then pass "mutation $name → red ($check)"; else fail "mutation $name stayed green ($check)"; fi
}
CMP='  const cmp = version ? compareVersions(version, PAGINATED_ROLLOUT_MIN_CODEX) : null;'
CMP_GONE='  const cmp = version ? 0 : null;'
mutate M1-drop-version-compare l2-block "$GUARD_AN" "$CMP" "$CMP_GONE" "$GUARD_NODE" "$CMP" "$CMP_GONE"
READ_HEAD='): FirstLineRead {
  let fd: number;'
READ_ALL='): FirstLineRead {
  { const all = require("node:fs").readFileSync(path); const i = all.indexOf(10); return { line: all.subarray(0, i < 0 ? all.length : i).toString("utf8"), bytesRead: i + 1 }; }
  let fd: number;'
mutate M2-read-whole-file l3 "$GUARD_NODE" "$READ_HEAD" "$READ_ALL"
mutate M3-launcher-guard-not-wired l5-block "$CLI" '      threadIds: opts.newSession ? [] : [requestedThreadId, typeof pending?.threadId === "string" ? pending.threadId : undefined],' '      threadIds: [],'
mutate M4-launcher-ignores-block l5-block "$CLI" '    if (guard.block) {
      for (const line of guard.block) console.error(`[anet] ${line}`);
      process.exit(1);
    }' '    if (guard.block) {
      for (const line of guard.block) console.error(`[anet] ${line}`);
    }'

echo "T734 PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
