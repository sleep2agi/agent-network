#!/bin/sh
set -eu

src=agent-node/src/cli.ts
module=agent-node/src/runtime/commhub-poll-compensator.ts
test_file=agent-node/src/runtime/commhub-poll-compensator.test.ts
tmp_cli=/tmp/cli.ts.baseline
tmp_module=/tmp/compensator.ts.baseline
cp "$src" "$tmp_cli"
cp "$module" "$tmp_module"

expect_red() {
  name=$1
  filter=$2
  if bun test "$test_file" -t "$filter" >/tmp/witnessed-red.log 2>&1; then
    echo "FAIL: mutation stayed green: $name"
    cat /tmp/witnessed-red.log
    exit 1
  fi
  echo "WITNESSED RED: $name"
}

# Mutation 1: polling bypasses/no longer wakes the production drain.
sed -i 's/scheduleInboxDrain: scheduleWorkInboxDrain,/scheduleInboxDrain: () => {},/' "$src"
expect_red "poll wake disconnected from existing inbox lane" "production wiring keeps SSE primary"
cp "$tmp_cli" "$src"

# Mutation 2: cursor is persisted before the authoritative Hub ACK.
sed -i '/await ackMessage(msg.id);/{N;s/    await ackMessage(msg.id);\n    commhubCompensation?.recordConsumed(msg);/    commhubCompensation?.recordConsumed(msg);\n    await ackMessage(msg.id);/;}' "$src"
expect_red "cursor advances before Hub ACK" "production records the durable cursor"
cp "$tmp_cli" "$src"

# Mutation 3: unsupported Hub falsely advertises active compensation.
sed -i 's/currentMode = "realtime-only";/currentMode = "active";/' "$module"
expect_red "old Hub falsely claims compensation" "old Hub visibly degrades"
cp "$tmp_module" "$module"

# Mutation 4: callback failure incorrectly advances the terminal watermark.
sed -i 's/if (row) { row.state = "pending"; row.lease_until = 0; }/if (row) { row.state = "delivered"; row.lease_until = 0; } state.outbound_terminal_watermark = terminalSeq;/' "$module"
expect_red "callback failure loses durable retry" "callback failure returns durable delivery"
cp "$tmp_module" "$module"

# Mutation 5: metadata bypasses authenticated Dashboard provenance.
sed -i 's/return authenticatedDashboardRequestId(message);/return String(message.meta?.client_request_id ?? "") || null;/' "$module"
expect_red "node metadata poisons Dashboard request dedup" "node-supplied or malformed"
cp "$tmp_module" "$module"

# Mutation 6: client drops the explicit durable cursor protocol request.
sed -i 's/durable_cursor: true,/durable_cursor: false,/' "$src"
expect_red "outbound query drops immutable cursor protocol" "production wiring keeps SSE primary"
cp "$tmp_cli" "$src"

# Mutation 7: delivered callbacks stop advancing the monotonic terminal watermark.
sed -i 's/state.outbound_terminal_watermark = Math.max(state.outbound_terminal_watermark, terminalSeq);/state.outbound_terminal_watermark = state.outbound_terminal_watermark;/' "$module"
expect_red "delivered terminal watermark no longer advances" "production dedup imports"
cp "$tmp_module" "$module"

rm -f "$tmp_cli" "$tmp_module" /tmp/witnessed-red.log
