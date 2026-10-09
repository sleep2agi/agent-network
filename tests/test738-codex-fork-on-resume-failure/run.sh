#!/usr/bin/env bash
# test738 — board #738 (step 2 of #734): `anet node start <node> --fork-on-resume-failure`.
# A thread written by codex >= 0.145 and then appended to by codex 0.133 cannot be resumed
# ("missing an ordinal"). With the flag AND a human's yes (y/N prompt, or --yes without a
# terminal), anet forks it with codex `thread/fork` and starts the node on the new thread;
# the original rollout is never modified and a read-only snapshot is kept.
# Real codex 0.159.2 writes the thread, real codex 0.133.0 appends to it, the real POSIX
# launcher (`anet node start`) runs every case against real codex 0.159.2.
set -euo pipefail
cd /workspace
echo "T738 source=${T738_SOURCE_COMMIT:-unknown}"
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ] && [ "${T738_SOURCE_COMMIT:-}" != "$EXPECTED_SOURCE_COMMIT" ]; then
  echo "FAIL: source provenance mismatch image=${T738_SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"; exit 1
fi
SUITE=tests/test738-codex-fork-on-resume-failure
C133=/opt/codex-0.133.0/bin/codex
C159=/opt/codex-0.159.2/bin/codex
export ANET_START_MEM_GATE=0
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL $*"; }

echo "── L1 unit"
l1=0
(cd agent-network && bun test src/codex-fork-recovery.test.ts src/cli-args.test.ts src/codex-copresence-rpc.test.ts) || l1=1
if [ "$l1" -ne 0 ]; then echo "FAIL L1 unit — not running later layers"; exit 1; fi
pass "L1 unit"

echo "── L2 fixture: a REAL mixed rollout (0.159.2 writes, 0.133.0 appends)"
TPL=/root/t738-template
mkdir -p "$TPL"; chmod 700 "$TPL"
printf '{"OPENAI_API_KEY":"sk-fake-t738"}\n' > "$TPL/auth.json"; chmod 600 "$TPL/auth.json"
TID=$(CODEX_HOME=$TPL python3 "$SUITE/codex-rpc.py" new "$C159" /root/t738-cwd)
CODEX_HOME=$TPL python3 "$SUITE/codex-rpc.py" turn "$C133" /root/t738-cwd "$TID"
TPL_ROLLOUT=$(find "$TPL/sessions" -name "rollout-*-$TID.jsonl")
head1=$(head -n 1 "$TPL_ROLLOUT" | grep -o '"history_mode":"[a-z]*"' || true)
lastord=$(tail -n 1 "$TPL_ROLLOUT" | grep -c '"ordinal"' || true)
direct=$(CODEX_HOME=$TPL python3 "$SUITE/codex-rpc.py" resume "$C159" /root/t738-cwd "$TID")
echo "   thread=$TID $head1 last-line-ordinals=$lastord; $direct"
if [ "$head1" = '"history_mode":"paginated"' ] && [ "$lastord" = 0 ] && printf '%s' "$direct" | grep -Fq 'missing an ordinal'; then
  pass "L2 real mixed rollout reproduces 'missing an ordinal' on 0.159.2"
else fail "L2 fixture is not the #734 failure — not running later layers"; echo "T738 PASS=$PASS FAIL=$FAIL"; exit 1; fi

echo "── L3 the REAL POSIX launcher: anet node start (co-presence, codex 0.159.2)"
PAIRED_VERSION="$(node -p "require('/workspace/agent-node/package.json').version")"
PAIR_ROOT="/root/t738-paired/node_modules/@sleep2agi/agent-node"
mkdir -p "$PAIR_ROOT/dist"
printf '{"name":"@sleep2agi/agent-node","version":"%s","publishConfig":{"tag":"preview"},"bin":{"agent-node":"dist/cli.js"}}\n' "$PAIRED_VERSION" > "$PAIR_ROOT/package.json"
printf '%s\n' '#!/usr/bin/env node' 'if (process.argv.includes("--help")) { console.log("--runtime codex-app-server"); process.exit(0); }' 'await new Promise(() => {});' > "$PAIR_ROOT/dist/cli.js"
chmod 755 "$PAIR_ROOT/dist/cli.js"
export ANET_AGENT_NODE_BIN="$PAIR_ROOT/dist/cli.js"
HUB_PORT=9283
HUB="http://127.0.0.1:$HUB_PORT"
export COMMHUB_AUTH_TOKEN="t738-hub-token"
(cd /workspace/server && PORT=$HUB_PORT COMMHUB_DB=/root/t738-hub.db bun run src/index.ts > /root/t738-hub.log 2>&1 &)
for _ in $(seq 60); do curl -fsS -o /dev/null "$HUB/health" 2>/dev/null && break; sleep 0.5; done
WORK=$(mktemp -d /root/t738-work.XXXXXX)
ANET=(bun /workspace/agent-network/bin/cli.ts)
(cd "$WORK" && { printf '\n' | "${ANET[@]}" init --hub "$HUB" || true; "${ANET[@]}" register --username t738 --password pass123456 || true; "${ANET[@]}" login --username t738 --password pass123456 || true; }) > /root/t738-anet-setup.log 2>&1
NODE_N=0
# launch FIXTURE(mixed|broken) ANSWER(-|y|n) [EXTRA-ARGS...] → a fresh node holding a copy of the
# fixture rollout, recorded thread = TID; runs its real start (ANSWER != - : on a pty, answering
# the y/N prompt). Sets LOG NODE_DIR NH ROLLOUT SUM0 MODE0 CFG_THREAD.
launch() {
  NODE_N=$((NODE_N + 1))
  local node="t738n$NODE_N" fixture=$1 answer=$2; shift 2
  (cd "$WORK" && "${ANET[@]}" node create "$node" --runtime codex-cli --hub "$HUB") >> /root/t738-anet-setup.log 2>&1 || true
  NODE_DIR="$WORK/.anet/nodes/$node"; NH="$NODE_DIR/codex-home"
  mkdir -p "$NH"; chmod 700 "$NH"; cp "$TPL/auth.json" "$NH/auth.json"; chmod 600 "$NH/auth.json"
  cp -a "$TPL/sessions" "$NH/sessions"
  ROLLOUT=$(find "$NH/sessions" -name "rollout-*-$TID.jsonl")
  if [ "$fixture" = broken ]; then   # drop the session_meta line: a different resume error
    tail -n +2 "$ROLLOUT" > "$ROLLOUT.tmp"; cat "$ROLLOUT.tmp" > "$ROLLOUT"; rm -f "$ROLLOUT.tmp"
  fi
  python3 - "$NODE_DIR/config.json" "$TID" <<'PY'
import json, sys
p, tid = sys.argv[1:]
c = json.load(open(p)); c["codexThreadId"] = tid
json.dump(c, open(p, "w"), indent=2)
PY
  SUM0=$(sha256sum "$ROLLOUT"); MODE0=$(stat -c '%a %s %Y' "$ROLLOUT")
  LOG="/root/t738-start-$node.log"
  local cmd=(env PATH="$PATH" timeout --foreground 150 "${ANET[@]}" node start "$node" --accept-dev-channels --codex-bin "$C159" "$@")
  if [ "$answer" = - ]; then (cd "$WORK" && "${cmd[@]}" < /dev/null) > "$LOG" 2>&1 || true
  else (cd "$WORK" && python3 /workspace/$SUITE/answer.py 'into a new thread now? [y/N]' "$answer" -- "${cmd[@]}") > "$LOG" 2>&1 || true; fi
  CFG_THREAD=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('codexThreadId',''))" "$NODE_DIR/config.json")
  (cd "$WORK" && timeout 30 "${ANET[@]}" node stop "$node") >/dev/null 2>&1 || true
}
original_untouched() { [ "$SUM0" = "$(sha256sum "$ROLLOUT")" ] && [ "$MODE0" = "$(stat -c '%a %s %Y' "$ROLLOUT")" ]; }
rollout_count() { find "$NH/sessions" -name 'rollout-*.jsonl' | wc -l; }
no_fork_no_changes() { # the node was not forked and nothing was written for a fork
  original_untouched && [ "$CFG_THREAD" = "$TID" ] && [ ! -e "$NODE_DIR/codex-fork-recovery.json" ] \
    && [ ! -e "$NODE_DIR/rollout-snapshots" ] && [ "$(rollout_count)" = 1 ] && ! grep -Fq 'forked thread' "$LOG"
}
forked_ok() { # the fork happened, the node runs on the new thread, original untouched, snapshot r/o, mapping recorded
  local r
  original_untouched || { echo "   original rollout changed"; return 1; }
  [ -n "$CFG_THREAD" ] && [ "$CFG_THREAD" != "$TID" ] || { echo "   config thread=$CFG_THREAD"; return 1; }
  grep -Fq "thread: $CFG_THREAD" "$LOG" || { echo "   launcher did not continue on $CFG_THREAD"; return 1; }
  r=$(python3 - "$NODE_DIR/codex-fork-recovery.json" "$TID" "$CFG_THREAD" "$ROLLOUT" "${SUM0%% *}" "${1:-}" <<'PY'
import json, os, stat, sys
p, old, new, orig, sha, request_id = sys.argv[1:]
f = json.load(open(p))["forks"]
m = f[-1]
ok = len(f) == 1 and m["oldThreadId"] == old and m["newThreadId"] == new and m["originalRollout"] == orig \
  and m["sha256"] == sha and m["at"] and os.path.isfile(m["snapshot"]) \
  and not (os.stat(m["snapshot"]).st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)) \
  and open(m["snapshot"], "rb").read() == open(orig, "rb").read() \
  and (m.get("requestId") == request_id if request_id else "requestId" not in m)
print("ok" if ok else "bad " + json.dumps(m))
PY
) || r="no state file"
  [ "$r" = ok ] || { echo "   mapping: $r"; return 1; }
  r=$(CODEX_HOME=$NH python3 "$SUITE/codex-rpc.py" resume "$C159" /root/t738-cwd "$CFG_THREAD")
  printf '%s' "$r" | grep -Fq "RESUME OK $CFG_THREAD" || { echo "   new thread resume: $r"; return 1; }
}

launch mixed -
if grep -Fq 'missing an ordinal' "$LOG" && grep -Fq 'mixes codex versions' "$LOG" && grep -Fq 'Fail-closed' "$LOG" && no_fork_no_changes; then
  pass "L3 without the flag: fail-closed with the #2501 diagnosis, nothing changed (as before)"
else fail "L3 without the flag"; tail -30 "$LOG"; fi

launch mixed - --fork-on-resume-failure
if grep -Fq 'also needs --yes' "$LOG" && grep -Fq 'Fail-closed' "$LOG" && no_fork_no_changes; then
  pass "L3 flag, no terminal, no --yes: no fork, no file changes"
else fail "L3 flag without --yes"; tail -30 "$LOG"; fi

launch mixed n --fork-on-resume-failure
if grep -Fq '[y/N]' "$LOG" && grep -Fq 'keep it, do not move or delete it' "$LOG" && grep -Fq 'Not confirmed' "$LOG" && no_fork_no_changes; then
  pass "L3 flag, interactive answer 'n': no fork, no file changes"
else fail "L3 interactive n"; tail -30 "$LOG"; fi

launch broken - --fork-on-resume-failure --yes
if grep -Fq 'Fail-closed' "$LOG" && ! grep -Fq 'missing an ordinal' "$LOG" && no_fork_no_changes; then
  pass "L3 a different resume failure (no session meta) with --fork-on-resume-failure --yes: no fork"
else fail "L3 other error class"; tail -30 "$LOG"; fi

launch mixed - --fork-on-resume-failure --yes --fork-recovery-request-id str_0123456789ab
if forked_ok str_0123456789ab; then pass "L3 --fork-on-resume-failure --yes: forked, node on the new thread, original unchanged, r/o snapshot, request-bound mapping recorded"
else fail "L3 fork with --yes"; tail -40 "$LOG"; fi
echo "   --- launcher output (fork) ---"; grep -F -e '[anet] --fork' -e 'snapshot' -e 'forked thread' -e 'thread:' "$LOG" | sed 's/^/   /' || true

launch mixed y --fork-on-resume-failure
if forked_ok; then pass "L3 interactive answer 'y': forked"; else fail "L3 interactive y"; tail -40 "$LOG"; fi

echo "── mutations of the shipped source (each must go red)"
FORK=agent-network/src/codex-fork-recovery.ts
# mutate NAME FILE PYTHON-REPLACE-FROM PYTHON-REPLACE-TO CHECK   (test734 form; anchors are literals)
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
    no-yes) launch mixed - --fork-on-resume-failure; no_fork_no_changes || red=1 ;;
    other-class) launch broken - --fork-on-resume-failure --yes; no_fork_no_changes || red=1 ;;
    fork) launch mixed - --fork-on-resume-failure --yes; forked_ok >/dev/null || red=1 ;;
    mapping) (cd agent-network && bun test src/codex-fork-recovery.test.ts) >/tmp/t738-mapping-mutant.log 2>&1 || red=1 ;;
  esac
  cp "$bak" "$file"; rm -f "$bak"
  if [ "$red" -eq 1 ]; then pass "mutation $name → red ($check)"; else fail "mutation $name stayed green ($check)"; fi
}
mutate M1-fork-without-confirmation "$FORK" '    let confirmed = false;' '    let confirmed = true;' no-yes
mutate M2-any-error-class "$FORK" '    if (!o.enabled || !o.threadId || !isMissingOrdinalError(message)) throw error;' '    if (!o.enabled || !o.threadId) throw error;' other-class
mutate M3-writes-the-original "$FORK" '    const after = sha256OfFile(original);' '    require("node:fs").appendFileSync(original, "\n"); const after = snap.sha256;' fork
mutate M4-snapshot-left-writable "$FORK" '  chmodSync(path, statSync(path).mode & 0o555);' '  chmodSync(path, statSync(path).mode | 0o200);' fork
mutate M5-unreadable-history-is-empty "$FORK" '    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];' '    return []; // mutant: swallow all history errors' mapping

echo "T738 PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
