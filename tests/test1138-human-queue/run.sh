#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
echo "source_commit=$SOURCE_COMMIT"
bun test src/inbox-dispatch.test.ts src/runtime/codex-app-server/interactive-queue.test.ts \
  src/runtime/codex-app-server/human-priority.test.ts src/runtime/codex-app-server-bridge.test.ts \
  src/runtime/codex-app-server/queue-timeout-env.test.ts src/runtime/codex-app-server/runtime.test.ts \
  src/runtime/codex-app-server/queued-row-hub-check.test.ts src/runtime/codex-app-server/queued-row-skip.test.ts
# The true production CLI entry must expose the audience only when its
# authenticated inbox flag reaches it. Keep this mutation inside Docker.
cp src/cli.ts /tmp/queue1138-original-cli.ts
bun -e 'const p="src/cli.ts"; const s=await Bun.file(p).text(); const a="interactiveDashboardTask: steerIfExternalTurn,"; if(s.split(a).length!==2) throw Error("unique production marker missing"); await Bun.write(p,s.replace(a,"interactiveDashboardTask: false,"));'
if bun test src/runtime/codex-app-server/interactive-queue.test.ts --test-name-pattern 'production CLI passes' > /tmp/queue1138-witness.log 2>&1; then
  echo 'production queue wiring witness unexpectedly passed' >&2; exit 1
fi
bun -e 'const s=await Bun.file("/tmp/queue1138-witness.log").text(); if(!s.includes("(fail)")||!s.includes("expect(received)")) throw Error("witness did not reach audience assertion"); console.log("production queue audience wiring: ASSERTION RED");'

# Independent production seams must each fail an actual behavior assertion.
cp /tmp/queue1138-original-cli.ts src/cli.ts
cp src/cli.ts /tmp/priority1141-cli.ts
cp src/runtime/codex-app-server/runtime.ts /tmp/priority1141-runtime.ts
cp src/runtime/codex-app-server-bridge.ts /tmp/priority1141-bridge.ts
for seam in dispatcher runtime bridge; do
  cp /tmp/priority1141-cli.ts src/cli.ts
  cp /tmp/priority1141-runtime.ts src/runtime/codex-app-server/runtime.ts
  cp /tmp/priority1141-bridge.ts src/runtime/codex-app-server-bridge.ts
  case "$seam" in
    dispatcher) bun -e 'const p="src/cli.ts"; const a="prioritize: isInteractiveDashboardTask,"; const b="prioritize: () => false,"; const text=await Bun.file(p).text(); if(text.split(a).length!==2) throw Error("unique dispatcher anchor missing"); await Bun.write(p,text.replace(a,b));' ;;
    runtime) bun -e 'const p="src/runtime/codex-app-server/runtime.ts"; const a="interactiveDashboardTask: opts.interactiveDashboardTask === true,"; const b="interactiveDashboardTask: false,"; const text=await Bun.file(p).text(); if(text.split(a).length!==3) throw Error("two runtime anchors missing"); await Bun.write(p,text.replaceAll(a,b));' ;;
    bridge) bun -e 'const p="src/runtime/codex-app-server-bridge.ts"; const a="const human = input.interactiveDashboardTask === true;"; const b="const human = false;"; const text=await Bun.file(p).text(); if(text.split(a).length!==2) throw Error("unique bridge anchor missing"); await Bun.write(p,text.replace(a,b));' ;;
  esac
  case "$seam" in
    dispatcher) pattern='production CLI dispatcher uses' ;;
    runtime) pattern='production runtime carries' ;;
    bridge) pattern='bridge human-first waiting order' ;;
  esac
  if bun test src/runtime/codex-app-server/human-priority.test.ts --test-name-pattern "$pattern" > "/tmp/priority1141-$seam.log" 2>&1; then
    echo "$seam priority witness unexpectedly passed" >&2; exit 1
  fi
  SEAM="$seam" bun -e 'const s=await Bun.file("/tmp/priority1141-"+process.env.SEAM+".log").text(); if(!s.includes("(fail)")||!s.includes("expect(received)")) throw Error("priority witness did not reach behavior assertion"); console.log("production "+process.env.SEAM+" priority: ASSERTION RED");'
done
