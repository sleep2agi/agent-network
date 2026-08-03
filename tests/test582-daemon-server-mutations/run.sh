#!/usr/bin/env bash
set -euo pipefail

SOURCE=${SOURCE:-/source}
PASS=0
fail() { echo "FAIL: $*"; exit 1; }
ok() { PASS=$((PASS+1)); echo "PASS $PASS: $*"; }

fresh_server() {
  rm -rf /tmp/test582-server
  cp -a /app/server /tmp/test582-server
  cp "$SOURCE/server/src/tools.ts" "$SOURCE/server/src/daemon-control.ts" \
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
COMMHUB_DB=/tmp/test582-baseline.db bun test \
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

echo "RESULT: PASS ($PASS checks; 4/4 controlled mutations witnessed red)"
