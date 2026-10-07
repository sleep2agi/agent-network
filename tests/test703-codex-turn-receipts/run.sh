#!/usr/bin/env bash
set -euo pipefail
cd /workspace
test "${TEST703_CONTAINER:-}" = 1
REPORT="docs/tests/report-test703-codex-turn-receipts.txt"
mkdir -p docs/tests

run_green() {
  bun test \
    agent-node/src/runtime/codex-app-server/receipt-ledger.test.ts \
    agent-node/src/runtime/codex-app-server/receipt-inspection.test.ts \
    agent-node/src/runtime/codex-app-server/receipt-wiring.test.ts
}

echo "# test703 — Codex interrupted-turn receipt recovery" > "$REPORT"
echo "source_commit=${SOURCE_COMMIT}" >> "$REPORT"
run_green 2>&1 | tee -a "$REPORT"

codex133=$(find /workspace/agent-node/node_modules/@openai -path '*/vendor/*/bin/codex' -type f -print -quit)
codex159=$(find /opt/codex159/node_modules/@openai -path '*/vendor/*/bin/codex' -type f -print -quit)
[[ -x "$codex133" && -x "$codex159" ]]
CODEX_BIN="$codex133" CODEX_PROBE_VERSION=0.133.0 bun tests/test703-codex-turn-receipts/real-codex-stop-probe.ts 2>&1 | tee -a "$REPORT"
CODEX_BIN="$codex159" CODEX_PROBE_VERSION=0.159.2 bun tests/test703-codex-turn-receipts/real-codex-stop-probe.ts 2>&1 | tee -a "$REPORT"

cp agent-node/src/runtime/codex-app-server/receipt-ledger.ts /tmp/receipt-ledger.ts
cp agent-node/src/runtime/codex-app-server-bridge.ts /tmp/codex-app-server-bridge.ts
cp agent-node/src/cli.ts /tmp/agent-node-cli.ts
restore() {
  cp /tmp/receipt-ledger.ts agent-node/src/runtime/codex-app-server/receipt-ledger.ts
  cp /tmp/codex-app-server-bridge.ts agent-node/src/runtime/codex-app-server-bridge.ts
  cp /tmp/agent-node-cli.ts agent-node/src/cli.ts
}
trap restore EXIT

expect_red() {
  local label="$1" file="$2" from="$3" to="$4"
  restore
  python3 - "$file" "$from" "$to" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1]); old = sys.argv[2]; new = sys.argv[3]
s = p.read_text()
assert s.count(old) == 1, (p, old, s.count(old))
p.write_text(s.replace(old, new))
PY
  set +e
  run_green >/tmp/test703-red.log 2>&1
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    echo "mutation unexpectedly green: $label" >&2
    exit 1
  fi
  grep -q '(fail)' /tmp/test703-red.log
  echo "WITNESSED_RED $label rc=$rc" | tee -a "$REPORT"
}

expect_red expiry agent-node/src/runtime/codex-app-server/receipt-ledger.ts \
  'now - entry.startedAt >= TURN_RECEIPT_MAX_WATCH_MS' 'false'
expect_red query-retry agent-node/src/runtime/codex-app-server/receipt-ledger.ts \
  'queryErrors++;' 'queryErrors += 0;'
expect_red delivered-cleanup agent-node/src/runtime/codex-app-server/receipt-ledger.ts \
  'if (next.length !== rows.length) this.save(next);' 'if (false) this.save(next);'
expect_red exact-turn agent-node/src/runtime/codex-app-server-bridge.ts \
  'const found = turns.find((candidate) => candidate.id === turnId);
          if (found) return classifyPersistedTurn(found);' \
  'const found = turns.find((candidate) => candidate.id !== turnId);
          if (found) return classifyPersistedTurn(found);'
expect_red rejected-cleanup agent-node/src/cli.ts \
  'turnReceiptLedger?.remove(taskId);
      return "rejected";' \
  'return "rejected";'
expect_red peer-reply-ledger agent-node/src/cli.ts \
  'if (trackReceipt && taskId && inboxId && turnReceiptLedger)' \
  'if (taskId && inboxId && turnReceiptLedger)'
expect_red queued-expiry agent-node/src/runtime/codex-app-server/receipt-ledger.ts \
  'entry.state === "receipt_queued"
    && now - (entry.receiptQueuedAt ?? entry.startedAt) >= TURN_RECEIPT_MAX_WATCH_MS' \
  'false'
expect_red east-eight-time agent-node/src/runtime/codex-app-server/receipt-ledger.ts \
  'timeZone: "Asia/Shanghai"' \
  'timeZone: "UTC"'
expect_red completed-at agent-node/src/runtime/codex-app-server-bridge.ts \
  '? { completedAt: turn.completedAt }' \
  '? {}'

restore
run_green >/dev/null
echo "PASS" | tee -a "$REPORT"
