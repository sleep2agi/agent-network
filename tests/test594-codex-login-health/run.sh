#!/usr/bin/env bash
# test594 — #594 step 1: codex nodes report a non-secret login fingerprint and
# "shared with N other nodes on this host" through the #448 health channel, and
# the Hub exposes it read-only on /api/status (full projection, health.codex_login).
#
# Real Hub + three real agent-node processes (runtime codex, never given a task,
# so no codex binary or network is needed). Every login is a clearly fake
# auth.json written into a temp HOME — the real ~/.codex is never touched.
#   alpha + beta : byte-identical copies of ONE auth.json (the #1918 failure shape)
#   gamma        : its own login (same account id, different refresh token)
# Expect alpha/beta: same fingerprint, shared_with=1 (alpha started first and
# must still learn about beta); gamma: different fingerprint, shared_with=0;
# no token string anywhere in the Hub's response.
# Witnessed red in-suite: a mutation that drops the field on the node side.
set -euo pipefail

REPO="${REPO:-/app}"
source "$REPO/tests/lib/safe-rm.sh"
WORK="${WORK:-/tmp/test594}"
PORT="${PORT:-9594}"
BASE="http://127.0.0.1:$PORT"
ADMIN="codex_login_admin"
PASSWORD="Codex-Login-Strong-1!"
PASS=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

echo "# test594 — codex login fingerprint / shared_with on /api/status"
echo "source_commit=${TEST594_SOURCE_COMMIT:-unknown}"
[[ "$PORT" != 9200 ]] || fail 'refusing the production hub port'
safe_rm_rf "$WORK"
mkdir -p "$WORK/home" "$WORK/ws/.anet/nodes"
export HOME="$WORK/home"

HUB_PID=""
declare -A NODE_PIDS=()
stop_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do [[ ! -e "/proc/$pid" ]] && return 0; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
stop_nodes() {
  local a
  for a in "${!NODE_PIDS[@]}"; do stop_group "${NODE_PIDS[$a]}"; wait "${NODE_PIDS[$a]}" 2>/dev/null || true; done
  NODE_PIDS=()
}
cleanup() {
  stop_nodes || true
  stop_group "$HUB_PID" || true
  if [[ -f "$WORK/cli.ts.orig" ]]; then cp "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts"; fi
}
trap cleanup EXIT

(cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/health" >/dev/null || { tail -50 "$WORK/hub.log"; fail 'hub boot'; }
ok 'real Hub booted on an isolated port and temp DB'

REG=$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\",\"email\":\"test594@example.invalid\"}")
UTOK=$(jq -r '.token // empty' <<<"$REG")
NET=$(jq -r '.network_id // empty' <<<"$REG")
[[ "$UTOK" == utok_* && -n "$NET" ]] || fail 'admin registration'

# Fake codex logins. The refresh-token strings are the needles for the leak check.
fake_auth() {
  printf '{"auth_mode":"chatgpt","tokens":{"id_token":"fake-id-%s","access_token":"fake-access-%s","refresh_token":"FAKE-RT-%s-must-not-leak","account_id":"acct-test594"}}\n' "$1" "$1" "$1"
}
SHARED_AUTH="$WORK/shared-auth.json"
fake_auth shared >"$SHARED_AUTH"

make_node() {
  local alias=$1 auth_src=$2
  local dir="$WORK/ws/.anet/nodes/$alias"
  mkdir -p "$dir/codex-home"
  chmod 700 "$dir/codex-home"
  cp "$auth_src" "$dir/codex-home/auth.json"
  chmod 600 "$dir/codex-home/auth.json"
  local ntok
  ntok=$(curl -fsS -X POST "$BASE/api/auth/node-token" -H "Authorization: Bearer $UTOK" \
    -H 'Content-Type: application/json' -d "{\"network_id\":\"$NET\",\"node_name\":\"$alias\"}" | jq -r '.token // empty')
  [[ "$ntok" == ntok_* ]] || fail "node token mint for $alias"
  printf '{"alias":"%s","runtime":"codex","hub":"%s","token":"%s","network_id":"%s"}\n' \
    "$alias" "$BASE" "$ntok" "$NET" >"$dir/config.json"
}
make_node alpha "$SHARED_AUTH"
make_node beta "$SHARED_AUTH"
fake_auth gamma >"$WORK/gamma-auth.json"
make_node gamma "$WORK/gamma-auth.json"
cmp -s "$WORK/ws/.anet/nodes/alpha/codex-home/auth.json" "$WORK/ws/.anet/nodes/beta/codex-home/auth.json" \
  || fail 'fixture: alpha/beta should hold byte-identical auth.json'
ok 'fixture: alpha+beta share one copied auth.json, gamma has its own'

start_node() {
  local alias=$1
  (cd "$WORK/ws" && exec setsid env HOME="$HOME" OPENAI_API_KEY= ANET_CODEX_LOGIN_CHECK_INTERVAL_MS=1000 \
    bun "$REPO/agent-node/src/cli.ts" --alias "$alias" --config "$WORK/ws/.anet/nodes/$alias/config.json" \
    >"$WORK/node-$alias.log" 2>&1) &
  NODE_PIDS[$alias]=$!
}
status_json() { curl -fsS "$BASE/api/status?network_id=$NET" -H "Authorization: Bearer $UTOK"; }
login_of() { jq -c --arg a "$1" '.sessions[]? | select(.alias==$a) | .health.codex_login // empty' <<<"$2"; }

# Wait until every predicate holds on one snapshot of /api/status.
wait_logins() {
  local tries=$1
  for _ in $(seq 1 "$tries"); do
    local s
    s=$(status_json 2>/dev/null || true)
    if [[ -n "$s" ]] \
      && jq -e '[.sessions[]? | select(.alias=="alpha" or .alias=="beta") | .health.codex_login.shared_with] == [1,1]' >/dev/null 2>&1 <<<"$s" \
      && jq -e '[.sessions[]? | select(.alias=="gamma") | .health.codex_login.shared_with] == [0]' >/dev/null 2>&1 <<<"$s"; then
      printf '%s\n' "$s"; return 0
    fi
    sleep 0.5
  done
  return 1
}

# alpha first, alone: when it registers nobody else has published yet.
start_node alpha
for _ in $(seq 1 80); do
  [[ -n "$(login_of alpha "$(status_json 2>/dev/null || echo '{}')")" ]] && break
  sleep 0.25
done
A0=$(login_of alpha "$(status_json)")
[[ -n "$A0" ]] || { tail -40 "$WORK/node-alpha.log"; fail 'alpha never reported health.codex_login'; }
jq -e '.shared_with == 0' >/dev/null <<<"$A0" || fail "alpha alone should be shared_with=0: $A0"
ok "alpha alone reports codex_login with shared_with=0"

start_node beta
start_node gamma
STATUS=$(wait_logins 120) || {
  status_json | jq -c '.sessions[] | {alias, login: .health.codex_login}' || true
  tail -30 "$WORK/node-alpha.log" "$WORK/node-beta.log" "$WORK/node-gamma.log" || true
  fail 'shared_with did not converge to alpha=1 beta=1 gamma=0'
}
A=$(login_of alpha "$STATUS"); B=$(login_of beta "$STATUS"); G=$(login_of gamma "$STATUS")
echo "alpha=$A"; echo "beta=$B"; echo "gamma=$G"
ok 'alpha (started first) learned about beta without waiting for the 3-minute heartbeat'

FA=$(jq -r .fingerprint <<<"$A"); FB=$(jq -r .fingerprint <<<"$B"); FG=$(jq -r .fingerprint <<<"$G")
[[ "$FA" =~ ^[0-9a-f]{8}$ ]] || fail "fingerprint shape: $FA"
[[ "$FA" == "$FB" ]] || fail "shared login must have one fingerprint: $FA vs $FB"
[[ "$FA" != "$FG" ]] || fail "separate login must differ: $FA vs $FG"
ok 'alpha/beta report the same 8-hex fingerprint, gamma a different one'

jq -e '.shared_home_with == 0' >/dev/null <<<"$A" || fail 'copied auth.json is not a shared CODEX_HOME directory'
jq -e --arg h "$WORK/ws/.anet/nodes/alpha/codex-home" '.codex_home == $h' >/dev/null <<<"$A" || fail "codex_home should be the node's own: $A"
ok 'shared_home_with=0 for copies; codex_home is the node'"'"'s own directory (for the fix command)'

# 🔴 No token anywhere in what the Hub serves. Positive control first: the
# needle really is in the fixture, so the negative below cannot pass vacuously.
grep -Fq 'FAKE-RT-shared-must-not-leak' "$SHARED_AUTH" || fail 'positive control: needle missing from fixture'
for needle in FAKE-RT- fake-access- fake-id-; do
  if grep -Fq "$needle" <<<"$STATUS"; then fail "token material ($needle) in /api/status"; fi
  if grep -Fq "$needle" "$WORK/hub.log"; then fail "token material ($needle) in hub log"; fi
  for a in alpha beta gamma; do
    if grep -Fq "$needle" "$WORK/node-$a.log"; then fail "token material ($needle) in node-$a log"; fi
  done
done
ok 'no refresh/access/id token in /api/status, the hub log, or any node log'

# The light projection the app list reads stays byte-shaped as before (no new key).
LIGHT=$(curl -fsS "$BASE/api/status?network_id=$NET&light=1" -H "Authorization: Bearer $UTOK")
if jq -e '[.sessions[]? | has("health")] | any' >/dev/null 2>&1 <<<"$LIGHT"; then fail 'light projection grew a health key'; fi
ok 'light projection unchanged (no codex_login there)'

stop_nodes

echo "-- witnessed red: drop the field on the node side, same scenario must fail"
cp "$REPO/agent-node/src/cli.ts" "$WORK/cli.ts.orig"
ANCHOR='return { ...(base ?? {}), codex_login: login };'
grep -Fq "$ANCHOR" "$REPO/agent-node/src/cli.ts" || fail 'MUTATION_ANCHOR_MISSING'
sed -i 's/return { ...(base ?? {}), codex_login: login };/return base;/' "$REPO/agent-node/src/cli.ts"
if grep -Fq "$ANCHOR" "$REPO/agent-node/src/cli.ts"; then fail 'MUTATION_NOOP'; fi
# Fresh Hub memory for these aliases: health is memory-only with a 10-minute TTL,
# so restart the Hub rather than read the previous run's values.
stop_group "$HUB_PID"; wait "$HUB_PID" 2>/dev/null || true
(cd "$REPO/server" && exec setsid env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" bun run src/index.ts >"$WORK/hub2.log" 2>&1) &
HUB_PID=$!
for _ in $(seq 1 80); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.25; done
start_node alpha; start_node beta; start_node gamma
set +e
wait_logins 30 >/dev/null
MUT_RC=$?
set -e
stop_nodes
cp "$WORK/cli.ts.orig" "$REPO/agent-node/src/cli.ts"
rm -f "$WORK/cli.ts.orig"
[[ "$MUT_RC" -ne 0 ]] || fail 'mutation stayed green — the suite does not observe the field'
ok 'witnessed red: without the node-side field the same scenario fails'

(cd "$REPO/agent-node" && bun test src/codex-login-health.test.ts src/codex-auth-fingerprint.test.ts)
ok 'agent-node unit: fingerprint/shared_with/leak checks'
(cd "$REPO/server" && COMMHUB_DB="$WORK/unit.db" bun test src/node-health-codex-login.test.ts src/node-health-passthrough.test.ts)
ok 'server unit: codex_login passthrough + shape guard'

printf 'source_commit=%s\n' "${TEST594_SOURCE_COMMIT:-unknown}"
printf 'RESULT: PASS (%s checks)\n' "$PASS"
