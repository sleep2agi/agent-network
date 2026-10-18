#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
echo "source_commit=$SOURCE_COMMIT"
bun test src/runtime/codex-app-server/followup-receipts.test.ts \
  src/runtime/codex-app-server/receipt-ledger.test.ts \
  src/runtime/codex-app-server/receipt-inspection.test.ts \
  src/runtime/codex-app-server/receipt-wiring.test.ts \
  src/runtime/codex-app-server/owned-turn-contract.test.ts
cp src/runtime/codex-app-server/receipt-ledger.ts /tmp/receipt1155.ts
cp src/runtime/codex-app-server-bridge.ts /tmp/receipt1155-bridge.ts
cp src/cli.ts /tmp/receipt1155-cli.ts
for seam in owner identity future wire replay; do
  cp /tmp/receipt1155.ts src/runtime/codex-app-server/receipt-ledger.ts
  cp /tmp/receipt1155-bridge.ts src/runtime/codex-app-server-bridge.ts
  cp /tmp/receipt1155-cli.ts src/cli.ts
  case "$seam" in
    owner)
      bun -e 'const p="src/runtime/codex-app-server/receipt-ledger.ts"; const a="if (entry.version === 2 && entry.phase !== \"answering\") {"; const s=await Bun.file(p).text(); if(s.split(a).length!==2) throw Error("owner recovery anchor"); await Bun.write(p,s.replace(a,"if (false) {"));'
      pattern='pending intent and accepted' ;;
    identity)
      bun -e 'const p="src/runtime/codex-app-server/receipt-ledger.ts"; const a="result.replyIdentityConfirmed !== true"; const s=await Bun.file(p).text(); if(s.split(a).length!==2) throw Error("identity recovery anchor"); await Bun.write(p,s.replace(a,"false"));'
      pattern='own answer recovery requires' ;;
    future)
      bun -e 'const p="src/runtime/codex-app-server/receipt-ledger.ts"; const a="if (row.version !== undefined && row.version !== 1 && row.version !== 2) throw new IncompatibleTurnReceiptError();"; const s=await Bun.file(p).text(); if(s.split(a).length!==2) throw Error("future format anchor"); await Bun.write(p,s.replace(a,"if (false) throw new IncompatibleTurnReceiptError();"));'
      pattern='unknown future format blocks' ;;
    wire)
      bun -e 'const p="src/runtime/codex-app-server-bridge.ts"; const a="if (expectedClientUserMessageId && !turn.items?.some(item => item.type === \"userMessage\" && item.clientId === expectedClientUserMessageId)) return { state: \"identity_unconfirmed\" };"; const s=await Bun.file(p).text(); if(s.split(a).length!==2) throw Error("wire identity anchor"); await Bun.write(p,s.replace(a,"if (false) return { state: \"identity_unconfirmed\" };"));'
      pattern='real WS persisted inspector' ;;
    replay)
      bun -e 'const p="src/cli.ts"; const a="if (taskId && turnReceiptLedger?.load().some(row => row.taskId === taskId && row.version === 2)) {"; const s=await Bun.file(p).text(); if(s.split(a).length!==2) throw Error("replay admission anchor"); await Bun.write(p,s.replace(a,"if (taskId && false) {"));'
      pattern='production legacy adapter refuses' ;;
  esac
  if bun test src/runtime/codex-app-server/followup-receipts.test.ts --test-name-pattern "$pattern" > "/tmp/receipt1155-$seam.log" 2>&1; then echo "$seam witness unexpectedly passed" >&2; exit 1; fi
  SEAM="$seam" bun -e 'const s=await Bun.file("/tmp/receipt1155-"+process.env.SEAM+".log").text(); if(!s.includes("(fail)")||!s.includes("expect(received)")) throw Error("witness missed behavior assertion"); console.log("production "+process.env.SEAM+" receipt isolation: ASSERTION RED");'
done
cp /tmp/receipt1155.ts src/runtime/codex-app-server/receipt-ledger.ts
cp /tmp/receipt1155-bridge.ts src/runtime/codex-app-server-bridge.ts
cp /tmp/receipt1155-cli.ts src/cli.ts
