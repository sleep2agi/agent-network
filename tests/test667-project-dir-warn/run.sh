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
ANCHOR='  const root = workspaceRootFromNodeConfig(configPath);'
REPL='  const root = null;'

need_count() {
  local n
  n=$(grep -F -c "$1" "$2" || true)
  if [[ "$n" != "$3" ]]; then
    echo "FAIL: count of [$1] in $2 is $n, expected $3"
    exit 1
  fi
}

need_count 'project_dir: process.cwd()' "$CLI" 1
need_count 'projectDirMismatchWarning(' "$CLI" 1
need_count 'statusTaskForReport(' "$CLI" 1
need_count 'task: projectDirMismatchHint' "$CLI" 1
need_count 'lastReportedStatus = { status: rawStatus, task: hintedTask };' "$CLI" 1
need_count 'gateStatusOnModelAuth(rawStatus, hintedTask, health.model_auth, NODE_CODEX_HOME)' "$CLI" 1
need_count '{ status: rawStatus, task: hintedTask }' "$CLI" 2
need_count "$ANCHOR" "$HELPER" 1

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

echo '== green: workspace root, then node directory =='
run_probe root /work
run_probe node /work/.anet/nodes/demo-node

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
