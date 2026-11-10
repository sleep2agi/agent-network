#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
echo "source_commit=$SOURCE_COMMIT"
bun test src/runtime/codex-app-server/owned-turn-contract.test.ts
cp src/runtime/codex-app-server-bridge.ts /tmp/owned1150-bridge.ts
cp src/runtime/codex-app-server/runtime.ts /tmp/owned1150-runtime.ts
for seam in admission attribution; do
  cp /tmp/owned1150-bridge.ts src/runtime/codex-app-server-bridge.ts
  cp /tmp/owned1150-runtime.ts src/runtime/codex-app-server/runtime.ts
  case "$seam" in
    admission)
      bun -e 'const p="src/runtime/codex-app-server-bridge.ts"; const a="if (this.turnClaimed || this.activeTurnId || this.draining) {"; const s=await Bun.file(p).text(); if(s.split(a).length!==2) throw Error("owned admission anchor not unique"); await Bun.write(p,s.replace(a,"if (false) {"));'
      pattern='authenticated human waits' ;;
    attribution)
      bun -e 'const p="src/runtime/codex-app-server/runtime.ts"; const a="if (ev.taskId !== opts.taskId) return;\n      log(`[codex-app-server] task_reply"; const s=await Bun.file(p).text(); if(s.split(a).length!==2) throw Error("runtime reply anchor not unique"); await Bun.write(p,s.replace(a,"if (false) return;\n      log(`[codex-app-server] task_reply"));'
      pattern='original runtime reply cannot settle' ;;
  esac
  if bun test src/runtime/codex-app-server/owned-turn-contract.test.ts --test-name-pattern "$pattern" > "/tmp/owned1150-$seam.log" 2>&1; then
    echo "$seam contract witness unexpectedly passed" >&2; exit 1
  fi
  SEAM="$seam" bun -e 'const s=await Bun.file("/tmp/owned1150-"+process.env.SEAM+".log").text(); if(!s.includes("(fail)")||!s.includes("expect(received)")) throw Error("contract witness did not reach behavior assertion"); console.log("production "+process.env.SEAM+" owned-turn boundary: ASSERTION RED");'
done
cp /tmp/owned1150-bridge.ts src/runtime/codex-app-server-bridge.ts
cp /tmp/owned1150-runtime.ts src/runtime/codex-app-server/runtime.ts
