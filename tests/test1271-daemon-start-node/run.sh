#!/usr/bin/env bash
set -euo pipefail
sha=${TEST1271_SOURCE_COMMIT:-}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: exact SOURCE_COMMIT required"; exit 1; }
echo "source_commit=$sha"

echo '[L0] build/typecheck'
(cd agent-node && npm run build)
(cd server && npx tsc --noEmit)

echo '[L1] focused daemon + Hub handlers'
(cd agent-node && bun test src/runtime/start-daemon.test.ts)
rm -f "$COMMHUB_DB"
bun test server/src/start-node.test.ts

echo '[L2] witnessed-red local node-id binding'
cp agent-node/src/runtime/start-daemon.ts /tmp/start-daemon.ts
python3 - <<'PY'
from pathlib import Path
p=Path('agent-node/src/runtime/start-daemon.ts')
s=p.read_text(); needle='if (cfg?.node_id !== childNodeId) throw new Error("child_config_node_id_mismatch");'
assert s.count(needle)==1
p.write_text(s.replace(needle, '// MUTATION: node id binding removed'))
PY
set +e
(cd agent-node && bun test src/runtime/start-daemon.test.ts) >/tmp/mutation.log 2>&1
rc=$?
set -e
cp /tmp/start-daemon.ts agent-node/src/runtime/start-daemon.ts
[[ $rc -ne 0 ]] || { cat /tmp/mutation.log; echo 'FAIL: node-id mutation survived'; exit 1; }
grep -q 'mismatched node id' /tmp/mutation.log || { cat /tmp/mutation.log; echo 'FAIL: wrong assertion red'; exit 1; }
echo "MUTATION_RED node-id-binding rc=$rc"
echo 'RESULT: PASS'
