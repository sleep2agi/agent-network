#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
echo "source_commit=$SOURCE_COMMIT"
bun test src/runtime/codex-app-server/owned-followup-controller.test.ts
cp src/runtime/codex-app-server/owned-followup-controller.ts /tmp/controller1162.ts
cp src/runtime/codex-app-server/runtime.ts /tmp/controller1162-runtime.ts
for seam in body proof capacity reply; do
  cp /tmp/controller1162.ts src/runtime/codex-app-server/owned-followup-controller.ts
  cp /tmp/controller1162-runtime.ts src/runtime/codex-app-server/runtime.ts
  case "$seam" in
    body)
      bun -e 'const p="src/runtime/codex-app-server/owned-followup-controller.ts";const a="this.host.enqueueAnswer(row.entry, followUpAnswerPrompt(row.entry));";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("answer body anchor");await Bun.write(p,s.replace(a,"this.host.enqueueAnswer(row.entry, \"ACTION-ONCE:follow\");"));'
      pattern='once-only injection' ;;
    proof)
      bun -e 'const p="src/runtime/codex-app-server/owned-followup-controller.ts";const a="if (!await this.host.acceptance(row.entry)) continue;";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("input proof anchor");await Bun.write(p,s.replace(a,"if (false) continue;"));'
      pattern='unproven steer loss' ;;
    capacity)
      bun -e 'const p="src/runtime/codex-app-server/runtime.ts";const a="if (acceptedFollowUpInput) {";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("accepted capacity anchor");await Bun.write(p,s.replace(a,"if (false) {"));'
      pattern='answer capacity failure' ;;
    reply)
      bun -e 'const p="src/runtime/codex-app-server/owned-followup-controller.ts";const a="if (status === \"terminal\") { this.settleTerminal(row); continue; }";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("explicit reply anchor");await Bun.write(p,s.replace(a,"if (false) { this.settleTerminal(row); continue; }"));'
      pattern='explicit Hub reply' ;;
  esac
  if bun test src/runtime/codex-app-server/owned-followup-controller.test.ts --test-name-pattern "$pattern" > "/tmp/controller1162-$seam.log" 2>&1; then echo "$seam mutation unexpectedly green" >&2; exit 1; fi
  SEAM="$seam" bun -e 'const s=await Bun.file("/tmp/controller1162-"+process.env.SEAM+".log").text();if(!s.includes("(fail)")||!s.includes("expect(received)"))throw Error("mutation missed assertion");console.log("production "+process.env.SEAM+": ASSERTION RED");'
done
cp /tmp/controller1162.ts src/runtime/codex-app-server/owned-followup-controller.ts
cp /tmp/controller1162-runtime.ts src/runtime/codex-app-server/runtime.ts
