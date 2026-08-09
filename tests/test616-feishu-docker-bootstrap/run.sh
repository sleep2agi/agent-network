#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"
export SAFE_RM_ALLOW_PREFIXES="/tmp/ /work/"

ROOT=/workspace
CLI="$ROOT/agent-network/bin/cli.ts"
ENTRYPOINT="$ROOT/docker/feishu/entrypoint.sh"
PASS=0
ASSERTS=0

pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
assert() { ASSERTS=$((ASSERTS + 1)); "$@" || fail "assertion failed: $*"; }

echo "test616 source_commit=${TEST616_SOURCE_COMMIT:-missing}"
test -n "${TEST616_SOURCE_COMMIT:-}" || fail "SOURCE_COMMIT provenance missing"

echo "L0: typecheck + source/doc contract"
(cd "$ROOT/agent-network" && bun x tsc --noEmit)
assert grep -Fq 'set -o pipefail' "$ENTRYPOINT"
assert grep -Fq 'comma-separated' "$ROOT/docker/feishu/README.md"
assert grep -Fq '多个用逗号分隔' "$ROOT/docs-site/docs/guide/feishu.md"
assert grep -Fq 'comma-separated' "$ROOT/docs-site/docs/en/guide/feishu.md"
pass "typecheck and bilingual contract"

echo "L1: real CLI CSV normalization + additive restart"
CLI_WORK=/tmp/test616-cli
safe_rm_rf "$CLI_WORK"
mkdir -p "$CLI_WORK/.anet/nodes/feishu-test"
cat >"$CLI_WORK/.anet/nodes/feishu-test/config.json" <<'JSON'
{
  "node_name": "feishu-test",
  "node_id": "n_test616",
  "runtime": "claude-agent-sdk",
  "hub": "http://127.0.0.1:1",
  "token": "ntok_test616",
  "network_id": "net_test616",
  "channels": [],
  "env": {},
  "flags": {}
}
JSON
(
  cd "$CLI_WORK"
  bun "$CLI" channel add feishu feishu-test \
    --app-id cli_dummy --app-secret dummy-secret \
    --allow ' ou_A,ou_B,,ou_A ' --allow-chat ' oc_A, oc_B,oc_A '
)
ACCESS="$CLI_WORK/.anet/nodes/feishu-test/channels/feishu/access.json"
assert bun -e 'const a=await Bun.file(process.argv[1]).json(); process.exit(JSON.stringify(a.allowFrom)==JSON.stringify(["ou_A","ou_B"]) && JSON.stringify(a.allowChats)==JSON.stringify(["oc_A","oc_B"])?0:1)' "$ACCESS"

(
  cd "$CLI_WORK"
  bun "$CLI" channel allow feishu feishu-test --add-from ou_manual --add-chat oc_manual
  bun "$CLI" channel add feishu feishu-test \
    --app-id cli_dummy --app-secret dummy-secret \
    --allow 'ou_A,ou_B' --allow-chat 'oc_A,oc_B'
)
assert bun -e 'const a=await Bun.file(process.argv[1]).json(); process.exit(a.allowFrom.includes("ou_manual") && a.allowChats.includes("oc_manual") && a.allowFrom.length===3 && a.allowChats.length===3?0:1)' "$ACCESS"

cat >"$ACCESS" <<'JSON'
{"allowFrom":["ou_legacy_A, ou_legacy_B"],"allowChats":["oc_legacy_A,oc_legacy_B"],"futureField":"kept"}
JSON
(
  cd "$CLI_WORK"
  bun "$CLI" channel add feishu feishu-test \
    --app-id cli_dummy --app-secret dummy-secret --allow ou_new --allow-chat oc_new
)
assert bun -e 'const a=await Bun.file(process.argv[1]).json(); process.exit(a.allowFrom.join(",")==="ou_legacy_A,ou_legacy_B,ou_new" && a.allowChats.join(",")==="oc_legacy_A,oc_legacy_B,oc_new" && a.futureField==="kept"?0:1)' "$ACCESS"
pass "real CLI writes arrays, preserves supported additions, and repairs legacy CSV shape"

echo "L2: malformed/empty input fail closed without partial config"
printf '%s\n' '{"allowFrom":[123],"allowChats":[]}' >"$ACCESS"
ENV_FILE="$CLI_WORK/.anet/nodes/feishu-test/channels/feishu/.env"
before_access="$(sha256sum "$ACCESS" | cut -d' ' -f1)"
before_env="$(sha256sum "$ENV_FILE" | cut -d' ' -f1)"
set +e
(cd "$CLI_WORK" && bun "$CLI" channel add feishu feishu-test --app-id changed --app-secret changed --allow ou_x) >/tmp/test616-malformed.log 2>&1
malformed_rc=$?
set -e
assert test "$malformed_rc" -ne 0
assert test "$(sha256sum "$ACCESS" | cut -d' ' -f1)" = "$before_access"
assert test "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" = "$before_env"
assert grep -Fq 'refusing malformed' /tmp/test616-malformed.log

mkdir -p "$CLI_WORK/.anet/nodes/blank-test"
cp "$CLI_WORK/.anet/nodes/feishu-test/config.json" "$CLI_WORK/.anet/nodes/blank-test/config.json"
set +e
(cd "$CLI_WORK" && bun "$CLI" channel add feishu blank-test --app-id cli_dummy --app-secret dummy --allow ' ,  ,' --allow-chat ',') >/tmp/test616-blank.log 2>&1
blank_rc=$?
set -e
assert test "$blank_rc" -ne 0
assert test ! -e "$CLI_WORK/.anet/nodes/blank-test/channels/feishu/access.json"
pass "malformed existing state and empty CSV fail closed"

make_fake_bin() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/anet" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>/tmp/test616-anet-calls
if [ "${1:-}" = login ]; then echo '✅ Logged in as test'; exit 0; fi
if [ "${1:-} ${2:-} ${3:-}" = 'channel add feishu' ] && [ "${FAIL_CHANNEL_ADD:-0}" = 1 ]; then
  echo 'synthetic channel failure' >&2
  exit 42
fi
exit 0
SH
  cat >"$dir/agent-node" <<'SH'
#!/usr/bin/env bash
touch /tmp/test616-agent-started
exit 0
SH
  chmod 0755 "$dir/anet" "$dir/agent-node"
}

prepare_entrypoint_case() {
  safe_rm_rf /work/.anet /tmp/test616-agent-started /tmp/test616-anet-calls
  mkdir -p /work/.anet/nodes/feishu-docker
  printf '%s\n' '{}' >/work/.anet/nodes/feishu-docker/config.json
}

run_entrypoint() {
  local script="$1"
  HUB_URL=http://hub.invalid HUB_USER=user HUB_PASSWORD=pass \
  FEISHU_APP_ID=cli_dummy FEISHU_APP_SECRET=dummy ANET_MODEL=mock \
  ANTHROPIC_BASE_URL=http://model.invalid ANTHROPIC_AUTH_TOKEN=dummy \
  NODE_ALIAS=feishu-docker PATH="/tmp/test616-bin:$PATH" \
  bash "$script"
}

echo "L3: entrypoint happy path normalizes args"
make_fake_bin /tmp/test616-bin
prepare_entrypoint_case
FEISHU_ALLOW_FROM=' ou_A,ou_B,,ou_A ' FEISHU_ALLOW_CHATS=' oc_A, oc_B,oc_A ' run_entrypoint "$ENTRYPOINT" >/tmp/test616-entry-happy.log 2>&1
assert test -e /tmp/test616-agent-started
assert grep -Fq -- '--allow ou_A,ou_B --allow-chat oc_A,oc_B' /tmp/test616-anet-calls
pass "entrypoint forwards one normalized CSV value per allowlist"

echo "L4: empty input and unknown channel failure never start agent-node"
prepare_entrypoint_case
set +e
FEISHU_ALLOW_FROM=' ,  ,' FEISHU_ALLOW_CHATS='  ,' run_entrypoint "$ENTRYPOINT" >/tmp/test616-entry-empty.log 2>&1
empty_rc=$?
set -e
assert test "$empty_rc" -ne 0
assert test ! -e /tmp/test616-agent-started
assert test ! -e /tmp/test616-anet-calls

prepare_entrypoint_case
set +e
FAIL_CHANNEL_ADD=1 FEISHU_ALLOW_FROM=ou_A FEISHU_ALLOW_CHATS= run_entrypoint "$ENTRYPOINT" >/tmp/test616-entry-fail.log 2>&1
channel_rc=$?
set -e
assert test "$channel_rc" -ne 0
assert test ! -e /tmp/test616-agent-started
assert grep -Fq 'synthetic channel failure' /tmp/test616-entry-fail.log
pass "entrypoint rejects empty bootstrap and propagates unknown channel-add failure"

echo "L5: witnessed-red mutations"
MUT_ENTRY=/tmp/test616-entrypoint-no-pipefail.sh
sed '/set -o pipefail/d' "$ENTRYPOINT" >"$MUT_ENTRY"
prepare_entrypoint_case
set +e
FAIL_CHANNEL_ADD=1 FEISHU_ALLOW_FROM=ou_A FEISHU_ALLOW_CHATS= run_entrypoint "$MUT_ENTRY" >/tmp/test616-mut-pipefail.log 2>&1
mut_pipe_rc=$?
set -e
assert test "$mut_pipe_rc" -eq 0
assert test -e /tmp/test616-agent-started
echo "WITNESSED_RED: removing pipefail lets failed channel-add reach agent-node"

MUT_CLI="$ROOT/agent-network/bin/cli-mut-test616.ts"
sed 's/raw\.split(",")/raw.split("\\u0000")/' "$CLI" >"$MUT_CLI"
safe_rm_rf "$CLI_WORK/.anet/nodes/mutation-test"
mkdir -p "$CLI_WORK/.anet/nodes/mutation-test"
cp "$CLI_WORK/.anet/nodes/feishu-test/config.json" "$CLI_WORK/.anet/nodes/mutation-test/config.json"
(cd "$CLI_WORK" && bun "$MUT_CLI" channel add feishu mutation-test --app-id cli_dummy --app-secret dummy --allow 'ou_A,ou_B') >/tmp/test616-mut-csv.log 2>&1
MUT_ACCESS="$CLI_WORK/.anet/nodes/mutation-test/channels/feishu/access.json"
set +e
bun -e 'const a=await Bun.file(process.argv[1]).json(); process.exit(JSON.stringify(a.allowFrom)==JSON.stringify(["ou_A","ou_B"])?0:1)' "$MUT_ACCESS"
mut_csv_contract=$?
set -e
assert test "$mut_csv_contract" -ne 0
echo "WITNESSED_RED: deleting CSV split recreates the single-element allowlist defect"
rm -f "$MUT_CLI"
pass "both safety/correctness mutations are non-empty"

printf 'RESULT: PASS (%s tests, %s assertions) source=%s\n' "$PASS" "$ASSERTS" "$TEST616_SOURCE_COMMIT"
