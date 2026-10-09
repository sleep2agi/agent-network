#!/usr/bin/env bash
# Docker-only mutation control. Never use this entrypoint for production.
# It deliberately corrupts only the startup evidence, not the live session.
set -euo pipefail
test -f /.dockerenv
test -f /opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-copresence/launcher-health.ts
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const path = '/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-copresence/launcher-health.ts';
const before = readFileSync(path, 'utf8');
const needle = 'const record: LaunchHealth = { version: 1, generation, writtenAt: Date.now(), bridge, serve };';
if (before.split(needle).length !== 2) throw new Error('mutation source no longer matches exactly once');
writeFileSync(path, before.replace(needle, needle.replace('generation,', 'generation: "ses_test829mismatch",')));
console.log('MUTATION: startup evidence generation=ses_test829mismatch; real session unchanged');
JS
set +e
bash /workspace/tests/test829-opencode-create/native-overlay.sh
result=$?
set -e
test "$result" = 1
test -s /artifacts/daemon.log
grep -F 'runtime_capability_check_failed' /artifacts/daemon.log
grep -F 'stale or mismatched generation' /artifacts/daemon.log
grep -F 'PASS: owned harness processes exited' /artifacts/report-test829-native.txt
if grep -F 'L4 task receipt' /artifacts/report-test829-native.txt; then
  echo 'FAIL: mutation advanced beyond create gate'
  exit 1
fi
echo 'PASS: mutated generation refused at daemon capability gate; no task layer executed'
