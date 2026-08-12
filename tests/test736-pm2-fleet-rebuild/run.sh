#!/usr/bin/env bash
set -euo pipefail

source /lib/safe-rm.sh

SCRIPT=/app/deploy/fleet/pm2-fleet-boot.sh
UNIT=/app/deploy/fleet/pm2-fleet.service
INVENTORY=/app/deploy/fleet/process-inventory.json
PM2_BIN=/home/vansin/.nvm/versions/node/v20.20.0/bin/pm2
ROOT="/tmp/test736-$$"
trap 'safe_rm_rf "$ROOT"' EXIT

install_fake_pm2() {
  cat > "$PM2_BIN" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  jlist)
    case "${FAKE_PM2_JLIST_MODE:-valid}" in
      error) exit 9 ;;
      malformed) printf '{not-json\n' ;;
      valid)
        if [ "${FAKE_PM2_COUNT:-0}" -gt 0 ]; then
          printf '[{"name":"existing"}]\n'
        else
          printf '[]\n'
        fi
        ;;
      *) exit 10 ;;
    esac
    ;;
  resurrect)
    printf 'resurrect\n' >> "$FAKE_PM2_LOG"
    ;;
  list)
    printf 'fake list\n'
    ;;
  *) exit 2 ;;
esac
EOF
  chmod 0755 "$PM2_BIN"
}

fixture() {
  local name="$1"
  local dir="$ROOT/$name"
  safe_rm_rf "$dir"
  mkdir -p "$dir/pm2"
  printf '%s\n' "$dir"
}

invoke() {
  local script="$1"
  local dir="$2"
  shift 2
  env \
    HOME=/home/vansin \
    PM2_HOME="$dir/pm2" \
    FAKE_PM2_LOG="$dir/pm2.log" \
    FAKE_PM2_COUNT="${FAKE_PM2_COUNT:-0}" \
    FAKE_PM2_JLIST_MODE="${FAKE_PM2_JLIST_MODE:-valid}" \
    "$@" \
    bash "$script" > "$dir/output.log" 2>&1
}

assert_existing_processes_noop() {
  local script="$1" dir
  dir="$(fixture existing)"
  printf '[]\n' > "$dir/pm2/dump.pm2"
  FAKE_PM2_COUNT=1 invoke "$script" "$dir"
  test ! -e "$dir/pm2.log"
  grep -Fq '已有 1 个进程在跑' "$dir/output.log"
}

assert_missing_dump_fails() {
  local script="$1" dir rc
  dir="$(fixture missing-dump)"
  set +e
  invoke "$script" "$dir"
  rc=$?
  set -e
  test "$rc" -ne 0
  test ! -e "$dir/pm2.log"
  grep -Fq '恢复不出任何东西' "$dir/output.log"
}

assert_empty_pm2_resurrects_once() {
  local script="$1" dir
  dir="$(fixture resurrect)"
  printf '[]\n' > "$dir/pm2/dump.pm2"
  invoke "$script" "$dir"
  test "$(wc -l < "$dir/pm2.log")" -eq 1
  grep -Fxq 'resurrect' "$dir/pm2.log"
  grep -Fq 'resurrect 退出码 0' "$dir/output.log"
}

assert_jlist_error_rejected() {
  local script="$1" dir rc
  dir="$(fixture jlist-error)"
  printf '[]\n' > "$dir/pm2/dump.pm2"
  set +e
  FAKE_PM2_JLIST_MODE=error invoke "$script" "$dir"
  rc=$?
  set -e
  test "$rc" -ne 0
  test ! -e "$dir/pm2.log"
  grep -Fq '无法确认现有进程数；拒绝 resurrect' "$dir/output.log"
}

assert_malformed_jlist_rejected() {
  local script="$1" dir rc
  dir="$(fixture malformed-jlist)"
  printf '[]\n' > "$dir/pm2/dump.pm2"
  set +e
  FAKE_PM2_JLIST_MODE=malformed invoke "$script" "$dir"
  rc=$?
  set -e
  test "$rc" -ne 0
  test ! -e "$dir/pm2.log"
  grep -Fq '无法解析的进程清单；拒绝 resurrect' "$dir/output.log"
}

assert_unit_shape() {
  grep -Fxq 'Type=oneshot' "$UNIT"
  grep -Fxq 'RemainAfterExit=yes' "$UNIT"
  grep -Fxq 'ExecStart=%h/.local/bin/pm2-fleet-boot.sh' "$UNIT"
  grep -Fxq 'After=basic.target' "$UNIT"
  if grep -Eq '^(ExecStop|Wants=network-online.target|After=network-online.target)' "$UNIT"; then
    echo 'UNSAFE_SYSTEMD_SHAPE'
    return 1
  fi
}

assert_inventory_boundary() {
  jq -e '.schema_version == 1 and (.apps | length) == 5' "$INVENTORY" >/dev/null
  jq -e '[.apps[] | select(.kind == "external-service" and .authority == null)] | length == 2' "$INVENTORY" >/dev/null
  jq -e '[.apps[] | select(.recovery_status | startswith("not-covered"))] | length == 2' "$INVENTORY" >/dev/null
  jq -e '[paths(scalars) as $p | ($p[-1] | tostring) | select(test("token|secret|password"; "i"))] | length == 0' "$INVENTORY" >/dev/null
}

run_suite() {
  local script="$1"
  bash -n "$script"
  assert_existing_processes_noop "$script"
  assert_missing_dump_fails "$script"
  assert_empty_pm2_resurrects_once "$script"
  assert_jlist_error_rejected "$script"
  assert_malformed_jlist_rejected "$script"
  assert_unit_shape
  assert_inventory_boundary
}

install_fake_pm2
run_suite "$SCRIPT"
echo 'L1 PM2_FLEET_REBUILD_PASS'

MUTANT="$ROOT/pm2-fleet-resurrects-live-fleet.sh"
cp "$SCRIPT" "$MUTANT"
before="$(sha256sum "$MUTANT" | cut -d' ' -f1)"
sed -i 's/if \[ "$n" -gt 0 \] 2>\/dev\/null; then/if false; then/' "$MUTANT"
after="$(sha256sum "$MUTANT" | cut -d' ' -f1)"
test "$before" != "$after" || { echo 'MUTATION_NOOP live-fleet-noop-removed'; exit 1; }

if assert_existing_processes_noop "$MUTANT"; then
  echo 'MUTATION_SURVIVED live-fleet-noop-removed'
  exit 1
fi
echo 'MUTATION_RED live-fleet-noop-removed'

MUTANT_PARSE="$ROOT/pm2-fleet-malformed-as-empty.sh"
cp "$SCRIPT" "$MUTANT_PARSE"
before="$(sha256sum "$MUTANT_PARSE" | cut -d' ' -f1)"
sed -i 's/catch{process.exit(2)}/catch{process.stdout.write("0")}/' "$MUTANT_PARSE"
after="$(sha256sum "$MUTANT_PARSE" | cut -d' ' -f1)"
test "$before" != "$after" || { echo 'MUTATION_NOOP malformed-jlist-as-empty'; exit 1; }

if assert_malformed_jlist_rejected "$MUTANT_PARSE"; then
  echo 'MUTATION_SURVIVED malformed-jlist-as-empty'
  exit 1
fi
echo 'MUTATION_RED malformed-jlist-as-empty'
echo 'RESULT: PASS'
