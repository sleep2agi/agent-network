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
THREAD_TOOL=/workspace/scripts/codex-copresence-thread-owner.mjs
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
  printf '{"node_id":"%s","runtime":"codex-app-server","token":"ntok_TEST_ONLY","hub":"http://127.0.0.1:19999","model":"%s","codexAppServerUrl":"ws://127.0.0.1:%s","codexThreadId":"thread_test_%s","flags":{"approvalPolicy":"never","sandboxMode":"danger-full-access"}}\n' "$node" "$model" "$port" "$node" >"$path"
  chmod 0600 "$path"
}
write_cfg "$INV/alpha-bridge-config.json" n_alpha 25981 gpt-5.5
write_cfg "$INV/beta-bridge-config.json" n_beta 25982

echo "L0 syntax and plan is non-mutating"
bash -n "$SCRIPT"; bun build "$CFGTOOL" --target node --outfile /tmp/test598-config-tool.js >/dev/null
bun build "$THREAD_TOOL" --target node --outfile /tmp/test598-thread-tool.js >/dev/null
before=$(sha256sum "$INV/alpha-bridge-config.json")
bun "$CFGTOOL" --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --model gpt-5.6-sol | grep -Fq '"modelTo":"gpt-5.6-sol"'
[[ "$before" == "$(sha256sum "$INV/alpha-bridge-config.json")" && ! -e "$GOALS" ]]

echo "L1 goalsPath fail-closed matrix"
chmod 0775 "$INV" "$WORK"; chmod 0664 "$INV/beta-bridge-config.json"
bun "$CFGTOOL" --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --workdir "$WORK" | grep -Fq 'permissionRepairs'
test "$(stat -c %a "$INV")" = 775; test "$(stat -c %a "$WORK")" = 775; test "$(stat -c %a "$INV/beta-bridge-config.json")" = 664
expect_red implicit-fleet-permission-repair bun "$CFGTOOL" --mode apply --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --workdir "$WORK"
test "$(stat -c %a "$INV")" = 775; test "$(stat -c %a "$WORK")" = 775; test "$(stat -c %a "$INV/beta-bridge-config.json")" = 664
bun "$CFGTOOL" --mode prepare-permissions --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --workdir "$WORK" >/tmp/test598-permission-prepare.json
test "$(stat -c %a "$INV")" = 700; test "$(stat -c %a "$WORK")" = 700; test "$(stat -c %a "$INV/beta-bridge-config.json")" = 600
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
cp "$INV/beta-bridge-config.json" /tmp/test598-beta
bun -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.codexThreadId="thread_test_n_alpha";require("fs").writeFileSync(f,JSON.stringify(c))' "$INV/beta-bridge-config.json"; chmod 0600 "$INV/beta-bridge-config.json"
expect_red duplicate-thread bun "$CFGTOOL" --mode plan --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS"
mv /tmp/test598-beta "$INV/beta-bridge-config.json"; chmod 0600 "$INV/beta-bridge-config.json"
bun "$CFGTOOL" --mode apply --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --model gpt-5.6-sol
test "$(stat -c %a "$GOALS")" = 700; test "$(stat -c %a "$GOALS/n_alpha")" = 700
test ! -e "$GOALS/n_alpha/goals.json"
test "$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).goalsPath)' "$INV/alpha-bridge-config.json")" = "$GOALS/n_alpha/goals.json"
test "$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).model)' "$INV/alpha-bridge-config.json")" = gpt-5.6-sol

echo "L2 real tmux/process apply"
bun -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.model="gpt-5.5";require("fs").writeFileSync(f,JSON.stringify(c)+"\n")' "$INV/alpha-bridge-config.json"; chmod 0600 "$INV/alpha-bridge-config.json"
bun build --compile /workspace/tests/test598-codex-copresence-normalizer/fake-codex.ts --outfile "$ROOT/fake-codex" >/dev/null
cp /workspace/tests/test598-codex-copresence-normalizer/fake-bridge.ts "$ROOT/fake-bridge.ts"; chmod 0700 "$ROOT/fake-codex"; chmod 0600 "$ROOT/fake-bridge.ts"
DIST_SHA=$(sha256sum "$ROOT/fake-bridge.ts" | awk '{print $1}')
tmux -L test598 new-session -d -s alpha-appsrv 'sleep 1000'
tmux -L test598 new-session -d -s alpha-old-bridge 'sleep 1000'
tmux -L test598 new-session -d -s alpha-tui 'sleep 1000'
P1=$(tmux -L test598 display-message -p -t alpha-appsrv '#{pane_pid}')
P2=$(tmux -L test598 display-message -p -t alpha-old-bridge '#{pane_pid}')
P3=$(tmux -L test598 display-message -p -t alpha-tui '#{pane_pid}')
S1=$(awk '{print $22}' "/proc/$P1/stat"); S2=$(awk '{print $22}' "/proc/$P2/stat"); S3=$(awk '{print $22}' "/proc/$P3/stat")
# Wrap tmux so the production script uses this isolated server.
mkdir "$ROOT/bin"; chmod 0700 "$ROOT/bin"
printf '#!/usr/bin/env bash\nexec /usr/bin/tmux -L test598 "$@"\n' >"$ROOT/bin/tmux"; chmod 0700 "$ROOT/bin/tmux"
chmod 0775 "$INV" "$WORK"
expect_red normalizer-refuses-implicit-inventory-permission-repair env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode apply --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge --new-tui-session alpha-tui --expected-tui-command fake-codex \
  --expected-pid "$P1:$S1" --expected-pid "$P2:$S2" --expected-pid "$P3:$S3" --stop-session alpha-appsrv --stop-session alpha-old-bridge --stop-session alpha-tui
for live in alpha-appsrv alpha-old-bridge alpha-tui; do tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq "$live"; done
bun "$CFGTOOL" --mode prepare-permissions --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --workdir "$WORK" >/tmp/test598-l2-permission-prepare.json
test "$(stat -c %a "$WORK")" = 700
bash -c 'sleep 30 & wait' -- --alias alpha & ROGUE=$!
expect_red unaccounted-process env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode plan --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge --new-tui-session alpha-tui --expected-tui-command fake-codex \
  --expected-pid "$P1:$S1" --expected-pid "$P2:$S2" --expected-pid "$P3:$S3"
kill "$ROGUE"; wait "$ROGUE" 2>/dev/null || true
PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode apply --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge --new-tui-session alpha-tui --expected-tui-command fake-codex \
  --expected-pid "$P1:$S1" --expected-pid "$P2:$S2" --expected-pid "$P3:$S3" --stop-session alpha-appsrv --stop-session alpha-old-bridge --stop-session alpha-tui
test "$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).model)' "$INV/alpha-bridge-config.json")" = gpt-5.6-sol
tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq alpha-appsrv
tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq alpha-bridge
tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq alpha-tui
ss -ltnH 'sport = :25981' | grep -q .
ALPHA_PANE=$(tmux -L test598 list-panes -t alpha-tui -F '#{pane_pid}')
ALPHA_SOCKET_PID=$(ss -tnpH state established 'dport = :25981' | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)
test -n "$ALPHA_SOCKET_PID"; test "$ALPHA_SOCKET_PID" != "$ALPHA_PANE"
test "$(awk '$1=="PPid:" {print $2}' "/proc/$ALPHA_SOCKET_PID/status")" = "$ALPHA_PANE"
bun "$THREAD_TOOL" --ws ws://127.0.0.1:25981 --thread-id thread_test_n_alpha --node-id n_alpha --alias alpha --cwd "$WORK" --mode verify
mkdir "$ROOT/wrong-work"; chmod 0700 "$ROOT/wrong-work"
expect_red thread-owner-mismatch bun "$THREAD_TOOL" --ws ws://127.0.0.1:25981 --thread-id thread_test_n_alpha --node-id n_other --alias alpha --cwd "$WORK" --mode claim
expect_red thread-cwd-mismatch bun "$THREAD_TOOL" --ws ws://127.0.0.1:25981 --thread-id thread_test_n_alpha --node-id n_alpha --alias alpha --cwd "$ROOT/wrong-work" --mode verify

echo "L3 PID drift, unaccounted process, and rollback"
ALPHA_APP_PANE=$(tmux -L test598 display-message -p -t alpha-appsrv '#{pane_pid}')
ALPHA_BRIDGE_PANE=$(tmux -L test598 display-message -p -t alpha-bridge '#{pane_pid}')
ALPHA_TUI_PANE=$(tmux -L test598 display-message -p -t alpha-tui '#{pane_pid}')
"$ROOT/fake-codex" --stray-no-bind app-server -c approval_policy=never -c sandbox_mode=danger-full-access --listen ws://127.0.0.1:25981 &
STRAY_FLAGGED_APPSRV=$!
sleep 0.1
FLAGGED_EXPECTED=()
for owned in "$ALPHA_APP_PANE" "$ALPHA_BRIDGE_PANE" "$ALPHA_TUI_PANE" "$ALPHA_SOCKET_PID"; do
  FLAGGED_EXPECTED+=(--expected-pid "$owned:$(awk '{print $22}' "/proc/$owned/stat")")
done
expect_red flagged-appserver-must-be-unaccounted env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode plan --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --workdir "$WORK" \
  --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge --new-tui-session alpha-tui --expected-tui-command fake-codex \
  "${FLAGGED_EXPECTED[@]}" --stop-session alpha-appsrv --stop-session alpha-bridge --stop-session alpha-tui
grep -Fq "unaccounted matching process pid=$STRAY_FLAGGED_APPSRV" /tmp/test598-red.log
cp "$SCRIPT" /workspace/scripts/test598-adjacent-appserver-mutant.sh
sed -i 's/if (( saw_app_server == 1 )) && \[\[ "${PROC_ARGV\[i\]}" == --listen/if [[ "${PROC_ARGV[i-1]:-}" == app-server \&\& "${PROC_ARGV[i]}" == --listen/' /workspace/scripts/test598-adjacent-appserver-mutant.sh
expect_red flagged-appserver-matcher-mutation-must-be-caught must_reject env PATH="$ROOT/bin:$PATH" /workspace/scripts/test598-adjacent-appserver-mutant.sh --mode plan --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --workdir "$WORK" \
  --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge --new-tui-session alpha-tui --expected-tui-command fake-codex \
  "${FLAGGED_EXPECTED[@]}" --stop-session alpha-appsrv --stop-session alpha-bridge --stop-session alpha-tui
kill "$STRAY_FLAGGED_APPSRV"; wait "$STRAY_FLAGGED_APPSRV" 2>/dev/null || true

expect_red pid-drift env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode plan --alias alpha \
  --config "$INV/alpha-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" --workdir "$WORK" \
  --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session alpha-appsrv --new-bridge-session alpha-bridge --new-tui-session alpha-tui --expected-tui-command fake-codex --expected-pid "$$:1"

write_cfg "$INV/gamma-bridge-config.json" n_gamma 25983 gpt-5.5
tmux -L test598 new-session -d -s gamma-old-appsrv 'sleep 1000'
tmux -L test598 new-session -d -s gamma-old-bridge 'sleep 1000'
tmux -L test598 new-session -d -s gamma-old-tui 'sleep 1000'
G1=$(tmux -L test598 display-message -p -t gamma-old-appsrv '#{pane_pid}')
G2=$(tmux -L test598 display-message -p -t gamma-old-bridge '#{pane_pid}')
G3=$(tmux -L test598 display-message -p -t gamma-old-tui '#{pane_pid}')
GS1=$(awk '{print $22}' "/proc/$G1/stat"); GS2=$(awk '{print $22}' "/proc/$G2/stat"); GS3=$(awk '{print $22}' "/proc/$G3/stat")
gamma_before=$(sha256sum "$INV/gamma-bridge-config.json")
expect_red version-failure-rolls-back env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode apply --alias gamma \
  --config "$INV/gamma-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 0.0.0 --expected-model gpt-5.6-sol \
  --new-appsrv-session gamma-appsrv --new-bridge-session gamma-bridge --new-tui-session gamma-tui --expected-tui-command fake-codex \
  --expected-pid "$G1:$GS1" --expected-pid "$G2:$GS2" --expected-pid "$G3:$GS3" --stop-session gamma-old-appsrv --stop-session gamma-old-bridge --stop-session gamma-old-tui
[[ "$gamma_before" == "$(sha256sum "$INV/gamma-bridge-config.json")" ]]
test ! -d "$GOALS/n_gamma"
! tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq gamma-appsrv
! tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq gamma-bridge
! tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq gamma-tui

write_cfg "$INV/delta-bridge-config.json" n_delta 25984
bun -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.codexThreadId="thread_fail_resume";require("fs").writeFileSync(f,JSON.stringify(c)+"\n")' "$INV/delta-bridge-config.json"; chmod 0600 "$INV/delta-bridge-config.json"
tmux -L test598 new-session -d -s delta-old-appsrv 'sleep 1000'
tmux -L test598 new-session -d -s delta-old-bridge 'sleep 1000'
tmux -L test598 new-session -d -s delta-old-tui 'sleep 1000'
D1=$(tmux -L test598 display-message -p -t delta-old-appsrv '#{pane_pid}')
D2=$(tmux -L test598 display-message -p -t delta-old-bridge '#{pane_pid}')
D3=$(tmux -L test598 display-message -p -t delta-old-tui '#{pane_pid}')
DS1=$(awk '{print $22}' "/proc/$D1/stat"); DS2=$(awk '{print $22}' "/proc/$D2/stat"); DS3=$(awk '{print $22}' "/proc/$D3/stat")
delta_before=$(sha256sum "$INV/delta-bridge-config.json")
expect_red tui-exit-rolls-back-all-components env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode apply --alias delta \
  --config "$INV/delta-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session delta-appsrv --new-bridge-session delta-bridge --new-tui-session delta-tui --expected-tui-command fake-codex \
  --expected-pid "$D1:$DS1" --expected-pid "$D2:$DS2" --expected-pid "$D3:$DS3" --stop-session delta-old-appsrv --stop-session delta-old-bridge --stop-session delta-old-tui
[[ "$delta_before" == "$(sha256sum "$INV/delta-bridge-config.json")" ]]
test ! -d "$GOALS/n_delta"
for dead in delta-appsrv delta-bridge delta-tui; do ! tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq "$dead"; done

write_cfg "$INV/epsilon-bridge-config.json" n_epsilon 25985
bun -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f));c.codexThreadId="thread_no_socket";require("fs").writeFileSync(f,JSON.stringify(c)+"\n")' "$INV/epsilon-bridge-config.json"; chmod 0600 "$INV/epsilon-bridge-config.json"
tmux -L test598 new-session -d -s epsilon-old-appsrv 'sleep 1000'
tmux -L test598 new-session -d -s epsilon-old-bridge 'sleep 1000'
tmux -L test598 new-session -d -s epsilon-old-tui 'sleep 1000'
E1=$(tmux -L test598 display-message -p -t epsilon-old-appsrv '#{pane_pid}')
E2=$(tmux -L test598 display-message -p -t epsilon-old-bridge '#{pane_pid}')
E3=$(tmux -L test598 display-message -p -t epsilon-old-tui '#{pane_pid}')
ES1=$(awk '{print $22}' "/proc/$E1/stat"); ES2=$(awk '{print $22}' "/proc/$E2/stat"); ES3=$(awk '{print $22}' "/proc/$E3/stat")
epsilon_before=$(sha256sum "$INV/epsilon-bridge-config.json")
expect_red tui-without-socket-rolls-back-all-components env PATH="$ROOT/bin:$PATH" "$SCRIPT" --mode apply --alias epsilon \
  --config "$INV/epsilon-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session epsilon-appsrv --new-bridge-session epsilon-bridge --new-tui-session epsilon-tui --expected-tui-command fake-codex \
  --expected-pid "$E1:$ES1" --expected-pid "$E2:$ES2" --expected-pid "$E3:$ES3" --stop-session epsilon-old-appsrv --stop-session epsilon-old-bridge --stop-session epsilon-old-tui
[[ "$epsilon_before" == "$(sha256sum "$INV/epsilon-bridge-config.json")" ]]
test ! -d "$GOALS/n_epsilon"
for dead in epsilon-appsrv epsilon-bridge epsilon-tui; do ! tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq "$dead"; done

write_cfg "$INV/zeta-bridge-config.json" n_zeta 25986
tmux -L test598 new-session -d -s zeta-old-appsrv 'sleep 1000'
tmux -L test598 new-session -d -s zeta-old-bridge 'sleep 1000'
tmux -L test598 new-session -d -s zeta-old-tui 'sleep 1000'
Z1=$(tmux -L test598 display-message -p -t zeta-old-appsrv '#{pane_pid}')
Z2=$(tmux -L test598 display-message -p -t zeta-old-bridge '#{pane_pid}')
Z3=$(tmux -L test598 display-message -p -t zeta-old-tui '#{pane_pid}')
ZS1=$(awk '{print $22}' "/proc/$Z1/stat"); ZS2=$(awk '{print $22}' "/proc/$Z2/stat"); ZS3=$(awk '{print $22}' "/proc/$Z3/stat")
zeta_before=$(sha256sum "$INV/zeta-bridge-config.json")
cp "$SCRIPT" /workspace/scripts/test598-root-only-mutant.sh
sed -i 's/mapfile -t TUI_SOCKET_CANDIDATES < <(descendant_pids "$TUI_PID")/TUI_SOCKET_CANDIDATES=("$TUI_PID")/' /workspace/scripts/test598-root-only-mutant.sh
expect_red root-only-socket-mutation-must-reject-child-holder env PATH="$ROOT/bin:$PATH" /workspace/scripts/test598-root-only-mutant.sh --mode apply --alias zeta \
  --config "$INV/zeta-bridge-config.json" --inventory-dir "$INV" --goals-root "$GOALS" \
  --workdir "$WORK" --dist-cli "$ROOT/fake-bridge.ts" --expected-dist-sha256 "$DIST_SHA" --codex-bin "$ROOT/fake-codex" --expected-version 9.9.9 --expected-model gpt-5.6-sol \
  --new-appsrv-session zeta-appsrv --new-bridge-session zeta-bridge --new-tui-session zeta-tui --expected-tui-command fake-codex \
  --expected-pid "$Z1:$ZS1" --expected-pid "$Z2:$ZS2" --expected-pid "$Z3:$ZS3" --stop-session zeta-old-appsrv --stop-session zeta-old-bridge --stop-session zeta-old-tui
grep -Fq 'TUI process tree has no socket to the new app-server' /tmp/test598-red.log
[[ "$zeta_before" == "$(sha256sum "$INV/zeta-bridge-config.json")" ]]
test ! -d "$GOALS/n_zeta"
for dead in zeta-appsrv zeta-bridge zeta-tui; do ! tmux -L test598 list-sessions -F '#{session_name}' | grep -Fxq "$dead"; done

tmux -L test598 kill-server
echo "L4 mutation anchors"
grep -Fq 'entry.path !== configPath && entry.effective === desired' "$CFGTOOL"
grep -Fq 'unaccounted matching process' "$SCRIPT"
grep -Fq 'pid $pid starttime drift' "$SCRIPT"
grep -Fq 'runtime remains stopped fail-closed' "$SCRIPT"
grep -Fq 'thread owner mismatch' "$THREAD_TOOL"
grep -Fq 'thread cwd mismatch' "$THREAD_TOOL"
grep -Fq 'TUI process tree has no socket to the new app-server' "$SCRIPT"
grep -Fq 'UAT_REQUIRED: socket single-owner + /goal + /loop notice + /aloop create/cancel' "$SCRIPT"
! grep -Fq 'ntok_TEST_ONLY' "$REPORT"
echo "RESULT: PASS"
