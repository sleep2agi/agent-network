#!/usr/bin/env bash
# #543 — OpenCode V2 co-presence preview. Runs only inside its Docker image:
# private tmux socket (-L test543), throwaway dirs, loopback stub model, no Hub.
set -Eeuo pipefail

REPORT="${REPORT:-/tmp/art/report-test543.txt}"
mkdir -p "$(dirname "$REPORT")"
# 🔴 Not `{ …; } | tee "$REPORT" || rc=$?`: the `|| rc=` puts the whole group
#    in an errexit-ignored context, so a red Layer 0 kept going and the suite
#    exited 0 (witnessed while writing this suite). Tee via process
#    substitution and gate every layer on its own exit code instead.
exec > >(tee "$REPORT") 2>&1

echo "# Test 543 — OpenCode V2 (@opencode/cli) co-presence preview"
echo "date: $(date -Iseconds)"
echo "bun: $(bun --version)  opencode: $(opencode --version)  tmux: $(tmux -V)"
echo
echo "## Layer 0 — unit (V2 core vs protocol fake, package gate, backend + table, V1 golden)"
l0=0
(cd /agent-node-src && bun test \
    src/runtime/opencode-copresence/v2-session.test.ts \
    src/runtime/opencode-acp/binary-v2.test.ts \
    src/runtime/opencode-backend.test.ts \
    src/runtime/opencode-v1-spawn-snapshot.test.ts) || l0=$?
if [ "$l0" -ne 0 ]; then
  echo "FAIL: Layer 0 rc=$l0 — later layers not run"
  echo "RESULT: FAIL"
  exit 1
fi
echo
h=0
bun run /test543/harness.ts || h=$?
exit "$h"
