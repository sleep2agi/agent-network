#!/usr/bin/env bash
# Run only in a disposable container, without host source mounts.
set -euo pipefail
bun -e '
const fs = require("node:fs");
const file = "agent-node/src/cli.ts";
const original = fs.readFileSync(file, "utf8");
const mutant = original.replace("const stopRulesFilePolling = startRulesFilePolling(rulesFileDeps());", "const stopRulesFilePolling = () => {};");
if (original === mutant) throw Error("poll mutation anchor missing");
fs.writeFileSync(file, mutant);
'
if bun tests/test4916-rules-file-delivery/lost-doorbell.ts > /tmp/4916-mutant.log 2>&1; then
  echo 'FAIL: missing polling was not detected'
  exit 1
fi
grep -q 'isolated rules-file wait timed out' /tmp/4916-mutant.log
grep -q '"registered":true,"consumer":"agent-node"' /tmp/4916-mutant.log
echo 'PASS: removing actual agent-node poll wiring makes lost-doorbell E2E fail at request completion'
bun -e '
const fs = require("node:fs");
const file = "agent-network/src/node-server.ts";
const original = fs.readFileSync(file, "utf8");
const mutant = original.replace("stopRulesFilePolling = startRulesFilePolling({ callCommHub, runtime: \"claude\", workDir: process.cwd(), log, warn: log });", "stopRulesFilePolling = () => {};");
if (original === mutant) throw Error("channel poll mutation anchor missing");
fs.writeFileSync(file, mutant);
'
if bun tests/test4916-rules-file-delivery/lost-doorbell.ts --channel > /tmp/4916-channel-mutant.log 2>&1; then
  echo 'FAIL: missing channel polling was not detected'
  exit 1
fi
grep -q 'isolated rules-file wait timed out' /tmp/4916-channel-mutant.log
grep -q '"registered":true,"consumer":"channel"' /tmp/4916-channel-mutant.log
echo 'PASS: removing actual channel poll wiring makes lost-doorbell E2E fail at request completion'
