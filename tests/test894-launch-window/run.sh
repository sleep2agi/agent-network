#!/bin/sh
set -eu
mkdir -p /tmp/art
status=0
sh -c 'bun test /source/agent-node/src/runtime/opencode-copresence/launcher-health.test.ts && bun /fixture/probe.ts' > /tmp/art/report-test894-launch-window.txt 2>&1 || status=$?
cat /tmp/art/report-test894-launch-window.txt
test "$status" = 0 || exit "$status"
negative=0
TEST_SKIP_HEALTH_WAIT=1 bun /fixture/probe.ts > /tmp/art/negative-test894-launch-window.txt 2>&1 || negative=$?
cat /tmp/art/negative-test894-launch-window.txt
test "$negative" = 1
grep -F 'PASS: real launcher exit0 + live same-generation records BEFORE exec precisely rejects TUI session mismatch' /tmp/art/negative-test894-launch-window.txt
grep -Fx 'AssertionError: bounded full-identity wait did not observe exec' /tmp/art/negative-test894-launch-window.txt
echo 'PASS: bypassed wait rejected at exact post-exec readiness assertion'
