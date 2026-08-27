#!/usr/bin/env bash
set -euo pipefail
source /tests/lib/safe-rm.sh
tests/test1204-btw-production-wiring/verify-source.sh

# Witnessed-red 0: an unbound source image must be rejected before tests run.
if SOURCE_COMMIT=unbound tests/test1204-btw-production-wiring/verify-source.sh >/tmp/witness-source.log 2>&1; then
  echo "FAIL invalid SOURCE_COMMIT mutation survived"
  exit 1
fi
grep -q 'SOURCE_COMMIT must bind' /tmp/witness-source.log

bun test \
  agent-node/src/runtime/side-thread/production.test.ts \
  agent-node/src/runtime/side-thread/codex-app-server-adapter.test.ts \
  agent-node/src/runtime/side-thread/command-transport.test.ts \
  server/src/side-thread-production.test.ts \
  server/src/side-thread-command-transport.test.ts

(cd agent-node && bun run build)
bun build server/src/server.ts --target bun --outfile /tmp/commhub-server.js
tests/test1204-btw-production-wiring/production-process-e2e.sh

# Witnessed-red 1: removing the real Hub route/port installation must break the process E2E.
cp server/src/server.ts /tmp/server.ts
sed -i 's/if (productionSideThreadTransport) installSideThreadExecutionPort/if (false \&\& productionSideThreadTransport) installSideThreadExecutionPort/' server/src/server.ts
if tests/test1204-btw-production-wiring/production-process-e2e.sh >/tmp/witness-hub-wiring.log 2>&1; then
  echo "FAIL Hub production-wiring mutation survived"
  exit 1
fi
mv /tmp/server.ts server/src/server.ts

# Witnessed-red 2: removing agent-node consumer startup must break the process E2E.
cp agent-node/src/cli.ts /tmp/cli.ts
sed -i '0,/if (sideThreadsEnabled) {/s//if (false \&\& sideThreadsEnabled) {/' agent-node/src/cli.ts
if tests/test1204-btw-production-wiring/production-process-e2e.sh >/tmp/witness-node-wiring.log 2>&1; then
  echo "FAIL agent-node production-wiring mutation survived"
  exit 1
fi
mv /tmp/cli.ts agent-node/src/cli.ts

# Witnessed-red 3: dropping localImage serialization must be caught.
cp agent-node/src/runtime/side-thread/codex-app-server-adapter.ts /tmp/codex-adapter.ts
sed -i 's/{ type: "localImage", path: item.path }/{ type: "text", text: item.path }/' agent-node/src/runtime/side-thread/codex-app-server-adapter.ts
if bun test agent-node/src/runtime/side-thread/production.test.ts >/tmp/witness-image.log 2>&1; then
  echo "FAIL localImage mutation survived"
  exit 1
fi
grep -q 'Expected properties' /tmp/witness-image.log || grep -q 'localImage' /tmp/witness-image.log
mv /tmp/codex-adapter.ts agent-node/src/runtime/side-thread/codex-app-server-adapter.ts

# Witnessed-red 4: routing the consumer through ordinary tasks is forbidden.
cp agent-node/src/runtime/side-thread/command-consumer.ts /tmp/command-consumer.ts
sed -i 's/side-thread-commands/tasks/' agent-node/src/runtime/side-thread/command-consumer.ts
if bun test agent-node/src/runtime/side-thread/production.test.ts >/tmp/witness-task.log 2>&1; then
  echo "FAIL task-route mutation survived"
  exit 1
fi
grep -q 'Expected: true' /tmp/witness-task.log || grep -q 'side-thread-commands' /tmp/witness-task.log
mv /tmp/command-consumer.ts agent-node/src/runtime/side-thread/command-consumer.ts

# Witnessed-red 5: a durable late ACK must resume the coordinator record;
# returning the old ambiguous create record strands the accepted fork forever.
cp server/src/side-thread.ts /tmp/side-thread.ts
sed -i '0,/if (this\.createNeedsReconciliation(existing\.record))/s//if (false \&\& this.createNeedsReconciliation(existing.record))/' server/src/side-thread.ts
if bun test server/src/side-thread-command-transport.test.ts -t 'late fork and start ACKs reconcile' >/tmp/witness-late-ack.log 2>&1; then
  echo "FAIL late-ACK coordinator reconciliation mutation survived"
  exit 1
fi
grep -q 'Expected promise that rejects' /tmp/witness-late-ack.log || grep -q 'SIDE_THREAD_AMBIGUOUS' /tmp/witness-late-ack.log
mv /tmp/side-thread.ts server/src/side-thread.ts

# Witnessed-red 6: authoritative late failures must leave reconciliation in a
# stable failed state and clear the active attempt.
cp server/src/side-thread.ts /tmp/side-thread-failure.ts
sed -i "s/state IN ('starting','ambiguous','reconciling')/state='starting'/" server/src/side-thread.ts
if bun test server/src/side-thread-command-transport.test.ts -t 'late unsupported fork ACK converges' >/tmp/witness-late-failure.log 2>&1; then
  echo "FAIL late authoritative-failure convergence mutation survived"
  exit 1
fi
grep -q 'state.*failed' /tmp/witness-late-failure.log || grep -q 'reconciling' /tmp/witness-late-failure.log
mv /tmp/side-thread-failure.ts server/src/side-thread.ts

# Witnessed-red 7: all lifecycle actions depend on the shared durable-receipt
# reconciler; deleting that production seam must break the table gate.
cp server/src/side-thread.ts /tmp/side-thread-lifecycle.ts
sed -i 's/private async reconcileLifecycleOperation/private async disabledLifecycleReconciliation/' server/src/side-thread.ts
if bun test server/src/side-thread-command-transport.test.ts -t 'cancel consumes a late accepted receipt' >/tmp/witness-lifecycle-reconcile.log 2>&1; then
  echo "FAIL lifecycle reconciliation deletion survived"
  exit 1
fi
grep -q 'reconcileLifecycleOperation' /tmp/witness-lifecycle-reconcile.log
mv /tmp/side-thread-lifecycle.ts server/src/side-thread.ts

# Witnessed-red 8: slow-path lifecycle settlement must publish the same domain
# event as the synchronous fast path, once.
cp server/src/side-thread.ts /tmp/side-thread-event.ts
sed -i 's/`side_chat\.\${action === "archive"/`side_chat.missing.${action === "archive"/' server/src/side-thread.ts
if bun test server/src/side-thread-command-transport.test.ts -t 'archive consumes a late accepted receipt' >/tmp/witness-lifecycle-event.log 2>&1; then
  echo "FAIL lifecycle domain-event mutation survived"
  exit 1
fi
grep -q 'side_chat.archived' /tmp/witness-lifecycle-event.log
mv /tmp/side-thread-event.ts server/src/side-thread.ts

# Witnessed-red 9: observer exceptions must be isolated per listener after the
# durable event transaction commits.
cp server/src/side-thread.ts /tmp/side-thread-observer.ts
sed -i '/queueMicrotask/,/Durable side_chat_events/ s/} catch {/} finally {/' server/src/side-thread.ts
if bun test server/src/side-thread.test.ts -t 'throwing observers cannot alter durable truth' >/tmp/witness-observer.log 2>&1; then
  echo "FAIL observer isolation mutation survived"
  exit 1
fi
test -s /tmp/witness-observer.log
mv /tmp/side-thread-observer.ts server/src/side-thread.ts

# Witnessed-red 10: a committed runtime receipt followed by a local apply
# failure is recoverable ambiguity, never an authoritative runtime failure.
cp server/src/side-thread.ts /tmp/side-thread-apply-class.ts
sed -i 's/throw ambiguousError(input.operationId, input.sideChatId, input.attemptId);/throw new SideThreadError("SIDE_THREAD_RUNTIME_ERROR", "misclassified local apply", 502);/g' server/src/side-thread.ts
if bun test server/src/side-thread-command-transport.test.ts -t 'archive consumes a late accepted receipt' >/tmp/witness-apply-class.log 2>&1; then
  echo "FAIL local-apply classification mutation survived"
  exit 1
fi
grep -q 'SIDE_THREAD_AMBIGUOUS' /tmp/witness-apply-class.log
mv /tmp/side-thread-apply-class.ts server/src/side-thread.ts

# Witnessed-red 11: accepted create fork/start receipts whose local projection
# fails must stay replayable, never become a terminal runtime failure.
cp server/src/side-thread.ts /tmp/side-thread-create-apply.ts
sed -i '/private applyRuntimeReceipt/,/private async reconcileLifecycleOperation/ s/"SIDE_THREAD_AMBIGUOUS",/"SIDE_THREAD_RUNTIME_ERROR",/' server/src/side-thread.ts
if bun test server/src/side-thread-command-transport.test.ts -t 'late fork and start ACKs reconcile' >/tmp/witness-create-apply.log 2>&1; then
  echo "FAIL create local-apply classification mutation survived"
  exit 1
fi
grep -q 'SIDE_THREAD_AMBIGUOUS' /tmp/witness-create-apply.log
mv /tmp/side-thread-create-apply.ts server/src/side-thread.ts

if [[ "${BTW_LIVE_PROBE:-0}" == "1" ]]; then
  test "$(codex --version)" = "codex-cli 0.148.0"
  test -n "${CODEX_HOME:-}"
  test -f "$CODEX_HOME/.anet-btw-probe-sentinel"
  test "$(cat "$CODEX_HOME/.anet-btw-probe-sentinel")" = "test1190-disposable-v2"
  export REPORT_DIR="${REPORT_DIR:-/probe/out}"
  mkdir -p "$REPORT_DIR"
  cleanup_live_home() {
    test -f "$CODEX_HOME/.anet-btw-probe-sentinel" || return 1
    test "$(cat "$CODEX_HOME/.anet-btw-probe-sentinel")" = "test1190-disposable-v2"
    find "$CODEX_HOME" -mindepth 1 -delete
  }
  trap cleanup_live_home EXIT
  node tests/test1204-btw-production-wiring/attachment-live-probe.mjs > "$REPORT_DIR/attachment-live-result.json"
  jq -e '
    .evidenceRevision == "test1204-local-image-v1" and
    .inputType == "localImage" and
    .promptContainsMarker == false and
    .modelAnswerMarkerObserved == true and
    .threadReadMarkerObserved == true and
    .imageMode == 384 and
    (.markerSha256 | test("^[a-f0-9]{64}$"))
  ' "$REPORT_DIR/attachment-live-result.json" >/dev/null
fi

echo "PASS test1204 BTW production wiring (58 baseline, real two-process E2E, 12 witnessed-red, 2 bundles)"
