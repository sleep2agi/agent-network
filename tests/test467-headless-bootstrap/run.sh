#!/usr/bin/env bash
set -euo pipefail

source /workspace/tests/lib/safe-rm.sh

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test467-headless-bootstrap.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test467 — headless bootstrap and explicit hub precedence"
echo "source_commit=${TEST467_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

echo "L0 typecheck agent-network"
(cd /workspace/agent-network && bun run typecheck)

HOME_DIR=$(mktemp -d /tmp/test467-home.XXXXXX)
PROJECT_DIR=$(mktemp -d /tmp/test467-project.XXXXXX)
DB_PATH=$(mktemp /tmp/test467-db.XXXXXX.sqlite)
FAKE_BIN=$(mktemp -d /tmp/test467-bin.XXXXXX)
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; fi
  safe_rm_rf "$HOME_DIR" "$PROJECT_DIR" "$FAKE_BIN"
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
}
trap cleanup EXIT

BASE=http://127.0.0.1:9467
ANET=(bun run /workspace/agent-network/bin/cli.ts)

echo "L1 start real Hub with fresh SQLite"
(
  cd /workspace/server
  PORT=9467 HOST=127.0.0.1 COMMHUB_DB="$DB_PATH" COMMHUB_AUTH_TOKEN=test467-auth \
    bun run src/index.ts
) >/tmp/test467-hub.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 80); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$BASE/health" >/dev/null

echo "L2 register --hub overrides stale config without a TTY"
mkdir -p "$HOME_DIR/.anet"
printf '%s\n' '{"hub":"http://127.0.0.1:1"}' > "$HOME_DIR/.anet/config.json"
set +e
REGISTER_OUT=$(HOME="$HOME_DIR" "${ANET[@]}" register \
  --hub "$BASE" --token test467-auth \
  --username bootstrap467 --password Bootstrap467! 2>&1)
REGISTER_RC=$?
set -e
echo "$REGISTER_OUT"
[[ "$REGISTER_RC" -eq 0 ]] || { echo "FAIL_REGISTER_EXPLICIT_HUB"; exit 1; }
grep -Fq 'Registered and logged in as bootstrap467' <<<"$REGISTER_OUT" || {
  echo "FAIL_REGISTER_EXPLICIT_HUB"
  exit 1
}
jq -e --arg hub "$BASE" '.hub == $hub and (.token | startswith("utok_")) and (.network_id | startswith("net_"))' \
  "$HOME_DIR/.anet/config.json" >/dev/null || { echo "FAIL_REGISTER_PERSISTED_BOOTSTRAP"; exit 1; }

echo "L3 missing network_id auto-recovers only a unique writable network"
FIRST_NETWORK=$(jq -r '.network_id' "$HOME_DIR/.anet/config.json")
jq 'del(.network_id, .network_name)' "$HOME_DIR/.anet/config.json" > /tmp/test467-config.json
mv /tmp/test467-config.json "$HOME_DIR/.anet/config.json"
chmod 0600 "$HOME_DIR/.anet/config.json"
set +e
(
  cd "$PROJECT_DIR"
  HOME="$HOME_DIR" "${ANET[@]}" node create unique-net-node --runtime codex-sdk \
    >/tmp/test467-unique-create.log 2>&1
)
UNIQUE_CREATE_RC=$?
set -e
cat /tmp/test467-unique-create.log
[[ "$UNIQUE_CREATE_RC" -eq 0 ]] || { echo "FAIL_UNIQUE_NETWORK_HEADLESS_RECOVERY"; exit 1; }
echo "global config after unique recovery:"
jq '{hub,network_id,network_name}' "$HOME_DIR/.anet/config.json"
jq -e --arg network "$FIRST_NETWORK" '.network_id == $network' "$HOME_DIR/.anet/config.json" >/dev/null \
  || { echo "FAIL_UNIQUE_NETWORK_HEADLESS_RECOVERY"; exit 1; }
UNIQUE_CFG=$(find "$PROJECT_DIR/.anet/nodes" -name config.json -type f -print -quit)
echo "unique node config: $UNIQUE_CFG"
jq '{node_name,network_id,token_prefix:(.token[0:5])}' "$UNIQUE_CFG"
jq -e '.token | startswith("ntok_")' "$UNIQUE_CFG" >/dev/null

set +e
HOME="$HOME_DIR" "${ANET[@]}" network create second-network >/tmp/test467-second-network.log 2>&1
SECOND_NETWORK_RC=$?
set -e
cat /tmp/test467-second-network.log
[[ "$SECOND_NETWORK_RC" -eq 0 ]]
jq 'del(.network_id, .network_name)' "$HOME_DIR/.anet/config.json" > /tmp/test467-config.json
mv /tmp/test467-config.json "$HOME_DIR/.anet/config.json"
chmod 0600 "$HOME_DIR/.anet/config.json"
set +e
(
  cd "$PROJECT_DIR"
  HOME="$HOME_DIR" "${ANET[@]}" node create ambiguous-net-node --runtime codex-sdk
) >/tmp/test467-ambiguous-create.log 2>&1
AMBIGUOUS_RC=$?
set -e
cat /tmp/test467-ambiguous-create.log
[[ "$AMBIGUOUS_RC" -ne 0 ]]
grep -Fq 'anet network use <name>' /tmp/test467-ambiguous-create.log
if find "$PROJECT_DIR/.anet/nodes" -name config.json -type f -exec grep -l 'ambiguous-net-node' {} + | grep -q .; then
  echo "FAIL: ambiguous network selection wrote a node config"
  exit 1
fi

echo "L4 node start --hub overrides stale global/profile hub in the spawned process"
jq --arg hub 'http://127.0.0.1:1' --arg network "$FIRST_NETWORK" \
  '.hub=$hub | .network_id=$network' "$HOME_DIR/.anet/config.json" > /tmp/test467-config.json
mv /tmp/test467-config.json "$HOME_DIR/.anet/config.json"
chmod 0600 "$HOME_DIR/.anet/config.json"
jq --arg hub 'http://127.0.0.1:1' '.hub=$hub' "$UNIQUE_CFG" > /tmp/test467-node-config.json
mv /tmp/test467-node-config.json "$UNIQUE_CFG"
chmod 0600 "$UNIQUE_CFG"
cat > "$FAKE_BIN/npx" <<'SH'
#!/usr/bin/env bash
printf 'COMMHUB_URL=%s\n' "${COMMHUB_URL:-}" > /tmp/test467-spawn-env.log
exit 0
SH
chmod 0755 "$FAKE_BIN/npx"
(
  cd "$PROJECT_DIR"
  PATH="$FAKE_BIN:$PATH" HOME="$HOME_DIR" \
    "${ANET[@]}" node start unique-net-node --hub "$BASE" \
    >/tmp/test467-start.log 2>&1
)
cat /tmp/test467-start.log
grep -Fxq "COMMHUB_URL=$BASE" /tmp/test467-spawn-env.log || {
  echo "FAIL_START_EXPLICIT_HUB"
  cat /tmp/test467-spawn-env.log
  exit 1
}

if [[ "${TEST467_SKIP_MUTATIONS:-0}" != "1" ]]; then
  echo "L5 witnessed-red mutations"
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" >/dev/null 2>&1 || true
  SERVER_PID=""
  CLI=/workspace/agent-network/bin/cli.ts
  cp "$CLI" /tmp/test467-cli.original.ts

  expect_mutation_red() {
    local name=$1
    local expected=$2
    local mutation_dir="/tmp/test467-mutation-$name"
    safe_rm_rf "$mutation_dir"
    mkdir -p "$mutation_dir"
    set +e
    TEST467_SKIP_MUTATIONS=1 ARTIFACT_DIR="$mutation_dir" "$0" >"$mutation_dir/runner.log" 2>&1
    local rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
      echo "MUTATION_FALSE_GREEN: $name"
      exit 1
    fi
    grep -Fq "$expected" "$mutation_dir/runner.log" || {
      echo "MUTATION_WRONG_RED: $name (expected stage: $expected)"
      tail -80 "$mutation_dir/runner.log"
      exit 1
    }
    echo "MUTATION_RED: $name rc=$rc"
    cp /tmp/test467-cli.original.ts "$CLI"
  }

  sed -i 's/let hub = opts\.hub || gc\.hub;/let hub = gc.hub;/' "$CLI"
  grep -Fq 'let hub = gc.hub;' "$CLI"
  expect_mutation_red register-explicit-hub 'FAIL_REGISTER_EXPLICIT_HUB'

  sed -i 's/if (!opts\.network && gc\.token && gc\.hub) {/if (!opts.network \&\& gc.token \&\& gc.hub \&\& process.stdin.isTTY) {/' "$CLI"
  grep -Fq 'gc.hub && process.stdin.isTTY' "$CLI"
  expect_mutation_red unique-network-headless-recovery 'FAIL_UNIQUE_NETWORK_HEADLESS_RECOVERY'

  sed -i 's/if (hubOverride) profile = { \.\.\.profile, hub: hubOverride };/if (false \&\& hubOverride) profile = { ...profile, hub: hubOverride };/' "$CLI"
  grep -Fq 'if (false && hubOverride)' "$CLI"
  expect_mutation_red start-explicit-hub 'FAIL_START_EXPLICIT_HUB'

  cmp -s "$CLI" /tmp/test467-cli.original.ts || {
    echo "FAIL: production source was not restored after mutations"
    exit 1
  }
fi

echo "RESULT: PASS"
