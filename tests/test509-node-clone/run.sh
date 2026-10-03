#!/usr/bin/env bash
# test509 — `anet node clone` / `anet node create --from` against a real, throwaway Hub.
#
# What the unit tests (agent-network/src/node-clone.test.ts) cannot show and this does:
#   - the clone is registered with a REAL Hub as a second node: two distinct node_id rows,
#     two distinct ntok_ — not one identity held twice (which is what `cp -r` of a node dir gives)
#   - nothing of the source's token / secret value lands anywhere in the clone's directory
#   - `create <new> --from <src>` produces the same kind of node as `clone` (it used to ignore --from)
#   - refusals exit non-zero and register nothing
#   - mutation: making the planner copy `token` turns the unit suite red
#
# Everything runs inside the container: HOME=$(mktemp -d), hub on a random non-9200 port.
set -euo pipefail

if [[ ! -f /.dockerenv && "${ALLOW_NON_DOCKER:-}" != "1" ]]; then
  echo "REFUSING: /.dockerenv absent — this suite boots a hub; run it in its container." >&2
  exit 2
fi

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
mkdir -p "$ARTIFACT_DIR"
REPORT="$ARTIFACT_DIR/report-test509-node-clone.txt"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test509 — node clone"
echo "source_commit=${TEST509_SOURCE_COMMIT:-unknown}"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" && "${TEST509_SOURCE_COMMIT:-}" != "$EXPECTED_SOURCE_COMMIT" ]]; then
  echo "FAIL: source provenance mismatch image=${TEST509_SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"
  exit 1
fi

PASS=0
pass() { PASS=$((PASS + 1)); echo "  ok  $*"; }
fail() { echo "  FAIL $*"; exit 1; }

ROOT=/workspace
ANET=(bun "$ROOT/agent-network/bin/cli.ts")

echo "L0 unit suite"
(cd "$ROOT/agent-network" && bun test src/node-clone.test.ts) >/tmp/t509-unit.log 2>&1 || { cat /tmp/t509-unit.log; fail "unit suite red on a clean tree"; }
pass "node-clone unit suite green"

echo "L1 throwaway hub + login"
export HOME
HOME=$(mktemp -d /tmp/t509-home-XXXXXX)
export COMMHUB_DB
COMMHUB_DB=$(mktemp -u /tmp/t509-hub-XXXXXX.db)
export PORT
PORT=$(( 20000 + RANDOM % 20000 ))
[[ "$PORT" != 9200 ]] || PORT=29201
HUB="http://127.0.0.1:$PORT"
bun run "$ROOT/server/src/index.ts" >/tmp/t509-hub.log 2>&1 &
hub_pid=$!
trap 'kill "$hub_pid" 2>/dev/null || true' EXIT
up=0
for _ in $(seq 1 100); do
  if curl -fsS "$HUB/health" >/dev/null 2>&1; then up=1; break; fi
  sleep 0.1
done
[[ "$up" -eq 1 ]] || { cat /tmp/t509-hub.log; fail "hub did not come up on $PORT"; }
reg=$(curl -fsS -X POST "$HUB/api/auth/register" -H 'Content-Type: application/json' -d '{"username":"admin","password":"t509_TestPass_1!"}')
printf '%s' "$reg" | grep -Fq '"ok":true' || fail "register: $reg"
"${ANET[@]}" login --hub "$HUB" --username admin --password 't509_TestPass_1!' >/tmp/t509-login.log 2>&1 || { cat /tmp/t509-login.log; fail "anet login"; }
pass "hub on :$PORT, logged in"

PROJ=$(mktemp -d /tmp/t509-proj-XXXXXX)
cd "$PROJ"
SECRET="t509-vendor-secret-not-real"
ANTHROPIC_AUTH_TOKEN="$SECRET" ANTHROPIC_BASE_URL=https://vendor.invalid \
  "${ANET[@]}" node create alpha --runtime claude-agent-sdk --model t509-model >/tmp/t509-create.log 2>&1 \
  || { cat /tmp/t509-create.log; fail "create alpha"; }
A_CFG=.anet/nodes/alpha/config.json
[[ -f "$A_CFG" ]] || fail "alpha config missing"
grep -Fq "$SECRET" .anet/nodes/alpha/.env || fail "positive control: alpha's .env should hold the secret"
printf '# alpha rules\n' > CLAUDE.md
mkdir -p .claude/skills/demo && printf -- '---\nname: demo\n---\n' > .claude/skills/demo/SKILL.md
pass "created alpha"

echo "L2 clone alpha → beta"
"${ANET[@]}" node clone alpha beta >/tmp/t509-clone.log 2>&1 || { cat /tmp/t509-clone.log; fail "clone alpha beta"; }
cat /tmp/t509-clone.log
B_CFG=.anet/nodes/beta/config.json
[[ -f "$B_CFG" ]] || fail "beta config missing"
bun -e '
  const a = await Bun.file(process.argv[1]).json();
  const b = await Bun.file(process.argv[2]).json();
  const bad = [];
  if (!a.node_id || !b.node_id || a.node_id === b.node_id) bad.push("node_id not distinct");
  if (!String(b.token).startsWith("ntok_")) bad.push("beta has no ntok_");
  if (a.token === b.token) bad.push("beta carries alpha token");
  if (b.node_name !== "beta") bad.push("beta node_name");
  if (b.runtime !== a.runtime || b.model !== a.model) bad.push("runtime/model not copied");
  if (JSON.stringify(b.flags) !== JSON.stringify(a.flags)) bad.push("flags not copied");
  if (b.env?.ANTHROPIC_BASE_URL !== "https://vendor.invalid") bad.push("plain env not copied");
  const ref = b.env?.ANTHROPIC_AUTH_TOKEN?._envRef;
  if (typeof ref !== "string" || ref === a.env?.ANTHROPIC_AUTH_TOKEN?._envRef) bad.push("secret env not re-pointed to a new envRef");
  if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
' "$A_CFG" "$B_CFG" || fail "beta identity/settings"
pass "beta: distinct node_id + ntok_, settings copied, secret re-pointed"

A_TOKEN=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).token)' "$A_CFG")
[[ "$A_TOKEN" == ntok_* ]] || fail "alpha token shape"
if grep -rFq "$A_TOKEN" .anet/nodes/beta; then fail "alpha's token found under beta"; fi
if grep -rFq "$SECRET" .anet/nodes/beta; then fail "alpha's secret value found under beta"; fi
[[ ! -e .anet/nodes/beta/.env ]] || fail "beta has a .env (secret values copied)"
grep -rFq "$A_TOKEN" .anet/nodes/alpha || fail "positive control: alpha token not found under alpha"
pass "no alpha token / secret value under beta (positive control on alpha)"

grep -Fq "copied (" /tmp/t509-clone.log && grep -Fq "regenerated (" /tmp/t509-clone.log && grep -Fq "skipped (" /tmp/t509-clone.log || fail "summary table missing a section"
if grep -Fq "$A_TOKEN" /tmp/t509-clone.log || grep -Fq "$SECRET" /tmp/t509-clone.log; then fail "summary printed a secret"; fi
pass "summary table printed, no secrets in it"

echo "L3 Hub has two distinct identities"
rows=$(bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.argv[1], { readonly: true });
  for (const r of db.query("SELECT node_id, node_name FROM nodes ORDER BY node_name").all()) console.log(`${r.node_name} ${r.node_id}`);
' "$COMMHUB_DB")
echo "$rows"
A_ID=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).node_id)' "$A_CFG")
B_ID=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).node_id)' "$B_CFG")
printf '%s\n' "$rows" | grep -Fxq "alpha $A_ID" || fail "hub has no row for alpha $A_ID"
printf '%s\n' "$rows" | grep -Fxq "beta $B_ID" || fail "hub has no row for beta $B_ID"
[[ "$A_ID" != "$B_ID" ]] || fail "same node_id"
pass "hub rows: alpha=$A_ID beta=$B_ID"

echo "L4 create --from parity"
"${ANET[@]}" node create gamma --from alpha >/tmp/t509-from.log 2>&1 || { cat /tmp/t509-from.log; fail "create gamma --from alpha"; }
bun -e '
  const a = await Bun.file(process.argv[1]).json();
  const g = await Bun.file(process.argv[2]).json();
  if (g.node_id === a.node_id || g.token === a.token || g.model !== a.model || g.runtime !== a.runtime) process.exit(1);
' "$A_CFG" .anet/nodes/gamma/config.json || fail "gamma is not a clone of alpha"
pass "create gamma --from alpha == clone (distinct identity, same model/runtime)"

echo "L5 --workdir copies rules + skills"
WD="$HOME/beta-two"
"${ANET[@]}" node clone alpha delta --workdir "$WD" >/tmp/t509-wd.log 2>&1 || { cat /tmp/t509-wd.log; fail "clone --workdir"; }
[[ -f "$WD/.anet/nodes/delta/config.json" ]] || fail "delta config not under --workdir"
cmp -s CLAUDE.md "$WD/CLAUDE.md" || fail "rules file not copied"
[[ -f "$WD/.claude/skills/demo/SKILL.md" ]] || fail "skills not copied"
pass "delta in $WD with rules file + skills"

echo "L6 refusals (non-zero, nothing registered)"
before=$(bun -e 'import { Database } from "bun:sqlite"; console.log(new Database(process.argv[1], { readonly: true }).query("SELECT COUNT(*) AS n FROM nodes").get().n)' "$COMMHUB_DB")
refuse() {
  local label=$1 needle=$2; shift 2
  local out rc=0
  out=$("${ANET[@]}" "$@" 2>&1) || rc=$?
  [[ "$rc" -ne 0 ]] || fail "$label: exited 0"
  grep -Fq -- "$needle" <<<"$out" || { echo "$out"; fail "$label: missing '$needle'"; }
  pass "$label (rc=$rc)"
}
refuse "destination exists"   "already exists"      node clone alpha beta
refuse "same name"            "already exists"      node clone alpha alpha
refuse "non-ASCII --workdir"  "ASCII"               node clone alpha eps --workdir "$HOME/吉他大师"
refuse "into source dir"      "own directory"       node clone alpha zeta --workdir "$PROJ/.anet/nodes/alpha"
refuse "create-only flag"     "--runtime"           node clone alpha eta --runtime codex-sdk
refuse "unknown source"       "not found"           node clone nosuch theta
after=$(bun -e 'import { Database } from "bun:sqlite"; console.log(new Database(process.argv[1], { readonly: true }).query("SELECT COUNT(*) AS n FROM nodes").get().n)' "$COMMHUB_DB")
[[ "$before" == "$after" ]] || fail "refusals registered nodes ($before → $after)"
[[ ! -e "$HOME/吉他大师" ]] || fail "non-ASCII workdir was created"
pass "no hub rows added by refusals ($after)"

echo "L7 mutation: planner copies token → unit suite must go red"
SRC="$ROOT/agent-network/src/node-clone.ts"
cp "$SRC" /tmp/t509-node-clone.orig
target='  "anet_version", "runtime", "model",'
[[ "$(grep -Fc "$target" "$SRC")" -eq 1 ]] || fail "mutation anchor not found exactly once"
sed -i 's/  "anet_version", "runtime", "model",/  "anet_version", "token", "runtime", "model",/' "$SRC"
grep -Fq '"anet_version", "token", "runtime"' "$SRC" || fail "mutation did not apply"
mrc=0
(cd "$ROOT/agent-network" && bun test src/node-clone.test.ts) >/tmp/t509-mut.log 2>&1 || mrc=$?
cp /tmp/t509-node-clone.orig "$SRC"
[[ "$mrc" -ne 0 ]] || fail "MUTATION_FALSE_GREEN: token copied but unit suite stayed green"
grep -Fq "identity fields differ" /tmp/t509-mut.log || fail "mutation red for an unexpected reason"
echo "MUTATION_RED rc=$mrc"
(cd "$ROOT/agent-network" && bun test src/node-clone.test.ts) >/tmp/t509-unit2.log 2>&1 || fail "unit suite not green after restore"
pass "mutation red, restore green"

echo "RESULT: PASS ($PASS checks)"
