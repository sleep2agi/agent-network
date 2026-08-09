#!/usr/bin/env bash
set -euo pipefail

cd /work
echo "source_commit=$TEST635_SOURCE_COMMIT"
test "$(id -u)" = 10001

echo "L0 daemon private-state unit and wiring"
bun test \
  agent-node/src/runtime/config-apply.test.ts \
  agent-node/src/runtime/create-node-daemon.test.ts \
  agent-node/src/runtime/create-node-daemon-private-wiring.test.ts

echo "L1 real non-root ownership boundary"
same_root="$(mktemp -d /tmp/test635-same.XXXXXX)"
mkdir -m 0755 "$same_root/.anet"
printf '%s\n' '{"token":"ntok_fixture"}' > "$same_root/.anet/config.json"
chmod 0666 "$same_root/.anet/config.json"
SAME_CONFIG="$same_root/.anet/config.json" bun -e '
  import { repairPrivateConfigPermissions } from "./agent-node/src/runtime/config-apply.ts";
  repairPrivateConfigPermissions(process.env.SAME_CONFIG!);
'
test "$(stat -c '%u:%a' "$same_root/.anet/config.json")" = "10001:600"
test "$(stat -c '%u:%a' "$same_root/.anet")" = "10001:700"

foreign_config=/fixtures/foreign/.anet/config.json
test "$(stat -c '%u:%a' "$foreign_config")" = "10002:600"
set +e
FOREIGN_CONFIG="$foreign_config" bun -e '
  import { repairPrivateConfigPermissions } from "./agent-node/src/runtime/config-apply.ts";
  repairPrivateConfigPermissions(process.env.FOREIGN_CONFIG!);
' >/tmp/test635-foreign-red.txt 2>&1
foreign_rc=$?
set -e
test "$foreign_rc" -ne 0
grep -Eq 'owner|refuses' /tmp/test635-foreign-red.txt
test "$(stat -c '%u:%a' "$foreign_config")" = "10002:600"
echo "FOREIGN_UID_RED: caller=10001 owner=10002 rc=$foreign_rc"

echo "L2 witnessed-red mutations"
preread_root="$(mktemp -d /tmp/test635-preread.XXXXXX)"
cp -a agent-node "$preread_root/"

# Removing the pre-read repair makes the symlink refusal behavior disappear.
sed -i '/repairPrivateConfigPermissions(path);/d' \
  "$preread_root/agent-node/src/runtime/create-node-daemon.ts"
set +e
(cd "$preread_root" && bun test agent-node/src/runtime/create-node-daemon.test.ts) \
  >/tmp/test635-preread-red.txt 2>&1
preread_rc=$?
set -e
test "$preread_rc" -ne 0
grep -Eq 'global config read refuses|expected function to throw' /tmp/test635-preread-red.txt
echo "MUTATION_RED: preread-repair rc=$preread_rc"

writer_root="$(mktemp -d /tmp/test635-writer.XXXXXX)"
cp -a agent-node "$writer_root/"
# Bypassing one daemon writer must trip the enumerated writer contract.
sed -i 's/atomicWriteJson(childCfgPath, childCfg);/void childCfgPath;/' \
  "$writer_root/agent-node/src/runtime/create-node-daemon.ts"
set +e
(cd "$writer_root" && bun test agent-node/src/runtime/create-node-daemon-private-wiring.test.ts) \
  >/tmp/test635-writer-red.txt 2>&1
writer_rc=$?
set -e
test "$writer_rc" -ne 0
grep -Eq 'toBe\(2\)|Expected.*2|expected.*2' /tmp/test635-writer-red.txt
echo "MUTATION_RED: writer-bypass rc=$writer_rc"

echo "RESULT: PASS"
