#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
echo "source_commit=$SOURCE_COMMIT"
COMMHUB_DB=/tmp/human-inbox.db bun test /repo/tests/test1163-human-inbox/human-inbox.test.ts
cp /repo/server/src/human-inbox.ts /tmp/human-inbox-original.ts
cp /repo/agent-node/src/cli.ts /tmp/human-inbox-cli.ts
for seam in auth depth request; do
  cp /tmp/human-inbox-original.ts /repo/server/src/human-inbox.ts
  cp /tmp/human-inbox-cli.ts /repo/agent-node/src/cli.ts
  case "$seam" in
    auth)
      bun -e 'const p="/repo/server/src/human-inbox.ts";const a="meta.auth_origin === \"user\"";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("auth anchor");await Bun.write(p,s.replace(a,"true"));' ;;
    depth)
      bun -e 'const p="/repo/server/src/human-inbox.ts";const a="if (page.length < 256) break;";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("depth anchor");await Bun.write(p,s.replace(a,"if (true) break;"));' ;;
    request)
      bun -e 'const p="/repo/agent-node/src/cli.ts";const a="limit: 20, human_first: true";const s=await Bun.file(p).text();if(s.split(a).length!==2)throw Error("request anchor");await Bun.write(p,s.replace(a,"limit: 20, human_first: false"));' ;;
  esac
  if COMMHUB_DB=/tmp/human-inbox.db bun test /repo/tests/test1163-human-inbox/human-inbox.test.ts --test-name-pattern 'after 1000 blocked rows' > "/tmp/human-inbox-$seam.log" 2>&1; then
    echo "mutation unexpectedly passed: $seam" >&2; exit 1
  fi
  SEAM="$seam" bun -e 'const s=await Bun.file("/tmp/human-inbox-"+process.env.SEAM+".log").text();if(!s.includes("(fail)")||!s.includes("expect(received)"))throw Error("mutation did not witness assertion");console.log(process.env.SEAM+": ASSERTION RED");'
done
cp /tmp/human-inbox-original.ts /repo/server/src/human-inbox.ts
cp /tmp/human-inbox-cli.ts /repo/agent-node/src/cli.ts
