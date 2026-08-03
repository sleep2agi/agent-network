#!/usr/bin/env bash
set -euo pipefail

SOURCE=${SOURCE:-/source}
PASS=0
fail() { echo "FAIL: $*"; exit 1; }
ok() { PASS=$((PASS+1)); echo "PASS $PASS: $*"; }

fresh_server() {
  rm -rf /tmp/test582-server
  cp -a /app/server /tmp/test582-server
  cp "$SOURCE/server/src/tools.ts" "$SOURCE/server/src/push.ts" "$SOURCE/server/src/daemon-control.ts" \
     "$SOURCE/server/src/daemon-control.test.ts" "$SOURCE/server/src/daemon-control-tools.test.ts" \
     /tmp/test582-server/src/
}

fresh_agent() {
  rm -rf /tmp/test582-agent
  cp -a /app/agent-node /tmp/test582-agent
  cp "$SOURCE/agent-node/src/runtime/host-control-daemon.ts" \
     "$SOURCE/agent-node/src/runtime/host-control-daemon.test.ts" \
     /tmp/test582-agent/src/runtime/
}

fresh_server
TZ=Asia/Shanghai COMMHUB_DB=/tmp/test582-baseline.db bun test \
  /tmp/test582-server/src/daemon-control.test.ts \
  /tmp/test582-server/src/daemon-control-tools.test.ts >/tmp/test582-baseline.log 2>&1 \
  || { cat /tmp/test582-baseline.log; fail "server baseline not green"; }
fresh_agent
bun test /tmp/test582-agent/src/runtime/host-control-daemon.test.ts >>/tmp/test582-baseline.log 2>&1 \
  || { cat /tmp/test582-baseline.log; fail "agent baseline not green"; }
ok "baseline is green"

fresh_server
sed -i 's/if (enforceUserId && !getUserNetworkRole(enforceUserId, net)) return writeDeniedReply(net, "read");/if (false) return writeDeniedReply(net, "read");/g' /tmp/test582-server/src/tools.ts
if COMMHUB_DB=/tmp/test582-auth.db bun test /tmp/test582-server/src/daemon-control-tools.test.ts >/tmp/test582-auth.log 2>&1; then
  cat /tmp/test582-auth.log
  fail "cross-network authorization mutation stayed green"
fi
grep -q 'cross-network read and dispatch' /tmp/test582-auth.log || { cat /tmp/test582-auth.log; fail "authorization mutation failed for the wrong reason"; }
ok "removing the network membership gate turns red"

fresh_server
sed -i 's/if (!validLifecycleResult) {/if (false \&\& !validLifecycleResult) {/' /tmp/test582-server/src/tools.ts
if COMMHUB_DB=/tmp/test582-ack.db bun test /tmp/test582-server/src/daemon-control-tools.test.ts >/tmp/test582-ack.log 2>&1; then
  cat /tmp/test582-ack.log
  fail "ack-evidence mutation stayed green"
fi
grep -q 'success ack is fail-closed' /tmp/test582-ack.log || { cat /tmp/test582-ack.log; fail "ack mutation failed for the wrong reason"; }
ok "removing success evidence validation turns red"

fresh_agent
sed -i 's/if (lstatSync(dir).isSymbolicLink())/if (false \&\& lstatSync(dir).isSymbolicLink())/' /tmp/test582-agent/src/runtime/host-control-daemon.ts
if bun test /tmp/test582-agent/src/runtime/host-control-daemon.test.ts >/tmp/test582-symlink.log 2>&1; then
  cat /tmp/test582-symlink.log
  fail "symlink action guard mutation stayed green"
fi
grep -q 'action refuses a symlinked alias' /tmp/test582-symlink.log || { cat /tmp/test582-symlink.log; fail "symlink mutation failed for the wrong reason"; }
ok "removing the symlink action guard turns red"

fresh_agent
sed -i 's/if (cfg?.network_id && cfg.network_id !== deps.expectedNetworkId)/if (false \&\& cfg?.network_id !== deps.expectedNetworkId)/' /tmp/test582-agent/src/runtime/host-control-daemon.ts
if bun test /tmp/test582-agent/src/runtime/host-control-daemon.test.ts >/tmp/test582-drift.log 2>&1; then
  cat /tmp/test582-drift.log
  fail "network recheck mutation stayed green"
fi
grep -q 'action rechecks network and hub' /tmp/test582-drift.log || { cat /tmp/test582-drift.log; fail "network recheck mutation failed for the wrong reason"; }
ok "removing the action-time network recheck turns red"

fresh_server
sed -i 's/parseSqliteUtcMs(r.session_last_seen)/Date.parse(r.session_last_seen)/' /tmp/test582-server/src/tools.ts
if TZ=Asia/Shanghai COMMHUB_DB=/tmp/test582-time.db bun test /tmp/test582-server/src/daemon-control-tools.test.ts >/tmp/test582-time.log 2>&1; then
  cat /tmp/test582-time.log
  fail "SQLite UTC normalization mutation stayed green"
fi
grep -q 'host supervisor is online when SQLite UTC timestamp is fresh' /tmp/test582-time.log || { cat /tmp/test582-time.log; fail "timezone mutation failed for the wrong reason"; }
ok "removing SQLite UTC normalization turns red on Asia/Shanghai"

fresh_server
sed -i 's/let online = hasLiveSSESession(r.alias, r.network_id);/let online = false;/' /tmp/test582-server/src/tools.ts
if COMMHUB_DB=/tmp/test582-live-sse.db bun test /tmp/test582-server/src/daemon-control-tools.test.ts >/tmp/test582-live-sse.log 2>&1; then
  cat /tmp/test582-live-sse.log
  fail "live-SSE presence mutation stayed green"
fi
grep -q 'live exact-network SSE keeps a daemon online' /tmp/test582-live-sse.log || { cat /tmp/test582-live-sse.log; fail "live-SSE mutation failed for the wrong reason"; }
ok "removing live SSE presence from daemon online status turns red"

echo "RESULT: PASS ($PASS checks; 6/6 controlled mutations witnessed red)"
