#!/usr/bin/env bash
set -euo pipefail
source /workspace/tests/lib/safe-rm.sh
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test650-anet-attach.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
cd /workspace

echo "# test650 — exact tmux attach"
echo "source_commit=${TEST650_SOURCE_COMMIT:-unknown}"
echo "bun=$(bun --version)"
echo "date=$(date -Is)"

run_tests() { (cd agent-network && bun test src/tmux-attach.test.ts); }
build_cli() {
  safe_rm_rf /tmp/test650-dist
  bun build agent-network/bin/cli.ts --outdir /tmp/test650-dist --entry-naming cli.js --target node \
    --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*' >/tmp/test650-build.log
  test -s /tmp/test650-dist/cli.js
}

WORK=$(mktemp -d /tmp/test650-home.XXXXXX)
trap 'safe_rm_rf "$WORK"' EXIT
mkdir -p "$WORK/project/.anet/nodes/n_test650" "$WORK/.anet" /tmp/test650-fake-bin
cp tests/test650-anet-attach/fake-bin/tmux /tmp/test650-fake-bin/tmux
chmod 0755 /tmp/test650-fake-bin/tmux
cat > "$WORK/project/.anet/nodes/n_test650/config.json" <<'JSON'
{"node_id":"n_test650","node_name":"测试牛","alias":"测试牛","runtime":"claude-agent-sdk"}
JSON
chmod 0600 "$WORK/project/.anet/nodes/n_test650/config.json"
: > /tmp/test650-attach.log

run_cli() {
  (cd "$WORK/project" && env -i PATH="/tmp/test650-fake-bin:$PATH" HOME="$WORK" LANG=C.UTF-8 \
    TMUX_ATTACH_LOG=/tmp/test650-attach.log TMUX_FIXTURE="${TMUX_FIXTURE:-full}" \
    node /tmp/test650-dist/cli.js "$@")
}

echo "L0: exact-name helper"
run_tests
echo "L1: production CLI build"
build_cli

echo "L2: real CLI attaches Unicode alias by opaque session ID"
: > /tmp/test650-attach.log
run_cli attach 测试牛
grep -Fxq 'attach-session -t $2' /tmp/test650-attach.log
if grep -Fq '$1' /tmp/test650-attach.log; then exit 1; fi

echo "L3: missing exact TUI refuses related bridge/node prefix"
: > /tmp/test650-attach.log
set +e
TMUX_FIXTURE=missing-tui run_cli attach 测试牛 >/tmp/test650-missing.out 2>&1
missing_rc=$?
set -e
test "$missing_rc" -ne 0
grep -Fq 'Refusing prefix fallback' /tmp/test650-missing.out
test ! -s /tmp/test650-attach.log

echo "L4: unknown node fails before tmux"
: > /tmp/test650-attach.log
set +e
run_cli attach 不存在 >/tmp/test650-unknown.out 2>&1
unknown_rc=$?
set -e
test "$unknown_rc" -ne 0
grep -Fq 'Node "不存在" not found.' /tmp/test650-unknown.out
test ! -s /tmp/test650-attach.log

echo "L5 witnessed-red: exact resolution weakened to prefix match"
cp agent-network/src/tmux-attach.ts /tmp/test650-helper.ts
sed -i 's/session.name === expectedName/session.name.startsWith(expectedName)/' agent-network/src/tmux-attach.ts
grep -Fq 'session.name.startsWith(expectedName)' agent-network/src/tmux-attach.ts
set +e
run_tests >/tmp/test650-prefix-mutation.log 2>&1
mutation_rc=$?
set -e
test "$mutation_rc" -ne 0
echo "MUTATION_RED: prefix-match rc=$mutation_rc"
cp /tmp/test650-helper.ts agent-network/src/tmux-attach.ts

echo "L6 restored green"
run_tests
build_cli
: > /tmp/test650-attach.log
run_cli attach 测试牛
grep -Fxq 'attach-session -t $2' /tmp/test650-attach.log
echo "RESULT: PASS"
