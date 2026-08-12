#!/bin/bash
set -euo pipefail

source /lib/safe-rm.sh

SCRIPT=/app/deploy/hub/hub-daemon.sh
ROOT="/tmp/test735-$$"
trap 'safe_rm_rf "$ROOT"' EXIT

new_fixture() {
  local name="$1"
  local dir="$ROOT/$name"
  safe_rm_rf "$dir"
  mkdir -p \
    "$dir/home/.commhub/runtime-v34-preview29/node_modules/@sleep2agi/commhub-server/bin" \
    "$dir/fake-bin"
  : > "$dir/home/.commhub/runtime-v34-preview29/node_modules/@sleep2agi/commhub-server/bin/commhub.ts"
  printf 'ANET_HUB_SECRET_VAULT_KEY=test-fixture-only\n' > "$dir/hub.env"

  cat > "$dir/fake-bin/bun" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" > "$FAKE_BUN_LOG"
test "${ANET_HUB_SECRET_VAULT_KEY:-}" = test-fixture-only
EOF
  cat > "$dir/fake-bin/ss" <<'EOF'
#!/bin/bash
if [ "${FAKE_SS_OCCUPIED:-0}" = 1 ]; then
  printf 'LISTEN 0 128 0.0.0.0:%s 0.0.0.0:*\n' "$PORT"
fi
EOF
  cat > "$dir/fake-bin/sleep" <<'EOF'
#!/bin/bash
exit 0
EOF
  chmod 0755 "$dir/fake-bin/bun" "$dir/fake-bin/ss" "$dir/fake-bin/sleep"
  printf '%s\n' "$dir"
}

invoke() {
  local script="$1"
  local dir="$2"
  shift 2
  env \
    HOME="$dir/home" \
    PATH="$dir/fake-bin:/usr/bin:/bin" \
    BUN_BIN="${BUN_BIN_OVERRIDE:-$dir/fake-bin/bun}" \
    SS_BIN="${SS_BIN_OVERRIDE:-$dir/fake-bin/ss}" \
    FAKE_SS_OCCUPIED="${FAKE_SS_OCCUPIED:-0}" \
    HUB_ENV_FILE="$dir/hub.env" \
    FAKE_BUN_LOG="$dir/bun.log" \
    HOST=127.0.0.1 \
    PORT=19299 \
    COMMHUB_DB="$dir/verify.db" \
    "$@" \
    bash "$script" > "$dir/output.log" 2>&1
}

assert_success_path() {
  local script="$1"
  local dir
  dir="$(new_fixture success)"
  invoke "$script" "$dir"
  test -s "$dir/bun.log"
  grep -Fq "$dir/home/.commhub/runtime-v34-preview29/node_modules/@sleep2agi/commhub-server/bin/commhub.ts" "$dir/bun.log"
  grep -Fq '预检通过' "$dir/output.log"
  grep -Fq '监听 127.0.0.1:19299' "$dir/output.log"
}

assert_missing_secret_rejected() {
  local script="$1"
  local dir rc
  dir="$(new_fixture missing-secret)"
  : > "$dir/hub.env"
  set +e
  invoke "$script" "$dir"
  rc=$?
  set -e
  test "$rc" -ne 0
  test ! -e "$dir/bun.log"
  grep -Fq '没有非空的 ANET_HUB_SECRET_VAULT_KEY' "$dir/output.log"
}

assert_missing_runtime_rejected() {
  local script="$1"
  local dir rc
  dir="$(new_fixture missing-runtime)"
  safe_rm_rf "$dir/home/.commhub/runtime-v34-preview29"
  set +e
  invoke "$script" "$dir"
  rc=$?
  set -e
  test "$rc" -ne 0
  test ! -e "$dir/bun.log"
  grep -Fq '固化安装缺失' "$dir/output.log"
}

assert_missing_ss_rejected() {
  local script="$1"
  local dir rc
  dir="$(new_fixture missing-ss)"
  set +e
  SS_BIN_OVERRIDE="$dir/does-not-exist" invoke "$script" "$dir"
  rc=$?
  set -e
  test "$rc" -ne 0
  test ! -e "$dir/bun.log"
  grep -Fq '显式指定的 SS_BIN 不可执行' "$dir/output.log"
}

assert_occupied_port_rejected() {
  local script="$1"
  local dir rc
  dir="$(new_fixture occupied-port)"
  set +e
  FAKE_SS_OCCUPIED=1 invoke "$script" "$dir"
  rc=$?
  set -e
  test "$rc" -ne 0
  test ! -e "$dir/bun.log"
  grep -Fq '端口 19299 已被监听' "$dir/output.log"
}

assert_missing_bun_rejected() {
  local script="$1"
  local dir rc
  dir="$(new_fixture missing-bun)"
  set +e
  BUN_BIN_OVERRIDE="$dir/does-not-exist" invoke "$script" "$dir"
  rc=$?
  set -e
  test "$rc" -ne 0
  test ! -e "$dir/bun.log"
  grep -Fq '找不到 bun' "$dir/output.log"
}

assert_ecosystem_shape() {
  node - <<'EOF'
const config = require("/app/deploy/hub/ecosystem.config.cjs");
const app = config.apps?.[0];
if (!app || app.name !== "commhub-hub") process.exit(1);
if (app.script !== "/home/tester/.local/bin/hub-daemon.sh") process.exit(1);
if (app.cwd !== "/home/tester/.commhub") process.exit(1);
if (app.interpreter !== "bash" || app.exec_mode !== "fork") process.exit(1);
if (app.autorestart !== true || app.min_uptime !== 20_000 || app.max_restarts !== 20) process.exit(1);
if (app.exp_backoff_restart_delay !== 200) process.exit(1);
EOF
}

run_suite() {
  local script="$1"
  bash -n "$script"
  assert_success_path "$script"
  assert_missing_secret_rejected "$script"
  assert_missing_runtime_rejected "$script"
  assert_missing_ss_rejected "$script"
  assert_occupied_port_rejected "$script"
  assert_missing_bun_rejected "$script"
  assert_ecosystem_shape
}

run_suite "$SCRIPT"
echo 'L1 HUB_DAEMON_REBUILD_PASS'

MUTANT="$ROOT/hub-daemon-no-vault-gate.sh"
cp "$SCRIPT" "$MUTANT"
before="$(sha256sum "$MUTANT" | cut -d' ' -f1)"
sed -i "s/if ! grep -q '\^ANET_HUB_SECRET_VAULT_KEY=.\\+' \"\$ENV_FILE\"; then/if false; then/" "$MUTANT"
after="$(sha256sum "$MUTANT" | cut -d' ' -f1)"
test "$before" != "$after" || { echo 'MUTATION_NOOP vault-gate-removed'; exit 1; }

if assert_missing_secret_rejected "$MUTANT"; then
  echo 'MUTATION_SURVIVED vault-gate-removed'
  exit 1
fi
echo 'MUTATION_RED vault-gate-removed'
echo 'RESULT: PASS'
