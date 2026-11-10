#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
echo "source_commit=$SOURCE_COMMIT"
COMMHUB_DB=/tmp/owned-followup-reply.db bun test /repo/tests/test1156-owned-followup-hub/hub-reply.test.ts
cd /repo/agent-node
bun test src/runtime/codex-app-server/followup-hub-check.test.ts \
  src/runtime/codex-app-server/followup-receipts.test.ts \
  src/runtime/codex-app-server/receipt-ledger.test.ts \
  src/runtime/codex-app-server/receipt-inspection.test.ts \
  src/runtime/codex-app-server/receipt-wiring.test.ts \
  src/runtime/codex-app-server/owned-turn-contract.test.ts
cp src/cli.ts /tmp/followup1156-cli.ts
cp src/runtime/codex-app-server/followup-hub-check.ts /tmp/followup1156-check.ts
for seam in identity terminal unknown replay; do
  cp /tmp/followup1156-cli.ts src/cli.ts
  cp /tmp/followup1156-check.ts src/runtime/codex-app-server/followup-hub-check.ts
  case "$seam" in
    identity)
      bun -e 'const p="src/runtime/codex-app-server/followup-hub-check.ts";const a="task.to_node_id !== nodeId";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("identity anchor");await Bun.write(p,s.replace(a,"false"));' ;;
    terminal)
      bun -e 'const p="src/cli.ts";const a="if (state === \"terminal\") {";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("terminal anchor");await Bun.write(p,s.replace(a,"if (false) {"));' ;;
    unknown)
      bun -e 'const p="src/cli.ts";const a="if (state === \"unknown\") continue;";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("unknown anchor");await Bun.write(p,s.replace(a,"if (false) continue;"));' ;;
    replay)
      bun -e 'const p="src/cli.ts";const a="if (await codexFollowUpHubState(entry) === \"terminal\") {";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("replay anchor");await Bun.write(p,s.replace(a,"if (false) {"));' ;;
  esac
  if [[ "$seam" = replay ]]; then
    target=src/runtime/codex-app-server/followup-receipts.test.ts
    pattern='production legacy adapter refuses'
  else
    target=src/runtime/codex-app-server/followup-hub-check.test.ts
    pattern='Hub state|production recovery'
  fi
  if bun test "$target" --test-name-pattern "$pattern" > "/tmp/followup1156-$seam.log" 2>&1; then
    echo "mutation unexpectedly passed: $seam" >&2; exit 1
  fi
  SEAM="$seam" bun -e 'const s=await Bun.file("/tmp/followup1156-"+process.env.SEAM+".log").text();if(!s.includes("(fail)")||!s.includes("expect(received)"))throw Error("mutation did not witness assertion");console.log("production "+process.env.SEAM+": ASSERTION RED");'
done
cp /tmp/followup1156-cli.ts src/cli.ts
cp /tmp/followup1156-check.ts src/runtime/codex-app-server/followup-hub-check.ts
