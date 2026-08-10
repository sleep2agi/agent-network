#!/usr/bin/env bash
set -uo pipefail

REPO="${REPO:-/app}"
CLI="$REPO/agent-network/bin/cli.ts"
IDENT="$REPO/agent-network/src/copresence-identity.ts"
WORK="${WORK:-/tmp/test466}/mutations"
mkdir -p "$WORK"
cp "$CLI" "$WORK/cli.orig"
cp "$IDENT" "$WORK/identity.orig"

restore() { cp "$WORK/cli.orig" "$CLI"; cp "$WORK/identity.orig" "$IDENT"; }
trap restore EXIT

PASS=0; FAIL=0
ok() { echo "  WITNESSED-RED $*"; PASS=$((PASS+1)); }
bad() { echo "  MUTATION-FAIL $*"; FAIL=$((FAIL+1)); }

# M1 — delete the structural ownership gate.  A marker-bearing stop with an
# unrelated same-name tmux must then kill the impostor and expose the old bug.
COUNT=$(grep -Fc 'allowLegacyTmuxNameSweep && tmuxSessionRunning' "$CLI")
[[ "$COUNT" == "3" ]] || { echo "M1 anchor count=$COUNT"; exit 1; }
sed -i 's/allowLegacyTmuxNameSweep && tmuxSessionRunning/tmuxSessionRunning/g' "$CLI"
cmp -s "$CLI" "$WORK/cli.orig" && { echo "M1 no-op"; exit 1; }
ALIAS=mut466
NODE_DIR="${HOME}/project/.anet/nodes/$ALIAS"
mkdir -p "$NODE_DIR"
cat >"$NODE_DIR/config.json" <<'JSON'
{"node_name":"mut466","runtime":"claude-code-cli","hub":"http://127.0.0.1:1","token":"ntok_mutation_fixture"}
JSON
BOOT=$(cat /proc/sys/kernel/random/boot_id)
cat >"$NODE_DIR/copresence-identity.json" <<JSON
{"marker":"real-generation-with-no-live-pids","boot_id":"$BOOT","started_at_epoch_ms":1,"owner_uid":$(id -u),"sessions":{}}
JSON
chmod 600 "$NODE_DIR/copresence-identity.json"
tmux new-session -d -s "$ALIAS-appsrv" -e ANET_NODE_MARKER=foreign-generation bash -c 'exec sleep 600'
(cd "${HOME}/project" && anet node stop "$ALIAS" >"$WORK/m1.log" 2>&1) || true
if tmux has-session -t "=$ALIAS-appsrv" 2>/dev/null; then
  bad "M1 deleting name gate did not expose a same-name kill"
  tmux kill-session -t "=$ALIAS-appsrv" 2>/dev/null || true
else
  ok "M1 delete identity/name ownership gate"
fi
restore

# M2 — make the real environ scanner ignore every marker.  The real /proc
# integration tests must fail; a mock-only suite would stay green.
COUNT=$(grep -Fc 'if (parts.indexOf(needle) >= 0) hits.push(pid);' "$IDENT")
[[ "$COUNT" == "1" ]] || { echo "M2 anchor count=$COUNT"; exit 1; }
sed -i 's/if (parts.indexOf(needle) >= 0) hits.push(pid);/if (false) hits.push(pid);/' "$IDENT"
cmp -s "$IDENT" "$WORK/identity.orig" && { echo "M2 no-op"; exit 1; }
(cd "$REPO/agent-network" && bun test src/copresence-identity.real.test.ts >"$WORK/m2.log" 2>&1)
RC=$?
[[ "$RC" -ne 0 ]] && ok "M2 delete real marker scan" || bad "M2 real scanner mutation stayed green"
restore

# M3 — drop the post-KILL unreadable half of the fail-closed rescan.  The
# dedicated Blocker-7 regression must turn red.
COUNT=$(grep -Fc 'if (residual.length > 0 || rescan.unreadableOwnUid.length > 0)' "$IDENT")
[[ "$COUNT" == "1" ]] || { echo "M3 anchor count=$COUNT"; exit 1; }
sed -i 's/if (residual.length > 0 || rescan.unreadableOwnUid.length > 0)/if (residual.length > 0)/' "$IDENT"
cmp -s "$IDENT" "$WORK/identity.orig" && { echo "M3 no-op"; exit 1; }
(cd "$REPO/agent-network" && bun test src/copresence-identity.test.ts >"$WORK/m3.log" 2>&1)
RC=$?
[[ "$RC" -ne 0 ]] && ok "M3 delete post-rescan unreadable gate" || bad "M3 post-rescan mutation stayed green"
restore

echo "MUTATION RESULT: PASS=$PASS FAIL=$FAIL"
[[ "$PASS" -eq 3 && "$FAIL" -eq 0 ]]
