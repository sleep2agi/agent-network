#!/usr/bin/env bash
set -euo pipefail
cd /app
echo "source_commit=${TEST1200_SOURCE_COMMIT}"

bun test \
  agent-node/src/runtime/side-thread/command-transport.test.ts \
  server/src/side-thread-command-transport.test.ts
bun build --target=bun \
  agent-node/src/runtime/side-thread/command-transport.ts \
  agent-node/src/runtime/side-thread/command-receipts.ts \
  agent-node/src/runtime/side-thread/bring-back-journal.ts \
  agent-node/src/runtime/side-thread/materialize-command-attachment.ts \
  agent-node/src/runtime/side-thread/command-consumer.ts \
  server/src/side-thread-command-transport.ts \
  --outdir /tmp/test1200-build >/tmp/test1200-build.log

# Witness red 1: without the durable node receipt lookup, ACK-loss replay
# executes the native mutation twice.
cp agent-node/src/runtime/side-thread/command-transport.ts /tmp/node-command.ts
sed -i 's/if (prior) {/if (false \&\& prior) {/' agent-node/src/runtime/side-thread/command-transport.ts
grep -F 'if (false && prior) {' agent-node/src/runtime/side-thread/command-transport.ts >/dev/null
if bun test agent-node/src/runtime/side-thread/command-transport.test.ts >/tmp/receipt-red.log 2>&1; then
  echo "FAIL durable receipt mutation survived"
  exit 1
fi
mv /tmp/node-command.ts agent-node/src/runtime/side-thread/command-transport.ts

# Witness red 2: weakening the terminal turn binding must let a foreign turn
# settle the owned attempt and make the four-tuple test fail.
cp server/src/side-thread-command-transport.ts /tmp/hub-command.ts
sed -i 's/object(ack.result).turnId !== turnId || //' server/src/side-thread-command-transport.ts
if bun test server/src/side-thread-command-transport.test.ts >/tmp/tuple-red.log 2>&1; then
  echo "FAIL terminal four-tuple mutation survived"
  exit 1
fi
mv /tmp/hub-command.ts server/src/side-thread-command-transport.ts

# Witness red 3: allowing a sent bring-back to retry after restart duplicates
# the destination write.
cp agent-node/src/runtime/side-thread/bring-back-journal.ts /tmp/bring-back.ts
sed -i 's/if (prior.state === "sent" || prior.state === "ambiguous")/if (false)/' agent-node/src/runtime/side-thread/bring-back-journal.ts
if bun test agent-node/src/runtime/side-thread/command-transport.test.ts >/tmp/bring-red.log 2>&1; then
  echo "FAIL bring-back fail-closed mutation survived"
  exit 1
fi
mv /tmp/bring-back.ts agent-node/src/runtime/side-thread/bring-back-journal.ts

echo "PASS test1200 SideThread dedicated command transport + 3 witnessed red"
