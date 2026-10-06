#!/usr/bin/env bash
# Board #667. The same absolute config is the node config under /work.
# One start uses that workspace root as cwd; the other uses the node directory.
# project_dir must stay the cwd either way. Forcing the mismatch check to
# succeed must make the node-directory start fail closed.
set -euo pipefail

[[ "${TEST667_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL: TEST667_SOURCE_COMMIT must be one full lowercase Git SHA' >&2
  exit 1
}
printf 'source_commit=%s\n' "$TEST667_SOURCE_COMMIT"

HELPER=/src/project-dir-mismatch.ts
CLI=/src/cli.ts
ANET_CLI=/anet/cli.ts
GATE=/anet/codex-external-appserver.ts
ANCHOR='  const root = workspaceRootFromNodeConfig(configPath);'
REPL='  const root = null;'
CWD_ANCHOR='  return plan.workspaceDir; // external bridge cwd'
CWD_REPL='  return plan.nodeDir; // external bridge cwd'

need_count() {
  local n
  n=$(grep -F -c "$1" "$2" || true)
  if [[ "$n" != "$3" ]]; then
    echo "FAIL: count of [$1] in $2 is $n, expected $3"
    exit 1
  fi
}

need_count 'project_dir: process.cwd()' "$CLI" 1
need_count 'return reportedTask({ configPath: configFilePath, cwd: process.cwd(), inFlight: getInFlightCount(), status, task });' "$CLI" 1
need_count 'if (projectDirMismatchHint) console.warn(projectDirMismatchHint);' "$CLI" 1
need_count 'task: projectDirTask("idle") ?? "",' "$CLI" 1
need_count 'const hintedTask = projectDirTask(rawStatus, rawTask);' "$CLI" 1
need_count 'lastReportedStatus = { status: rawStatus, task: rawTask };' "$CLI" 1
need_count '{ status: rawStatus, task: hintedTask }' "$CLI" 1
need_count 'gateStatusOnModelAuth(rawStatus, hintedTask, health.model_auth, NODE_CODEX_HOME)' "$CLI" 1
need_count "$ANCHOR" "$HELPER" 1
need_count 'return statusTaskForReport(input.status, input.task, hint, input.inFlight);' "$HELPER" 1
need_count 'return undefined; // board667-idle-keeps-last-task' "$HELPER" 1
need_count 'externalAppserverBridgeCwd(plan)' "$ANET_CLI" 1
need_count '"-c", plan.nodeDir' "$ANET_CLI" 2
need_count "$CWD_ANCHOR" "$GATE" 1

if grep -F -q 'process.chdir' "$CLI"; then
  echo 'FAIL: cli.ts calls process.chdir'
  exit 1
fi
if grep -F -q 'chdir(' "$HELPER"; then
  echo 'FAIL: helper changes directory'
  exit 1
fi

mkdir -p /work/.anet/nodes/demo-node /work/elsewhere
ln -sfn /work /link-work

run_probe() {
  local mode="$1" dir="$2"
  ( cd "$dir" && bun /test667/probe.mjs "$mode" )
}

apply_mutation() {
  bun -e '
    const fs = require("fs");
    const path = process.argv[1];
    const anchor = process.argv[2];
    const repl = process.argv[3];
    const text = fs.readFileSync(path, "utf8");
    const n = text.split(anchor).length - 1;
    if (n !== 1) {
      console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
      process.exit(1);
    }
    fs.writeFileSync(path, text.replace(anchor, repl));
  ' "$1" "$2" "$3"
}

expect_red() {
  local label="$1" mode="$2" dir="$3" needle="$4"
  rm -rf /root/.bun/install/cache /tmp/bun-* "${HOME:-/root}/.bun/install/cache" 2>/dev/null || true
  set +e
  run_probe "$mode" "$dir" > /tmp/test667-red.txt 2>&1
  local rc=$?
  set -e
  cat /tmp/test667-red.txt
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: $label stayed green"
    exit 1
  fi
  if ! grep -F -q "$needle" /tmp/test667-red.txt; then
    echo "FAIL: $label died for a reason other than: $needle"
    exit 1
  fi
  echo "$label red as required"
}

echo '== green: workspace root, then node directory =='
run_probe root /work
run_probe node /work/.anet/nodes/demo-node

echo '== red: cli passes a constant in-flight count =='
cp "$CLI" /tmp/cli.bak
apply_mutation "$CLI" \
  'return reportedTask({ configPath: configFilePath, cwd: process.cwd(), inFlight: getInFlightCount(), status, task });' \
  'return reportedTask({ configPath: configFilePath, cwd: process.cwd(), inFlight: 0, status, task });'
expect_red 'cli in-flight wiring' root /work 'cli wiring missing'
cp /tmp/cli.bak "$CLI"

echo '== red: cli nulls the config path =='
apply_mutation "$CLI" \
  'return reportedTask({ configPath: configFilePath, cwd: process.cwd(), inFlight: getInFlightCount(), status, task });' \
  'return reportedTask({ configPath: null, cwd: process.cwd(), inFlight: getInFlightCount(), status, task });'
expect_red 'cli config wiring' root /work 'cli wiring missing'
cp /tmp/cli.bak "$CLI"

echo '== red: cli stops using the process cwd =='
apply_mutation "$CLI" \
  'return reportedTask({ configPath: configFilePath, cwd: process.cwd(), inFlight: getInFlightCount(), status, task });' \
  'return reportedTask({ configPath: configFilePath, cwd: "/tmp", inFlight: getInFlightCount(), status, task });'
expect_red 'cli cwd wiring' root /work 'cli wiring missing'
cp /tmp/cli.bak "$CLI"

echo '== red: cli drops the startup warning =='
apply_mutation "$CLI" 'if (projectDirMismatchHint) console.warn(projectDirMismatchHint);' 'if (projectDirMismatchHint) { /* dropped */ }'
expect_red 'cli warn wiring' root /work 'cli wiring missing'
cp /tmp/cli.bak "$CLI"

echo '== red: runtimes without health report the raw task =='
apply_mutation "$CLI" \
  '{ status: rawStatus, task: hintedTask }' \
  '{ status: rawStatus, task: rawTask }'
expect_red 'hinted task wiring' root /work 'cli wiring missing'
cp /tmp/cli.bak "$CLI"
if ! cmp -s /tmp/cli.bak "$CLI"; then
  echo 'FAIL: cli source was not restored'
  exit 1
fi

echo '== red: in-flight protection is gone =='
cp "$HELPER" /tmp/helper.inflight.bak
apply_mutation "$HELPER" 'return statusTaskForReport(input.status, input.task, hint, input.inFlight);' 'return statusTaskForReport(input.status, input.task, hint, 0);'
expect_red 'in-flight protection' root /work 'in-flight idle report covered the running task'
cp /tmp/helper.inflight.bak "$HELPER"

echo '== red: idle with no warning clears the last task =='
apply_mutation "$HELPER" \
  'return undefined; // board667-idle-keeps-last-task' \
  'return ""; // board667-idle-keeps-last-task'
expect_red 'idle clears last task' root /work 'idle with no hint cleared the last task'
cp /tmp/helper.inflight.bak "$HELPER"
if ! cmp -s /tmp/helper.inflight.bak "$HELPER"; then
  echo 'FAIL: helper source was not restored after the clear mutation'
  exit 1
fi

echo '== red: product bridge cwd falls back to the node directory =='
cp "$GATE" /tmp/gate.bak
bun -e '
  const fs = require("fs");
  const path = process.argv[1];
  const anchor = process.argv[2];
  const repl = process.argv[3];
  const text = fs.readFileSync(path, "utf8");
  const n = text.split(anchor).length - 1;
  if (n !== 1) {
    console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
    process.exit(1);
  }
  fs.writeFileSync(path, text.replace(anchor, repl));
' "$GATE" "$CWD_ANCHOR" "$CWD_REPL"
if grep -F -q "$CWD_ANCHOR" "$GATE"; then
  echo 'FAIL: bridge cwd anchor still present'
  exit 1
fi
rm -rf /root/.bun/install/cache /tmp/bun-* "${HOME:-/root}/.bun/install/cache" 2>/dev/null || true
set +e
run_probe root /work > /tmp/test667-cwd.txt 2>&1
cwd_rc=$?
set -e
cat /tmp/test667-cwd.txt
cp /tmp/gate.bak "$GATE"
if [[ "$cwd_rc" -eq 0 ]]; then
  echo 'FAIL: product-bridge cwd mutation stayed green'
  exit 1
fi
if ! grep -F -q 'FAIL: product external bridge warned' /tmp/test667-cwd.txt; then
  echo 'FAIL: cwd mutation died for a reason other than the product warning'
  exit 1
fi
if ! cmp -s /tmp/gate.bak "$GATE"; then
  echo 'FAIL: gate source was not restored'
  exit 1
fi
echo 'bridge cwd mutation red as required'

cp "$HELPER" /tmp/helper.bak
bun -e '
  const fs = require("fs");
  const path = process.argv[1];
  const anchor = process.argv[2];
  const repl = process.argv[3];
  const text = fs.readFileSync(path, "utf8");
  const n = text.split(anchor).length - 1;
  if (n !== 1) {
    console.error("MUTATION_NOT_APPLIED: anchor count=" + n);
    process.exit(1);
  }
  fs.writeFileSync(path, text.replace(anchor, repl));
' "$HELPER" "$ANCHOR" "$REPL"
if grep -F -q "$ANCHOR" "$HELPER"; then
  echo 'FAIL: mutation anchor still present'
  exit 1
fi

# A second bun process must see the edited source, not a transpile cache.
rm -rf /root/.bun/install/cache /tmp/bun-* "${HOME:-/root}/.bun/install/cache" 2>/dev/null || true

echo '== red: mismatch check always succeeds =='
set +e
run_probe node /work/.anet/nodes/demo-node > /tmp/test667-mut.txt 2>&1
rc=$?
set -e
cat /tmp/test667-mut.txt
cp /tmp/helper.bak "$HELPER"
if [[ "$rc" -eq 0 ]]; then
  echo 'FAIL: node-dir mutation stayed green'
  exit 1
fi
if ! grep -F -q 'FAIL: node-dir start produced no warning' /tmp/test667-mut.txt; then
  echo 'FAIL: mutation died for a reason other than the missing warning'
  exit 1
fi
if ! cmp -s /tmp/helper.bak "$HELPER"; then
  echo 'FAIL: helper source was not restored'
  exit 1
fi
echo 'mutation red as required'
