#!/usr/bin/env bash
set -euo pipefail

# test750 — `anet node start <name>` alone brings up a codex co-presence TUI.
#
# What the unit tests already cover: the decision functions in
# agent-network/src/codex-copresence-{profile,preflight}.ts.
#
# What only this suite covers: that the real CLI writes those fields to a real
# config file and routes a real `node start` on them. Both defects this feature
# fixes were of that shape — a value written by one command and never read by
# another — so a pure-function test alone would not have caught either.
#
# The image carries tmux and a codex STUB. The stub never binds, so every start
# fails shortly after — that is fine and intended: the assertions are on what the
# launcher DECIDED (which path, which sandbox, what it wrote to the profile),
# which it prints before it gets that far.
#
# 🔴 NOT covered here, deliberately, and stated rather than implied: the TUI
#    itself. Painting it needs a real codex plus credentials, neither of which
#    belongs in a --network none image. That half is covered by the production
#    run recorded on the PR.

ROOT=/workspace
ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-$ARTIFACT_DIR/report-test750.txt}"
mkdir -p "$ARTIFACT_DIR"
: >"$REPORT"

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

log "# test750 — codex co-presence: one command, and the posture it keeps"
log "date: $(date -Is)"
log "source_commit: ${TEST750_SOURCE_COMMIT:-${SOURCE_COMMIT:-unset}}"

log "[L0] isolated environment"
[ ! -e "$ROOT/.git" ] || fail "Docker image contains host .git"
[ ! -e "$ROOT/.anet" ] || fail "Docker image contains host .anet"
command -v tmux >/dev/null 2>&1 || fail "tmux missing — the launcher must get past its guards for L3/L5 to mean anything"
command -v codex >/dev/null 2>&1 || fail "codex stub missing"
node --version >>"$REPORT"
bun --version >>"$REPORT"
pass "environment (no host state; tmux + codex stub present so the launcher reaches its decisions)"

log "[L1] decision functions"
cd "$ROOT/agent-network"
bun test src/codex-copresence-profile.test.ts src/codex-copresence-preflight.test.ts \
     src/copresence-deps.test.ts >>"$REPORT" 2>&1 \
  || fail "codex co-presence unit tests"
# 🔴 A green `bun test` does not prove these files ran — a path typo produces
#    "0 tests" and exit 0 all the same. Assert the denominator.
UNIT_TOTAL=$(bun test src/codex-copresence-profile.test.ts src/codex-copresence-preflight.test.ts \
     src/copresence-deps.test.ts 2>&1 | grep -oE '^ *[0-9]+ pass' | grep -oE '[0-9]+' | head -1)
[ "${UNIT_TOTAL:-0}" -ge 44 ] || fail "expected >=44 unit assertions, ran ${UNIT_TOTAL:-0} — did the files resolve?"
log "unit assertions: $UNIT_TOTAL"
pass "profile + preflight decision functions ($UNIT_TOTAL tests)"

log "[L2] create writes what start will read"
# A real hub, the way the other CLI suites do it (see tests/test20-cli-ux):
# `anet node create` refuses to write a profile without one, and faking that
# refusal away would test a code path no operator ever walks.
PORT=9231
HUB="http://127.0.0.1:${PORT}"
export COMMHUB_AUTH_TOKEN="test750-token"
cd "$ROOT/server" && PORT=$PORT bun run src/index.ts >/tmp/test750-server.log 2>&1 &
for _ in $(seq 60); do
  curl -fsS -o /dev/null "$HUB/health" 2>/dev/null && break
  sleep 0.5
done
curl -fsS -o /dev/null "$HUB/health" 2>/dev/null || { cat /tmp/test750-server.log >>"$REPORT"; fail "commhub-server never became healthy on $HUB"; }
log "hub up on $HUB"

WORK=$(mktemp -d)
cd "$WORK"
CLI="bun $ROOT/agent-network/bin/cli.ts"
printf "\n" | $CLI init --hub "$HUB" >>"$REPORT" 2>&1 || true
$CLI register --username t750 --password pass123456 >>"$REPORT" 2>&1 || true
$CLI login --username t750 --password pass123456 >>"$REPORT" 2>&1 || true

field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2]))" "$1" "$2"; }

$CLI node create withflag --runtime codex-tui --copresence --hub "$HUB" >>"$REPORT" 2>&1 \
  || fail "create --copresence"
[ "$(field .anet/nodes/withflag/config.json codexCopresence)" = "True" ] \
  || fail "create --copresence did not record codexCopresence"

$CLI node create noflag --runtime codex-tui --hub "$HUB" >"$WORK/noflag.out" 2>&1 || fail "create without flag"
cat "$WORK/noflag.out" >>"$REPORT"
[ "$(field .anet/nodes/noflag/config.json codexCopresence)" = "None" ] \
  || fail "create without --copresence recorded codexCopresence anyway"
grep -q 'this node starts headless' "$WORK/noflag.out" \
  || fail "no hint telling the operator how to get a TUI"

# The field must never be written onto a runtime whose start path would reject
# it — that turns a typo into a hard exit on an unrelated node.
$CLI node create sdknode --runtime codex-sdk --copresence --hub "$HUB" >>"$REPORT" 2>&1 || fail "create codex-sdk"
[ "$(field .anet/nodes/sdknode/config.json codexCopresence)" = "None" ] \
  || fail "codexCopresence written onto a codex-sdk node"
pass "create records the choice, only for the runtime that can use it, and says so when it does not"

log "[L3] start routes on the recorded field, with no flag"
set +e
$CLI node start withflag --accept-dev-channels >"$WORK/withflag.start" 2>&1
RC_WITH=$?
$CLI node start noflag --accept-dev-channels >"$WORK/noflag.start" 2>&1
RC_WITHOUT=$?
set -e
cat "$WORK/withflag.start" "$WORK/noflag.start" >>"$REPORT"

# The signal is a line only the co-presence path prints, not a guard it shares
# with something else.
#
# 🔴 Two earlier needles were wrong, both instructively:
#    "requires tmux"            — `--accept-dev-channels` prints the same suffix,
#                                 so the negative control misfired; and that guard
#                                 returns before the sandbox is resolved, which
#                                 left L5 blind to an inverted default.
#    "① app-server tmux="       — correct semantically, but a multibyte literal
#                                 in a shell string is one encoding accident away
#                                 from silently never matching. ASCII only.
COPRESENCE_GUARD='app-server tmux='
grep -qF -e "$COPRESENCE_GUARD" "$WORK/withflag.start" \
  || fail "plain start on a recorded node did NOT enter the co-presence path (rc=$RC_WITH)"
if grep -qF -e "$COPRESENCE_GUARD" "$WORK/noflag.start"; then
  fail "plain start entered co-presence for a node that never opted in"
fi
pass "recorded node → co-presence path; unrecorded node → normal lane"

log "[L4] --copresence still works as a one-off, and is then remembered"
set +e
$CLI node start noflag --copresence --accept-dev-channels >"$WORK/oneoff.start" 2>&1
set -e
cat "$WORK/oneoff.start" >>"$REPORT"
grep -qF -e "$COPRESENCE_GUARD" "$WORK/oneoff.start" || fail "explicit --copresence did not enter the co-presence path"
grep -q 'remembered co-presence for this node' "$WORK/oneoff.start" \
  || fail "explicit --copresence did not record the choice for next time"
[ "$(field .anet/nodes/noflag/config.json codexCopresence)" = "True" ] \
  || fail "the recorded field is not on disk after an explicit --copresence start"
pass "one-off flag is honoured and remembered"

log "[L5] the sandbox the launcher actually resolved"
# 🔴 Assert the RESOLVED sandbox, not just the persisted field. Persistence is
#    driven by the flag; the sandbox is driven by the posture. A change that
#    granted full access unconditionally would leave the field empty and the
#    node wide open — and a field-only assertion reads green through it.
[ "$(field .anet/nodes/noflag/config.json codexCopresenceFullAccess)" = "None" ] \
  || fail "co-presence alone recorded a full-access grant"
grep -qF -e 'sandbox=read-only' "$WORK/oneoff.start" \
  || fail "co-presence without an explicit grant did not resolve to read-only"
if grep -qF -e 'sandbox=danger-full-access' "$WORK/oneoff.start"; then
  fail "co-presence resolved to danger-full-access with no grant — the default was inverted"
fi

set +e
$CLI node start noflag --copresence --dangerously-allow-full-access --yes-danger-full-access \
  --accept-dev-channels >"$WORK/grant.start" 2>&1
set -e
cat "$WORK/grant.start" >>"$REPORT"
grep -qF -e 'sandbox=danger-full-access' "$WORK/grant.start" \
  || fail "an explicit grant did not resolve to danger-full-access"
[ "$(field .anet/nodes/noflag/config.json codexCopresenceFullAccess)" = "True" ] \
  || fail "explicit grant was not recorded"
pass "read-only is what co-presence actually resolves to; the grant is explicit and remembered"

log "[L6] every missing dependency in one pass, with a command for each"
# Hide tmux and codex from PATH rather than uninstalling them: the other layers
# need both, and a second image would drift from this one.
MINPATH=$(mktemp -d)
for b in bun node python3 sh bash env grep sed awk cat mktemp curl printf; do
  src=$(command -v "$b" 2>/dev/null) && ln -sf "$src" "$MINPATH/$b"
done
set +e
PATH="$MINPATH" $CLI node start withflag --accept-dev-channels >"$WORK/nodeps.start" 2>&1
RC_NODEPS=$?
set -e
cat "$WORK/nodeps.start" >>"$REPORT"
[ "$RC_NODEPS" -ne 0 ] || fail "start succeeded on a machine with no tmux and no codex"
# 🔴 The point is BOTH in one run. The guards this replaced exited at the first
#    gap, so the operator learned about tmux, installed it, reran, and only then
#    learned about codex.
grep -qF -e 'tmux' "$WORK/nodeps.start"  || fail "missing tmux was not reported"
grep -qF -e 'codex' "$WORK/nodeps.start" || fail "missing codex was not reported"
grep -qF -e 'npm install -g @openai/codex' "$WORK/nodeps.start" \
  || fail "reported the gap but not the command that closes it"
pass "all gaps reported together, each with a runnable command"

log "[L7] a hub that is not ours is never started for us"
# 🔴 A remote hub that refuses is somebody else's service. Starting a local one
#    would point the node at a DIFFERENT hub than its profile names — it would
#    come up looking healthy and be invisible to everyone waiting on the real
#    one. Loopback auto-start itself needs the network to fetch the server
#    package, so it is not exercised here; this is the half that can be.
$CLI node create remotehub --runtime codex-tui --copresence --hub http://10.255.255.1:9200 >>"$REPORT" 2>&1 \
  || fail "create with a remote hub"
set +e
$CLI node start remotehub --accept-dev-channels >"$WORK/remote.start" 2>&1
RC_REMOTE=$?
set -e
cat "$WORK/remote.start" >>"$REPORT"
[ "$RC_REMOTE" -ne 0 ] || fail "start succeeded against an unreachable remote hub"
grep -qF -e 'not a loopback hub' "$WORK/remote.start" \
  || fail "did not say why it refused to start the remote hub"
if grep -qF -e 'starting it in tmux=anet-hub' "$WORK/remote.start"; then
  fail "tried to start a local hub for a node pointed at a remote one"
fi
pass "refuses to substitute a local hub for a remote one, and says why"

log "[L8] a start that did not bring the node up must not report success"
# 🔴 The regression this exists for. `waitForTmuxPaneText` abandoned its poll
#    loop when the pane was not listable yet — it neither resolved nor
#    rescheduled, so the promise never settled, the event loop drained, and node
#    exited 0. `anet node start --copresence` printed two lines and returned
#    SUCCESS having started nothing. It reproduced every time on a machine whose
#    tmux server was not already warm, i.e. the first node on a fresh box.
#
#    In this image the codex stub never binds, so every start here legitimately
#    fails; what is asserted is that failure is REPORTED, not that it happens.
[ "$RC_WITH" -ne 0 ] \
  || fail "start exited 0 while the node did not come up (rc=$RC_WITH) — the silent-success regression"
grep -qF -e 'did not bind' "$WORK/withflag.start" \
  || fail "start failed without naming what did not come up"
pass "an incomplete start exits non-zero and names the step that failed"

log "[L9] the first-run chain must not walk past its own failures"
# 🔴 `anet register && anet login && anet node create` is the documented first
#    run. Measured on a clean machine with no hub reachable: register and login
#    printed an error and exited 0, while init and node create exited 1 — so a
#    setup script (or a person checking $?) sails past the first failure and
#    only learns something is wrong three commands later, at a command that is
#    not the one that broke.
#
#    Uses a hub URL nothing is listening on, so the failure is the connection,
#    not credentials.
DEADHUB="http://127.0.0.1:9" 
for cmd in "register --username x1 --password pass123456" "login --username x1 --password pass123456"; do
  set +e
  # shellcheck disable=SC2086
  $CLI $cmd --hub "$DEADHUB" >"$WORK/firstrun.log" 2>&1
  rc=$?
  set -e
  cat "$WORK/firstrun.log" >>"$REPORT"
  [ "$rc" -ne 0 ] || fail "anet ${cmd%% *} exited 0 against an unreachable hub — the first-run chain would continue"
done
pass "register and login report failure through their exit code"

PASSED=$(grep -c '^PASS: ' "$REPORT" || true)
FAILED=$(grep -c '^FAIL: ' "$REPORT" || true)
log "Summary: PASS ($PASSED groups, $FAILED failures; all validation ran inside Docker)"
