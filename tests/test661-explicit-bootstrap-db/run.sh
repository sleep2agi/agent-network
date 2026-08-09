#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
ART=/artifacts
PASS=0
FAIL=0
mkdir -p "$ART"
source "$ROOT/tests/lib/safe-rm.sh"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then bad "mutation $name stayed green"; else ok "mutation $name witnessed red"; fi
}

run_cli_e2e(){
  local case_root home explicit_db decoy_db ready capture fixture_pid rc
  local explicit_value decoy_value captured_path first_arg
  case_root=$(mktemp -d /tmp/test661-e2e.XXXXXX)
  home="$case_root/home"
  explicit_db="$case_root/explicit/hub.db"
  decoy_db="$home/.commhub/commhub.db"
  ready="$case_root/ready"
  capture="$case_root/capture"
  mkdir -p "$home"
  /usr/local/bin/bun "$ROOT/tests/test661-explicit-bootstrap-db/db-tool.ts" seed "$explicit_db" || return 1
  /usr/local/bin/bun "$ROOT/tests/test661-explicit-bootstrap-db/db-tool.ts" seed "$decoy_db" || return 1

  TEST661_PORT=25661 TEST661_READY_FILE="$ready" \
    /usr/local/bin/bun "$ROOT/tests/test661-explicit-bootstrap-db/fixture-server.ts" \
    >"$case_root/server.log" 2>&1 &
  fixture_pid=$!
  for _ in $(seq 1 50); do [[ -s "$ready" ]] && break; sleep 0.05; done
  if [[ ! -s "$ready" ]]; then kill "$fixture_pid" 2>/dev/null || true; return 1; fi

  set +e
  HOME="$home" COMMHUB_DB="$explicit_db" TEST661_CAPTURE="$capture" \
    PATH="$ROOT/tests/test661-explicit-bootstrap-db/fake-bin:$PATH" \
    /usr/local/bin/bun "$ROOT/agent-network/bin/cli.ts" hub start --port 25661 \
    >"$case_root/cli.log" 2>&1
  rc=$?
  set -e
  kill "$fixture_pid" 2>/dev/null || true
  wait "$fixture_pid" 2>/dev/null || true
  explicit_value=$(/usr/local/bin/bun "$ROOT/tests/test661-explicit-bootstrap-db/db-tool.ts" read "$explicit_db") || return 1
  decoy_value=$(/usr/local/bin/bun "$ROOT/tests/test661-explicit-bootstrap-db/db-tool.ts" read "$decoy_db") || return 1
  captured_path=$(cat "$capture.path" 2>/dev/null || true)
  first_arg=$(sed -n '1p' "$capture.argv" 2>/dev/null || true)
  if [[ "$rc" -ne 0 || "$explicit_value" != 1 || "$decoy_value" != 0 \
    || "$captured_path" != "$explicit_db" || "$first_arg" != "-e" ]]; then
    printf 'E2E mismatch rc=%s explicit=%s decoy=%s captured_path=%s first_arg=%s\n' \
      "$rc" "$explicit_value" "$decoy_value" "$captured_path" "$first_arg" >&2
    safe_rm_rf "$case_root"
    return 1
  fi
  safe_rm_rf "$case_root"
}

printf 'source_commit=%s\n' "${TEST661_SOURCE_COMMIT:-unknown}"
cd "$ROOT"

bun test agent-network/src/bootstrap-password-db.test.ts
ok "explicit bootstrap database unit + real SQLite subprocess"
run_cli_e2e
ok "real anet hub start bootstrap updates only explicit database"

(
  cd agent-network
  bun run build
)
ok "agent-network production build"

cp agent-network/src/bootstrap-password-db.ts /tmp/test661-bootstrap-db.orig
cp agent-network/bin/cli.ts /tmp/test661-cli.orig

sed -i 's@const dbPath = process.env.ANET_BOOTSTRAP_DB_PATH;@const dbPath = process.env.ANET_BOOTSTRAP_DB_PATH || (process.env.HOME + "/.commhub/commhub.db");@' \
  agent-network/src/bootstrap-password-db.ts
grep -Fq 'process.env.HOME + "/.commhub/commhub.db"' agent-network/src/bootstrap-password-db.ts
expect_red child-restores-home-fallback bun test agent-network/src/bootstrap-password-db.test.ts
cp /tmp/test661-bootstrap-db.orig agent-network/src/bootstrap-password-db.ts

[[ "$(grep -Fc 'DATABASE_URL ||' agent-network/src/bootstrap-password-db.ts)" -eq 1 ]]
sed -i '/DATABASE_URL ||/c\  if (false) {' agent-network/src/bootstrap-password-db.ts
grep -Fq 'if (false) {' agent-network/src/bootstrap-password-db.ts
expect_red postgres-invents-sqlite bun test agent-network/src/bootstrap-password-db.test.ts
cp /tmp/test661-bootstrap-db.orig agent-network/src/bootstrap-password-db.ts

sed -i 's/const dbPath = resolveBootstrapDatabasePath(process.env, home, process.cwd());/const dbPath = join(home, ".commhub", "commhub.db");/' \
  agent-network/bin/cli.ts
grep -Fq 'const dbPath = join(home, ".commhub", "commhub.db");' agent-network/bin/cli.ts
expect_red cli-bypasses-explicit-selection run_cli_e2e
cp /tmp/test661-cli.orig agent-network/bin/cli.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
