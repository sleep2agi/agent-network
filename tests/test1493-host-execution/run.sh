#!/bin/sh
set -eu
# qa.sh supplies these from the exact checked-out Git HEAD, not the branch name.
node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { SOURCE_COMMIT, RUNSH_BLOB } = process.env;
if (!/^[0-9a-f]{40}$/.test(SOURCE_COMMIT ?? '') || !/^[0-9a-f]{40}$/.test(RUNSH_BLOB ?? '')) {
  throw new Error('SOURCE_COMMIT and RUNSH_BLOB must be full lowercase Git SHAs');
}
const bytes = readFileSync('tests/test1493-host-execution/run.sh');
const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
if (actual !== RUNSH_BLOB) throw new Error('RUNSH_BLOB does not match the executed runner');
console.log(`source_commit=${SOURCE_COMMIT} runsh_blob=${actual}`);
JS
bun test server/src/host-execution-receipt.test.ts
bun test server/src/host-execution-http.test.ts
# Existing server authority, status/fork and read-scope contracts, fresh DB each.
COMMHUB_DB=/tmp/1493-start.db bun test server/src/start-node.test.ts
COMMHUB_DB=/tmp/1493-stop.db bun test server/src/stop-delete-node.test.ts
COMMHUB_DB=/tmp/1493-read.db bun test server/src/node-lifecycle-read-http.test.ts
# Existing runtime start/create/stop behavior; old Hub path must remain intact.
bun test agent-node/src/runtime/start-daemon.test.ts
bun test agent-node/src/runtime/create-node-daemon.test.ts
# Fault mutation controls run last, in disposable copies only.
node tests/test1493-host-execution/mutants.mjs
