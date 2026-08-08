#!/usr/bin/env bash
set -euo pipefail
source /workspace/tests/lib/safe-rm.sh

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test598-codex-copresence-normalizer.txt"
mkdir -p "$ARTIFACT_DIR"; : >"$REPORT"; exec > >(tee -a "$REPORT") 2>&1
ROOT=/tmp/test598; INV=$ROOT/inventory; GOALS=$ROOT/goals; WORK=$ROOT/work
safe_rm_rf "$ROOT"; mkdir -p "$INV" "$WORK"; chmod 0700 "$INV" "$WORK"
SCRIPT=/workspace/scripts/normalize-codex-copresence-node.sh
CFGTOOL=/workspace/scripts/codex-copresence-fleet-config.mjs
echo "# test598 — Codex co-presence single-node normalizer"
echo "source_commit=${TEST598_SOURCE_COMMIT:-unknown}"

expect_red() {
  local label=$1; shift; set +e; "$@" >/tmp/test598-red.log 2>&1; rc=$?; set -e
  if [[ $rc -eq 0 ]]; then echo "FALSE_GREEN: $label"; cat /tmp/test598-red.log; exit 1; fi
  echo "WITNESSED_RED: $label rc=$rc"
}
must_reject() {
  "$@" >/tmp/test598-must-reject.log 2>&1; local rc=$?
  [[ $rc -ne 0 ]]
}
write_cfg() {
  local path=$1 node=$2 port=$3 model=${4:-gpt-5.6-sol}
  printf '{"node_id":"%s","runtime":"codex-app-server","token":"ntok_TEST_ONLY","hub":"http://127.0.0.1:19999","model":"%s","codexAppServerUrl":"ws://127.0.0.1:%s"}\n' "$node" "$model" "$port" >"$path"
  chmod 0600 "$path"
}
write_cfg "$INV/alpha-bridge-config.json" n_alpha 25981
write_cfg "$INV/beta-bridge-config.json" n_beta 25982

echo "L0 syntax and plan is non-mutating"
bash -n "$SCRIPT"; bun build "$CFGTOOL" --target node --outfile /tmp/test598-config-tool.js >/dev/null
before=$(sha256sum "$INV/alpha-bridge-config.json")
bun "$CFGTOOL" --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" | grep -Fq 'absent-no-migration'
[[ "$before" == "$(sha256sum "$INV/alpha-bridge-config.json")" && ! -e "$GOALS" ]]

echo "L1 goalsPath fail-closed matrix"
chmod 0775 "$INV"; chmod 0664 "$INV/beta-bridge-config.json"
bun "$CFGTOOL" --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" | grep -Fq 'permissionRepairs'
test "$(stat -c %a "$INV")" = 775; test "$(stat -c %a "$INV/beta-bridge-config.json")" = 664
bun "$CFGTOOL" --mode apply --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" >/tmp/test598-permission-apply.json
test "$(stat -c %a "$INV")" = 700; test "$(stat -c %a "$INV/beta-bridge-config.json")" = 600
chown 65534 "$INV/beta-bridge-config.json"
expect_red non-owner-controlled bun "$CFGTOOL" --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS"
chown "$(id -u)" "$INV/beta-bridge-config.json"; chmod 0600 "$INV/beta-bridge-config.json"
cp "$INV/beta-bridge-config.json" /tmp/test598-beta
bun -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.node_id="n_alpha";require("fs").writeFileSync(f,JSON.stringify(c))' "$INV/beta-bridge-config.json"; chmod 0600 "$INV/beta-bridge-config.json"
expect_red duplicate-node bun "$CFGTOOL" --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS"
mv /tmp/test598-beta "$INV/beta-bridge-config.json"; chmod 0600 "$INV/beta-bridge-config.json"
cp "$INV/beta-bridge-config.json" /tmp/test598-beta
bun -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.goalsPath=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(c))' "$INV/beta-bridge-config.json" "$GOALS/n_alpha/goals.json"; chmod 0600 "$INV/beta-bridge-config.json"
expect_red duplicate-goals-path bun "$CFGTOOL" --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS"
cp "$CFGTOOL" /tmp/test598-mutant.mjs
sed -i 's/entry.path !== configPath && entry.effective === desired/false/' /tmp/test598-mutant.mjs
expect_red collision-mutation-must-be-caught must_reject bun /tmp/test598-mutant.mjs --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS"
mv /tmp/test598-beta "$INV/beta-bridge-config.json"; chmod 0600 "$INV/beta-bridge-config.json"
bun "$CFGTOOL" --mode apply --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS"
test "$(stat -c %a "$GOALS")" = 700; test "$(stat -c %a "$GOALS/n_alpha")" = 700
test ! -e "$GOALS/n_alpha/goals.json"
test "$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).goalsPath)' "$INV/alpha-bridge-config.json")" = "$GOALS/n_alpha/goals.json"

echo "L2 real tmux/process apply"
bun build --compile /workspace/tests/test598-codex-copresence-normalizer/fake-codex.ts --outfile "$ROOT/fake-codex" >/dev/null
cp /workspace/tests/test598-codex-copresence-normalizer/fake-bridge.ts "$ROOT/fake-bridge.ts"; chmod 0700 "$ROOT/fake-codex"; chmod 0600 "$ROOT/fake-bridge.ts"
DIST_SHA=$(sha256sum "$ROOT/fake-bridge.ts" | awk '{print $1}')
tmux -L test598 new-session -d -s alpha-appsrv 'sleep 1000'
tmux -L test598 new-session -d -s alpha-old-bridge 'sleep 1000'
P1=$(tmux -L test598 display-message -p -t alpha-appsrv '#{pane_pid}')
P2=$(tmux -L test598 display-message -p -t alpha-old-bridge '#{pane_pid}')
S1=$(awk '{print $22}' "/proc/$P1/stat"); S2=$(awk '{print $22}' "/proc/$P2/stat")
# Wrap tmux so the production script uses this isolated server.
mkdir "$ROOT/bin"; chmod 0700 "$ROOT/bin"
printf '#!/usr/bin/env bash\nexec /usr/bin/tmux -L test598 "$@"\n' >"$ROOT/bin/tmux"; chmod 0700 "$ROOT/bin/tmux"
bash -c 'sleep 30 & wait' -- --alias alpha & ROGUE=$!
expect_red unaccounted-process env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode plan --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge \
  --expected-pid "$P1:$S1" --expected-pid "$P2:$S2"
kill "$ROGUE"; wait "$ROGUE" 2>/dev/null || true
PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode apply --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge \
  --expected-pid "$P1:$S1" --expected-pid "$P2:$S2" --stop-session alpha-appsrv --stop-session alpha-old-bridge
tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq alpha-appsrv
tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq alpha-bridge
ss -ltnH 'sport = :25981' | grep -q .

echo "L3 PID drift, unaccounted process, and rollback"
expect_red pid-drift env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode plan --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --workdir "$WORK" \
  --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge --expected-pid "$$:1"

write_cfg "$INV/gamma-bridge-config.json" n_gamma 25983
tmux -L test598 new-session -d -s gamma-old-appsrv 'sleep 1000'
tmux -L test598 new-session -d -s gamma-old-bridge 'sleep 1000'
G1=$(tmux -L test598 display-message -p -t gamma-old-appsrv '#{pane_pid}')
G2=$(tmux -L test598 display-message -p -t gamma-old-bridge '#{pane_pid}')
GS1=$(awk '{print $22}' "/proc/$G1/stat"); GS2=$(awk '{print $22}' "/proc/$G2/stat")
gamma_before=$(sha256sum "$INV/gamma-bridge-config.json")
expect_red version-failure-rolls-back env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode apply --alias gamma \
  --config "$INV/gamma-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 0.0.0 \
  --new-appsrv-session gamma-appsrv --new-bridge-session gamma-bridge \
  --expected-pid "$G1:$GS1" --expected-pid "$G2:$GS2" --stop-session gamma-old-appsrv --stop-session gamma-old-bridge
[[ "$gamma_before" == "$(sha256sum "$INV/gamma-bridge-config.json")" ]]
test ! -d "$GOALS/n_gamma"
! tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq gamma-appsrv
! tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq gamma-bridge

tmux -L test598 kill-server
echo "L4 mutation anchors"
grep -Fq 'entry.path !== configPath && entry.effective === desired' "$CFGTOOL"
grep -Fq 'unaccounted matching process' "$SCRIPT"
grep -Fq 'pid $pid starttime drift' "$SCRIPT"
grep -Fq 'runtime remains stopped fail-closed' "$SCRIPT"
grep -Fq 'UAT_REQUIRED: socket single-owner + /goal + /loop notice + /aloop create/cancel' "$SCRIPT"
! grep -Fq 'ntok_TEST_ONLY' "$REPORT"
echo "RESULT: PASS"
