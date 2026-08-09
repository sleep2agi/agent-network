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
if grep -nE 'writeFileSync\((rawCfgPath|configFilePath|newCfgPath|cfgPath)' agent-network/bin/cli.ts agent-node/src/cli.ts; then
  echo "FAIL: direct token-bearing config writer bypass" >&2
  exit 1
fi
env_direct="$(grep -nE 'writeFileSync\((envPath|dotenvPath|anetEnvPath)' agent-network/bin/cli.ts || true)"
test "$(printf '%s\n' "$env_direct" | grep -c .)" -eq 1
printf '%s\n' "$env_direct" | grep -q 'mode: 0o600, flag: "wx"'
grep -q 'atomicWritePrivateJson(rawCfgPath, rawCfg)' agent-network/bin/cli.ts
grep -q 'atomicWritePrivateJson(join(dir, "config.json"), daemonConfig)' agent-network/bin/cli.ts
grep -q 'atomicWritePrivateFile(bakPath' agent-network/bin/cli.ts
test "$(grep -c 'atomicWritePrivateFile(envPath' agent-network/bin/cli.ts)" -eq 3
grep -q 'atomicWritePrivateFile(dotenvPath, body)' agent-network/bin/cli.ts
grep -q 'atomicWritePrivateFile(anetEnvPath, envContent)' agent-network/bin/cli.ts
grep -q 'repairPrivateFilePermissions(p);' agent-network/bin/cli.ts
grep -q 'repairPrivateFilePermissions(path);' agent-network/bin/cli.ts
test "$(grep -c 'atomicWriteJson(configFilePath, cfg)' agent-node/src/cli.ts)" -eq 4
test "$(grep -c 'repairPrivateConfigPermissions' agent-node/src/cli.ts)" -eq 5
grep -A2 'function loadEnvFile(path: string)' agent-node/src/cli.ts | grep -q 'repairPrivateConfigPermissions(path)'

# Real startup gate: an existing legacy config must be repaired before the
# process reaches any Hub/runtime work. Use an isolated HOME + unreachable Hub,
# then stop only the exact PID we launched.
startup_repair_gate() {
  local root="$1"
  test ! -e "$root"
  mkdir -p "$root/home" "$root/.anet/nodes/legacy"
  local cfg="$root/.anet/nodes/legacy/config.json"
  cat >"$cfg" <<'JSON'
{"alias":"legacy","node_id":"n_test631","runtime":"claude-agent-sdk","model":"synthetic","hub":"http://127.0.0.1:1","token":"ntok_synthetic"}
JSON
  chmod 0644 "$cfg"
  HOME="$root/home" bun agent-node/src/cli.ts --config "$cfg" --alias legacy \
    >"$root/start.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 100); do
    if [ "$(stat -c '%a' "$cfg")" = 600 ]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.02
  done
  local mode
  mode=$(stat -c '%a' "$cfg")
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  test "$mode" = 600
}

startup_repair_gate /tmp/test631-startup-green

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

# Witnessed red 2: deleting the startup repair call leaves a real legacy
# config at 0644. This is a behavior gate, not a source-count proxy.
cp agent-node/src/cli.ts /tmp/test631-cli-original.ts
sed -i '/repairPrivateConfigPermissions(cfgPath);/d' agent-node/src/cli.ts
set +e
startup_repair_gate /tmp/test631-startup-mutated
repair_rc=$?
set -e
cp /tmp/test631-cli-original.ts agent-node/src/cli.ts
test "$repair_rc" -ne 0
echo "MUTATION_RED: startup-repair rc=$repair_rc"

echo "RESULT: PASS"
