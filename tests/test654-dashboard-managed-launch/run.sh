#!/usr/bin/env bash
set -Eeuo pipefail

printf 'source_commit=%s\n' "${TEST654_SOURCE_COMMIT:-unknown}"

ROOT=/repo
CLI="$ROOT/agent-network/bin/cli.ts"
TEST="$ROOT/tests/test654-dashboard-managed-launch"
WORK=/tmp/test654
HOME_DIR="$WORK/home"
BIN="$WORK/bin"
NO_LSOF_BIN="$WORK/no-lsof-bin"
RACE_BIN="$WORK/race-bin"
ART=/artifacts
mkdir -p "$HOME_DIR/.anet/server" "$BIN" "$NO_LSOF_BIN" "$RACE_BIN" "$ART"
export HOME="$HOME_DIR"
export ANET_DASHBOARD_VERSION=preview
export VERSION_FILE="$WORK/version"
printf '0.6.0\n' > "$VERSION_FILE"

PASS=0
FAIL=0
ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
expect_red(){
  local name="$1"; shift
  if "$@" >"$ART/$name.log" 2>&1; then bad "mutation $name stayed green"; else ok "mutation $name witnessed red"; fi
}

# 🔴 变异必须真的改动文件，否则算【测试锚点过期】而不是产品缺陷。
#    为什么这里**不能**用本仓另一种常见写法 `grep -F '<变异后的形态>' <文件>`：
#      · 下面第一条变异把 `input.healthy && record.source === … && record.source_key === …`
#        换成 `input.healthy` —— **变异后的形态是原文的子串**，grep 它变异前也命中，
#        那会是一个恒真的守卫；
#      · 后两条是**删行**（`sed -i '0,/…/{//d;}'`），压根没有「变异后的形态」可 grep。
#    ⇒ 这四条只能比对「文件有没有变」。每条变异前本来就已经 cp 了一份 .orig，直接用它。
assert_mutated(){ # $1=目标文件 $2=变异前的副本
  cmp -s "$1" "$2" || return 0
  bad "mutation did not change $1 —— 【测试锚点过期】，不是产品缺陷"
  printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
  exit 1
}

cleanup_pids=()
cleanup(){
  for pid in "${cleanup_pids[@]:-}"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

cat >"$BIN/npm" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *" view "* ]]; then
  printf '"%s"\n' "$(cat "$VERSION_FILE")"
  exit 0
fi
exec /usr/bin/npm "$@"
SH
cat >"$BIN/npx" <<SH
#!/usr/bin/env bash
exec /usr/bin/node "$TEST/agent-network-dashboard/server.js"
SH
chmod +x "$BIN/npm" "$BIN/npx"
export PATH="$BIN:/usr/local/bin:/usr/bin:/bin"

wait_listener(){
  local port="$1"
  for _ in $(seq 1 120); do
    local pid
    pid="$(lsof -t -i ":$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    [[ "$pid" =~ ^[0-9]+$ ]] && { printf '%s\n' "$pid"; return 0; }
    sleep 0.1
  done
  return 1
}
wait_record(){
  local port="$1"
  local file="$HOME/.anet/server/dashboard-$port.json"
  for _ in $(seq 1 120); do [[ -s "$file" ]] && return 0; sleep 0.1; done
  return 1
}
wait_record_key(){
  local port="$1" key="$2"
  local file="$HOME/.anet/server/dashboard-$port.json"
  for _ in $(seq 1 120); do
    [[ -s "$file" ]] && [[ "$(jq -r '.source_key' "$file" 2>/dev/null || true)" == "$key" ]] && return 0
    sleep 0.1
  done
  return 1
}

for cmd in bun node npm npx lsof which timeout; do
  target="$(command -v "$cmd")"
  ln -sf "$target" "$RACE_BIN/$cmd"
done
cat >"$RACE_BIN/ps" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
case " $* " in
  *" -o lstart= "*)
    if [[ "${RACE_CHANGE_BIRTH:-1}" == 1 ]]; then
      if [[ -e "${RACE_BIRTH_STATE:?}" ]]; then printf 'birth-2\n'; else printf 'birth-1\n'; : >"$RACE_BIRTH_STATE"; fi
    else
      printf 'birth-1\n'
    fi
    ;;
  *" -o command= "*)
    if [[ "${RACE_CHANGE_COMMAND:-0}" == 1 && -e "${RACE_COMMAND_STATE:?}" ]]; then
      printf '/usr/bin/foreign-service --same-pid\n'
    else
      printf 'node /fixture/agent-network-dashboard/server.js\n'
      : >"${RACE_COMMAND_STATE:?}"
    fi
    ;;
  *) exec /usr/bin/ps "$@" ;;
esac
SH
chmod +x "$RACE_BIN/ps"

run_identity_race(){
  local port="$1" log="$2" change_birth="$3" change_command="$4" pid rc alive=0
  local record="$HOME/.anet/server/dashboard-$port.json"
  export RACE_CHANGE_BIRTH="$change_birth" RACE_CHANGE_COMMAND="$change_command"
  export RACE_BIRTH_STATE="$WORK/race-birth-$port.state"
  export RACE_COMMAND_STATE="$WORK/race-command-$port.state"
  rm -f "$RACE_BIRTH_STATE" "$RACE_COMMAND_STATE" "$record"
  PORT="$port" HOSTNAME=127.0.0.1 /usr/bin/node "$TEST/agent-network-dashboard/server.js" &
  pid=$!
  wait_listener "$port" >/dev/null
  cat >"$record" <<JSON
{"schema":1,"port":$port,"listener_pid":$pid,"listener_birth":"birth-1","source":"npx","source_key":"npx:0.5.9","recorded_at":"2026-08-10T00:00:00.000Z"}
JSON
  set +e
  PATH="$RACE_BIN:/usr/local/bin:/usr/bin:/bin" timeout 8 bun "$CLI" hub dashboard --port "$port" >"$log" 2>&1
  rc=$?
  set -e
  kill -0 "$pid" 2>/dev/null && alive=1
  local safe=1
  [[ "$rc" -ne 0 && "$alive" -eq 1 ]] && grep -q 'still owns port' "$log" && safe=0
  for cleanup_pid in $(lsof -t -i ":$port" -sTCP:LISTEN 2>/dev/null || true); do
    kill "$cleanup_pid" 2>/dev/null || true
    wait "$cleanup_pid" 2>/dev/null || true
  done
  rm -f "$record" "$RACE_BIRTH_STATE" "$RACE_COMMAND_STATE"
  return "$safe"
}

run_birth_race(){ run_identity_race "$1" "$2" 1 0; }
run_foreign_reuse_race(){ run_identity_race "$1" "$2" 1 1; }

echo "== L0 unit + typecheck =="
cd "$ROOT/agent-network"
bun test src/dashboard-managed-process.test.ts
bunx tsc --noEmit

echo "== L1 foreign listener is never killed =="
PORT=33101 HOSTNAME=127.0.0.1 /usr/bin/node "$TEST/agent-network-dashboard/server.js" &
FOREIGN_PID=$!
cleanup_pids+=("$FOREIGN_PID")
wait_listener 33101 >/dev/null
set +e
timeout 8 bun "$CLI" hub dashboard --port 33101 >"$ART/foreign.log" 2>&1
FOREIGN_RC=$?
set -e
if [[ "$FOREIGN_RC" -ne 0 ]] && kill -0 "$FOREIGN_PID" 2>/dev/null && grep -q 'unmanaged process' "$ART/foreign.log"; then
  ok "unmanaged exact-port listener refused and remains alive"
else bad "foreign listener gate rc=$FOREIGN_RC alive=$(kill -0 "$FOREIGN_PID" 2>/dev/null && echo yes || echo no)"; fi

echo "== L2 global opt-in is explicit and fail-closed =="
set +e
ANET_DASHBOARD_LOCAL=1 timeout 8 bun "$CLI" hub dashboard --port 33103 >"$ART/global-missing.log" 2>&1
GLOBAL_MISSING_RC=$?
set -e
if [[ "$GLOBAL_MISSING_RC" -ne 0 ]] && grep -q 'not on PATH' "$ART/global-missing.log"; then ok "global opt-in refuses missing binary"; else bad "missing global binary was not rejected"; fi

cat >"$BIN/agent-network-dashboard" <<SH
#!/usr/bin/env bash
exec /usr/bin/node "$TEST/agent-network-dashboard/server.js"
SH
chmod +x "$BIN/agent-network-dashboard"
ANET_DASHBOARD_LOCAL=1 bun "$CLI" hub dashboard --port 33103 >"$ART/global-first.log" 2>&1 &
GLOBAL_CLI_PID=$!
cleanup_pids+=("$GLOBAL_CLI_PID")
GLOBAL_LISTENER="$(wait_listener 33103)"
cleanup_pids+=("$GLOBAL_LISTENER")
wait_record 33103
if [[ "$(jq -r '.source' "$HOME/.anet/server/dashboard-33103.json")" == global ]]; then ok "explicit global binary spawned and recorded"; else bad "global source not recorded"; fi
set +e
ANET_DASHBOARD_LOCAL=1 timeout 8 bun "$CLI" hub dashboard --port 33103 >"$ART/global-second.log" 2>&1
GLOBAL_SECOND_RC=$?
set -e
if [[ "$GLOBAL_SECOND_RC" -ne 0 ]] && kill -0 "$GLOBAL_LISTENER" 2>/dev/null && grep -q 'explicitly managed global' "$ART/global-second.log"; then
  ok "live global Dashboard is never auto-killed"
else bad "global listener protection failed"; fi

echo "== L3 managed npx lifecycle =="
bun "$CLI" hub dashboard --port 33102 >"$ART/npx-first.log" 2>&1 &
FIRST_CLI_PID=$!
cleanup_pids+=("$FIRST_CLI_PID")
FIRST_LISTENER="$(wait_listener 33102)"
cleanup_pids+=("$FIRST_LISTENER")
wait_record_key 33102 npx:0.6.0
RECORDED_PID="$(jq -r '.listener_pid' "$HOME/.anet/server/dashboard-33102.json")"
RECORDED_KEY="$(jq -r '.source_key' "$HOME/.anet/server/dashboard-33102.json")"
if [[ "$RECORDED_PID" == "$FIRST_LISTENER" && "$RECORDED_KEY" == npx:0.6.0 ]]; then ok "exact listener pid/version recorded"; else bad "bad managed record pid=$RECORDED_PID key=$RECORDED_KEY"; fi

timeout 8 bun "$CLI" hub dashboard --port 33102 >"$ART/npx-same.log" 2>&1
if kill -0 "$FIRST_LISTENER" 2>/dev/null && grep -q 'already running.*leaving it untouched' "$ART/npx-same.log"; then ok "same healthy release is not killed"; else bad "same-release listener changed"; fi

printf '0.6.1\n' > "$VERSION_FILE"
bun "$CLI" hub dashboard --port 33102 >"$ART/npx-upgrade.log" 2>&1 &
UPGRADE_CLI_PID=$!
cleanup_pids+=("$UPGRADE_CLI_PID")
for _ in $(seq 1 120); do
  NEW_LISTENER="$(lsof -t -i :33102 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ "$NEW_LISTENER" =~ ^[0-9]+$ && "$NEW_LISTENER" != "$FIRST_LISTENER" ]] && break
  sleep 0.1
done
wait_record_key 33102 npx:0.6.1
cleanup_pids+=("${NEW_LISTENER:-}")
if ! kill -0 "$FIRST_LISTENER" 2>/dev/null && [[ "${NEW_LISTENER:-}" =~ ^[0-9]+$ ]] && kill -0 "$NEW_LISTENER" 2>/dev/null \
  && [[ "$(jq -r '.source_key' "$HOME/.anet/server/dashboard-33102.json")" == npx:0.6.1 ]]; then
  ok "version change kills only exact recorded stale pid and records replacement"
else bad "managed replacement failed old=$FIRST_LISTENER new=${NEW_LISTENER:-none}"; fi

echo "== L4 PID birth is revalidated immediately before kill =="
if run_birth_race 33105 "$ART/birth-race.log"; then
  ok "birth change between decision and signal refuses kill; listener remains alive"
else bad "birth-change race was not stopped before signal"; fi
if run_foreign_reuse_race 33107 "$ART/foreign-reuse-race.log"; then
  ok "same PID reused by a foreign identity before signal is refused and remains alive"
else bad "foreign PID-reuse race was not stopped before signal"; fi

echo "== L5 missing inspector cannot authorize cleanup =="
for cmd in bun node npm npx ps which timeout; do target="$(command -v "$cmd")"; ln -sf "$target" "$NO_LSOF_BIN/$cmd"; done
cat >"$NO_LSOF_BIN/lsof" <<'SH'
#!/usr/bin/env bash
exit 127
SH
chmod +x "$NO_LSOF_BIN/lsof"
PORT=33104 HOSTNAME=127.0.0.1 /usr/bin/node "$TEST/agent-network-dashboard/server.js" &
NOINSPECT_PID=$!
cleanup_pids+=("$NOINSPECT_PID")
wait_listener 33104 >/dev/null
set +e
PATH="$NO_LSOF_BIN:/bin" timeout 8 bun "$CLI" hub dashboard --port 33104 >"$ART/no-inspector.log" 2>&1
NOINSPECT_RC=$?
set -e
if kill -0 "$NOINSPECT_PID" 2>/dev/null && grep -q 'listener inspection unavailable' "$ART/no-inspector.log"; then
  ok "missing lsof does not authorize a kill (child may fail on occupied port, rc=$NOINSPECT_RC)"
else bad "missing-inspector guard failed"; fi

echo "== L6 witnessed-red mutations =="
cp "$ROOT/agent-network/src/dashboard-managed-process.ts" "$WORK/dashboard-managed-process.ts.orig"
sed -i 's/input\.healthy && record\.source === input\.desiredSource && record\.source_key === input\.desiredSourceKey/input.healthy/' "$ROOT/agent-network/src/dashboard-managed-process.ts"
assert_mutated "$ROOT/agent-network/src/dashboard-managed-process.ts" "$WORK/dashboard-managed-process.ts.orig"
expect_red version-gate bun test "$ROOT/agent-network/src/dashboard-managed-process.test.ts"
cp "$WORK/dashboard-managed-process.ts.orig" "$ROOT/agent-network/src/dashboard-managed-process.ts"
sed -i 's/if (!record) return { action: "refuse", reason: `port ${input.port} is occupied by an unmanaged process (pid ${pid})` };/if (!record) return { action: "terminate_owned_stale", pid, reason: "unhealthy" };/' "$ROOT/agent-network/src/dashboard-managed-process.ts"
assert_mutated "$ROOT/agent-network/src/dashboard-managed-process.ts" "$WORK/dashboard-managed-process.ts.orig"
expect_red unmanaged-gate bun test "$ROOT/agent-network/src/dashboard-managed-process.test.ts"
cp "$WORK/dashboard-managed-process.ts.orig" "$ROOT/agent-network/src/dashboard-managed-process.ts"
bun test "$ROOT/agent-network/src/dashboard-managed-process.test.ts"

cp "$CLI" "$WORK/cli.ts.orig"
sed -i '0,/if (!revalidateExactManagedDashboard(pid, port, expectedRecord)) return false;/{//d;}' "$CLI"
assert_mutated "$CLI" "$WORK/cli.ts.orig"
expect_red birth-recheck run_birth_race 33106 "$ART/birth-recheck-inner.log"
cp "$WORK/cli.ts.orig" "$CLI"

cp "$CLI" "$WORK/cli.ts.orig"
sed -i '0,/if (!revalidateExactManagedDashboard(pid, port, expectedRecord)) return false;/{//d;}' "$CLI"
assert_mutated "$CLI" "$WORK/cli.ts.orig"
expect_red foreign-reuse-recheck run_foreign_reuse_race 33108 "$ART/foreign-reuse-recheck-inner.log"
cp "$WORK/cli.ts.orig" "$CLI"

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
