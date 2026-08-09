#!/usr/bin/env bash
set -euo pipefail

cd /work
echo "source_commit=$TEST631_SOURCE_COMMIT"

echo "L0 local-module bundle"
bun build --target bun --packages external agent-network/bin/cli.ts --outfile /tmp/anet-cli.js
bun build --target bun --packages external agent-node/src/cli.ts --outfile /tmp/agent-node-cli.js

echo "L1 permission behavior"
bun test agent-network/src/private-state.test.ts agent-node/src/runtime/config-apply.test.ts

# Production-path inventory: every token-preserving config write must use a
# private choke point. These assertions deliberately name each direct path so
# a new bypass cannot hide behind an aggregate green count.
! grep -nE 'writeFileSync\((rawCfgPath|configFilePath|newCfgPath|cfgPath)' agent-network/bin/cli.ts agent-node/src/cli.ts
grep -q 'atomicWritePrivateJson(rawCfgPath, rawCfg)' agent-network/bin/cli.ts
grep -q 'atomicWritePrivateJson(join(dir, "config.json"), daemonConfig)' agent-network/bin/cli.ts
grep -q 'atomicWritePrivateFile(bakPath' agent-network/bin/cli.ts
test "$(grep -c 'atomicWriteJson(configFilePath, cfg)' agent-node/src/cli.ts)" -eq 4
test "$(grep -c 'repairPrivateConfigPermissions' agent-node/src/cli.ts)" -eq 4

# Witnessed red 1: weakening both creation and fd hardening to 0666 must make
# the umask=000 permission tests fail.
mkdir -p /mutation/agent-network/src /mutation/agent-node/src/runtime
cp agent-network/src/private-state.ts agent-network/src/private-state.test.ts /mutation/agent-network/src/
cp agent-node/src/runtime/config-apply.ts agent-node/src/runtime/config-apply.test.ts /mutation/agent-node/src/runtime/
sed -i 's/0o600/0o666/g' /mutation/agent-network/src/private-state.ts /mutation/agent-node/src/runtime/config-apply.ts
set +e
(cd /mutation && bun test agent-network/src/private-state.test.ts agent-node/src/runtime/config-apply.test.ts) >/tmp/test631-mode-red.txt 2>&1
mode_rc=$?
set -e
test "$mode_rc" -ne 0
grep -Eq 'expected.*384|toBe\(384\)|Expected.*384' /tmp/test631-mode-red.txt
echo "MUTATION_RED: private-mode rc=$mode_rc"

# Witnessed red 2: deleting the startup repair call is caught by the exact
# production-path inventory (not by a comment/string count).
cp agent-node/src/cli.ts /tmp/test631-cli-mutated.ts
sed -i '/repairPrivateConfigPermissions(cfgPath);/d' /tmp/test631-cli-mutated.ts
set +e
test "$(grep -c 'repairPrivateConfigPermissions' /tmp/test631-cli-mutated.ts)" -eq 4
repair_rc=$?
set -e
test "$repair_rc" -ne 0
echo "MUTATION_RED: startup-repair rc=$repair_rc"

echo "RESULT: PASS"
