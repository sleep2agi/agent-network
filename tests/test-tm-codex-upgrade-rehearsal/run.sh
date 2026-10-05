#!/usr/bin/env bash
# #593 — rehearsal of the TM codex-app-server upgrade:
#   agent-node 2.5.0-preview.88 (paired anet 2.3.0-preview.115) → agent-node 2.5.0-preview.112 (paired anet 2.3.0-preview.145)
#
# Throwaway everything: Hub from this checkout on 127.0.0.1:19593 (never 9200), HOME=$(mktemp -d),
# a fake `codex` (fake-codex.mjs — no OpenAI login, no model call), the two published release pairs from npm.
#
# Two start styles, because a fleet is upgraded the way it was started:
#   script — a custom script runs a bare `codex app-server --listen ws://127.0.0.1:<port>` and, beside it,
#            `agent-node --config <ws>/.anet/nodes/<alias>/config.json` from a global npm install; the node
#            config carries codexAppServerUrl (shared topology: the node does NOT own the app-server).
#   anet   — `anet node create` + `anet node start` (headless; agent-node spawns and owns its app-server).
# For each: kill the app-server (dead), SIGSTOP it (hung) and, for anet, make it crash at every launch,
# on the old version and again after an in-place upgrade + restart. Prints timings and the node's log lines.
set -uo pipefail

OLD_ANET=${OLD_ANET:-2.3.0-preview.115}   OLD_NODE=${OLD_NODE:-2.5.0-preview.88}
NEW_ANET=${NEW_ANET:-2.3.0-preview.145}   NEW_NODE=${NEW_NODE:-2.5.0-preview.112}
PORT=19593; HUB=http://127.0.0.1:$PORT; BARE_URL=ws://127.0.0.1:27593
# HOME must not sit under /tmp: anet validates every ancestor of the npx-resolved paired agent-node
# (a world-writable /tmp ancestor is refused as "unsafe ownership or mode").
umask 022
export HOME=$(mktemp -d -p /root home.XXXXXX) FAKE_CODEX_LOG=/tmp/fake-codex.log
export ANET_CODEX_HEALTH_INTERVAL_MS=${ANET_CODEX_HEALTH_INTERVAL_MS:-5000}
FAILS=0
now() { date +%s%3N; }
T0=$(now)
say() { echo "[$(( ($(now) - T0) / 1000 ))s] $*"; }
check() { if [ "$1" = ok ]; then say "PASS $2"; else say "FAIL $2"; FAILS=$((FAILS+1)); fi; }

(cd /workspace/server && PORT=$PORT HOST=127.0.0.1 COMMHUB_DB=/tmp/hub.db COMMHUB_AUTH_TOKEN=tm593 bun src/index.ts >/tmp/hub.log 2>&1 &)
for _ in $(seq 100); do curl -fsS -o /dev/null $HUB/health 2>/dev/null && break; sleep 0.2; done

say "install anet $OLD_ANET (paired agent-node $OLD_NODE) and, for the script style, a global agent-node $OLD_NODE"
npm i -g "@sleep2agi/agent-network@$OLD_ANET" "@sleep2agi/agent-node@$OLD_NODE" >/tmp/npm-old.log 2>&1 || { tail -20 /tmp/npm-old.log; exit 1; }
anet register --hub $HUB --token tm593 --username tm --password 'Rehearse593!' >/dev/null
UTOK=$(jq -r .token "$HOME/.anet/config.json"); NET=$(jq -r .network_id "$HOME/.anet/config.json")
mkdir -p "$HOME/.codex" && echo '{"OPENAI_API_KEY":"sk-fake-rehearsal-not-a-key"}' >"$HOME/.codex/auth.json"

# ── per-topology plumbing ────────────────────────────────────────────────────────────────────────
use() {  # use(script|anet)
  TOPO=$1; ALIAS=tm-$1; WORKDIR=/data/workspaces/project-$1; CFG=$WORKDIR/.anet/nodes/$ALIAS/config.json
  if [ "$TOPO" = script ]; then APPSRV_PAT="codex app-server --listen $BARE_URL"; else APPSRV_PAT="codex app-server -c"; fi
}
row() { curl -fsS "$HUB/api/status" -H "Authorization: Bearer $UTOK" | jq -c --arg a $ALIAS '[.sessions[]|select(.alias==$a)][0]'; }
health() { row | jq -c '{status, version, degraded: (.degraded // null), health}'; }
appsrv_pids() { pgrep -f "$APPSRV_PAT" | tr '\n' ' '; }
start_bare_appserver() { (setsid codex app-server --listen $BARE_URL >>/tmp/bare-appsrv.log 2>&1 &); for _ in $(seq 50); do [ -n "$(appsrv_pids)" ] && break; sleep 0.1; done; sleep 0.5; }
start_node() {
  : >/tmp/node-$ALIAS-$1.log
  if [[ "$TOPO" == script* ]]; then
    (cd "$WORKDIR" && setsid agent-node --config "$CFG" --alias $ALIAS >>/tmp/node-$ALIAS-$1.log 2>&1 &)
  else
    (cd "$WORKDIR" && setsid anet node start $ALIAS >>/tmp/node-$ALIAS-$1.log 2>&1 &)
  fi
  local t=$(now)
  for _ in $(seq 300); do [ "$(row | jq -r .status)" = idle ] && [ "$(row | jq -r .version)" != "${PREV_VERSION:-}" ] && break; sleep 0.5; done
  say "node up in $(( $(now) - t ))ms: hub version=$(row | jq -r .version) status=$(row | jq -r .status)"
  if [ "$(row | jq -r .status)" != idle ]; then say "FATAL node did not come up"; tail -40 /tmp/node-$ALIAS-$1.log; exit 1; fi
}
stop_node() {
  if [[ "$TOPO" == script* ]]; then pkill -f "agent-node --config $CFG"; else (cd "$WORKDIR" && anet node stop $ALIAS 2>&1 | tail -1); fi
  for _ in $(seq 40); do pgrep -f "alias $ALIAS" >/dev/null || break; sleep 0.25; done
  PREV_VERSION=$(row | jq -r .version)
}
dispatch() {  # dispatch(text) → prints task_id, or REJECTED:<http>:<error>
  local code
  code=$(curl -sS -o /tmp/dispatch.json -w '%{http_code}' -X POST "$HUB/api/task" -H "Authorization: Bearer $UTOK" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg a $ALIAS --arg t "$1" --arg n "$NET" '{alias:$a,task:$t,priority:"normal",network_id:$n}')")
  if [ "$code" = 200 ] || [ "$code" = 201 ]; then jq -r '.task_id // .message_id // empty' /tmp/dispatch.json
  else echo "REJECTED:$code:$(jq -r '.error // .code // empty' /tmp/dispatch.json 2>/dev/null | head -c 160)"; fi
}
wait_task() {  # wait_task(id, timeout_s) → "status<TAB>result"
  local id=$1 lim=${2:-90} r s
  [ -n "$id" ] || { printf 'no-task-id\t\n'; return; }
  for _ in $(seq $((lim*2))); do
    r=$(curl -fsS "$HUB/api/tasks?task_id=$id&network_id=$NET" -H "Authorization: Bearer $UTOK" | jq -c '.tasks[0]')
    s=$(jq -r .status <<<"$r")
    case "$s" in replied|completed|failed|cancelled|timeout|error) break;; esac
    sleep 0.5
  done
  printf '%s\t%s\n' "$s" "$(jq -r '(.result // .output // "")|tostring|.[0:200]' <<<"$r")"
}
run_task() {  # run_task(label, wait_s, accept_s) — dispatch (retrying while the Hub refuses it), wait, print
  local t1=$(now) id out rej=0 first_rej="" lim=${3:-60}
  while :; do
    id=$(dispatch "rehearsal: $1")
    case "$id" in REJECTED:*) rej=$((rej+1)); [ -z "$first_rej" ] && first_rej=$id
      if [ $(( $(now) - t1 )) -gt $((lim*1000)) ]; then
        say "TASK $1 → refused by the Hub for ${lim}s ($rej×: $first_rej)"; LAST_STATUS=refused; LAST_RESULT=$first_rej; return; fi
      sleep 0.5; continue;; esac
    break
  done
  [ $rej -gt 0 ] && say "TASK $1: Hub refused dispatch $rej× over $(( $(now) - t1 ))ms (${first_rej}), then accepted"
  out=$(wait_task "$id" "${2:-90}")
  LAST_STATUS=$(cut -f1 <<<"$out"); LAST_RESULT=$(cut -f2 <<<"$out")
  say "TASK $1 → $LAST_STATUS in $(( $(now) - t1 ))ms :: $LAST_RESULT"
}
ok_reply() { [ "$LAST_STATUS" = replied ] && grep -q FAKE_CODEX_OK <<<"$LAST_RESULT"; }

# ── scenarios ────────────────────────────────────────────────────────────────────────────────────
phase() {  # phase(old|new) → sets R_<scenario>
  local v=$1 p t
  run_task "$ALIAS-$v-baseline"
  check "$(ok_reply && echo ok)" "$ALIAS $v: baseline task answered by the app-server"
  say "hub row: $(health)"

  say "── $ALIAS $v [dead]: SIGKILL the app-server (pid $(appsrv_pids))"
  p=$(appsrv_pids); kill -9 $p; t=$(now); sleep 1
  say "hub row 1s after the kill: $(health)"
  run_task "$ALIAS-$v-dead-1" 90 30; R_DEAD1=$LAST_STATUS
  run_task "$ALIAS-$v-dead-2" 90 30; R_DEAD2=$LAST_STATUS
  say "app-server pids: $(appsrv_pids)(killed $p), $(( $(now) - t ))ms since the kill; hub row: $(health)"
  if [ "$TOPO" = script ] && [ -z "$(appsrv_pids)" ]; then
    say "nobody relaunched the bare app-server → relaunch it by hand (what the owner does today)"
    start_bare_appserver; t=$(now)
    run_task "$ALIAS-$v-after-manual-relaunch" 90 60; R_MANUAL=$LAST_STATUS
    say "recovered $(( $(now) - t ))ms after the manual relaunch; hub row: $(health)"
  fi

  say "── $ALIAS $v [hung]: SIGSTOP the app-server (alive, port open, never answers)"
  p=$(appsrv_pids); kill -STOP $p; t=$(now); sleep 1
  run_task "$ALIAS-$v-hung-1" 120 90; R_HUNG1=$LAST_STATUS
  run_task "$ALIAS-$v-hung-2" 120 90; R_HUNG2=$LAST_STATUS
  say "app-server pids: $(appsrv_pids)(hung $p, state=$(ps -o stat= -p $p 2>/dev/null || echo gone)), $(( $(now) - t ))ms since the hang; hub row: $(health)"
  kill -CONT $p 2>/dev/null; kill -9 $p 2>/dev/null; sleep 1
  [ "$TOPO" = script ] && [ -z "$(appsrv_pids)" ] && start_bare_appserver
  run_task "$ALIAS-$v-after-hung-cleared" 90 90; R_HUNG_AFTER=$LAST_STATUS

  if [ "$TOPO" = anet ]; then
    say "── $ALIAS $v [crash-loop]: every app-server launch dies at once (flag on), then the cause is fixed (flag off)"
    touch /tmp/fake-codex-crash; kill -9 $(appsrv_pids) 2>/dev/null; t=$(now); sleep 1
    run_task "$ALIAS-$v-crashloop-1" 90 30; R_CL1=$LAST_STATUS
    run_task "$ALIAS-$v-crashloop-2" 90 30; R_CL2=$LAST_STATUS
    say "hub row $(( $(now) - t ))ms into the crash-loop: $(health)"
    rm -f /tmp/fake-codex-crash; say "flag removed (cause fixed)"
    run_task "$ALIAS-$v-crashloop-fixed" 90 60; R_CLFIX=$LAST_STATUS
    say "hub row: $(health)"
  fi
}
mini_dead() {  # mini_dead(label) — baseline, SIGKILL the app-server, two tasks
  run_task "$ALIAS-$1-baseline"; local b=$LAST_STATUS
  local p=$(appsrv_pids); kill -9 $p; sleep 1
  run_task "$ALIAS-$1-dead-1" 90 30; local d1=$LAST_STATUS
  run_task "$ALIAS-$1-dead-2" 90 30
  say "app-server pids: $(appsrv_pids)(killed $p); hub row: $(health)"
  MINI="baseline=$b dead=$d1,$LAST_STATUS"
}
summary() { echo "dead=$R_DEAD1,$R_DEAD2${R_MANUAL:+ after-manual-relaunch=$R_MANUAL} hung=$R_HUNG1,$R_HUNG2 after-hung-cleared=$R_HUNG_AFTER${R_CL1:+ crashloop=$R_CL1,$R_CL2 after-fix=$R_CLFIX}"; }
node_log() { grep -E 'app-server|\[health\]|Cannot connect|错误|non-101|timed out' "$1" | grep -v 'task_started\|task_reply\|processing \[' | cut -c1-260 | tail -${2:-40}; }

# ════ STYLE 1: script (bare app-server + `agent-node --config`) ═══════════════════════════════════
use script
mkdir -p "$WORKDIR" && cd "$WORKDIR"
anet node create $ALIAS --runtime codex-app-server --model gpt-5.6-sol </dev/null >/tmp/create-$ALIAS.log 2>&1 || { cat /tmp/create-$ALIAS.log; exit 1; }
jq --arg u "$BARE_URL" '.codexAppServerUrl=$u' "$CFG" >"$CFG.tmp" && cat "$CFG.tmp" >"$CFG" && rm "$CFG.tmp"
start_bare_appserver
say "════ $ALIAS OLD: global agent-node $(agent-node --version 2>/dev/null | head -1)"
start_node old
R_MANUAL=; phase old; S_OLD=$(summary)
say "node log ($ALIAS, old):"; node_log /tmp/node-$ALIAS-old.log

say "════ $ALIAS UPGRADE: npm i -g @sleep2agi/agent-node@$NEW_NODE, restart the agent-node process (app-server left running)"
t=$(now); npm i -g "@sleep2agi/agent-node@$NEW_NODE" >/tmp/npm-node-new.log 2>&1 || { tail -20 /tmp/npm-node-new.log; exit 1; }
say "installed $(agent-node --version 2>/dev/null | head -1) in $(( $(now) - t ))ms"
stop_node; start_node new
check "$([ "$(row | jq -r .version)" = "$NEW_NODE" ] && echo ok)" "$ALIAS: hub reports agent-node $NEW_NODE after the restart"
R_MANUAL=; phase new; S_NEW=$(summary)
check "$(row | jq -e '.health.app_server != null' >/dev/null && echo ok)" "$ALIAS new: hub row carries health.app_server"
say "node log ($ALIAS, new):"; node_log /tmp/node-$ALIAS-new.log 60

say "════ $ALIAS OPTION: let the node own its app-server — drop codexAppServerUrl, stop the bare app-server, same agent-node command"
stop_node; pkill -f "$APPSRV_PAT"; sleep 0.5
jq 'del(.codexAppServerUrl)' "$CFG" >"$CFG.tmp" && cat "$CFG.tmp" >"$CFG" && rm "$CFG.tmp"
TOPO=script-owned APPSRV_PAT="codex app-server -c" PREV_VERSION=
start_node owned
mini_dead owned; S1_OWNED=$MINI
check "$([ "$LAST_STATUS" = replied ] && echo ok)" "$ALIAS (owned, $NEW_NODE): task after an app-server SIGKILL is answered"
node_log /tmp/node-$ALIAS-owned.log 12

say "════ $ALIAS ROLLBACK: npm i -g @sleep2agi/agent-node@$OLD_NODE, restart"
TOPO=script
stop_node; t=$(now); npm i -g "@sleep2agi/agent-node@$OLD_NODE" >/tmp/npm-node-rollback.log 2>&1 || { tail -20 /tmp/npm-node-rollback.log; exit 1; }
say "installed $(agent-node --version 2>/dev/null | head -1) in $(( $(now) - t ))ms"
start_node rollback
check "$([ "$(row | jq -r .version)" = "$OLD_NODE" ] && echo ok)" "$ALIAS rollback: hub reports $OLD_NODE"
run_task "$ALIAS-rollback-baseline"
check "$(ok_reply && echo ok)" "$ALIAS rollback: a task is answered on $OLD_NODE with the config the new version ran on"
stop_node; pkill -f 'codex app-server'
S1_OLD=$S_OLD S1_NEW=$S_NEW

# ════ STYLE 2: anet (`anet node create` + `anet node start`, headless, owned app-server) ══════════
use anet; PREV_VERSION=
mkdir -p "$WORKDIR" && cd "$WORKDIR"
anet node create $ALIAS --runtime codex-app-server --model gpt-5.6-sol </dev/null >/tmp/create-$ALIAS.log 2>&1 || { cat /tmp/create-$ALIAS.log; exit 1; }
say "════ $ALIAS OLD: anet $(anet --version 2>/dev/null | head -1); global agent-node is now $(agent-node --version 2>/dev/null | head -1)"
start_node old
check "$([ "$(row | jq -r .version)" = "$OLD_NODE" ] && echo ok)" "$ALIAS: anet $OLD_ANET starts its exact paired agent-node $OLD_NODE, not the newer global one"
R_MANUAL= R_CL1=; phase old; S_OLD=$(summary)
say "node log ($ALIAS, old):"; node_log /tmp/node-$ALIAS-old.log

say "════ $ALIAS UPGRADE: npm i -g @sleep2agi/agent-network@$NEW_ANET, then anet node stop/start"
t=$(now); npm i -g "@sleep2agi/agent-network@$NEW_ANET" >/tmp/npm-anet-new.log 2>&1 || { tail -20 /tmp/npm-anet-new.log; exit 1; }
say "installed $(anet --version 2>/dev/null | head -1) in $(( $(now) - t ))ms"
stop_node; start_node new
check "$([ "$(row | jq -r .version)" = "$NEW_NODE" ] && echo ok)" "$ALIAS: hub reports agent-node $NEW_NODE after the restart"
R_MANUAL= R_CL1=; phase new; S_NEW=$(summary)
check "$(row | jq -e '.health.app_server != null' >/dev/null && echo ok)" "$ALIAS new: hub row carries health.app_server"
say "node log ($ALIAS, new):"; node_log /tmp/node-$ALIAS-new.log 60

say "════ $ALIAS after 'gave up': only a restart reopens it (anet node stop + start)"
stop_node; PREV_VERSION=; start_node restart
run_task "$ALIAS-after-restart"
check "$(ok_reply && echo ok)" "$ALIAS: after a node restart the task is answered again"

say "════ anet node ls --all"
(cd "$WORKDIR" && anet node ls --all 2>&1 | head -20)

say "════ $ALIAS ROLLBACK: npm i -g @sleep2agi/agent-network@$OLD_ANET, then anet node stop/start"
stop_node; t=$(now); npm i -g "@sleep2agi/agent-network@$OLD_ANET" >/tmp/npm-anet-rollback.log 2>&1 || { tail -20 /tmp/npm-anet-rollback.log; exit 1; }
say "installed $(anet --version 2>/dev/null | head -1) in $(( $(now) - t ))ms"
start_node rollback
check "$([ "$(row | jq -r .version)" = "$OLD_NODE" ] && echo ok)" "$ALIAS rollback: hub reports $OLD_NODE"
run_task "$ALIAS-rollback-baseline"
check "$(ok_reply && echo ok)" "$ALIAS rollback: a task is answered on $OLD_NODE"
say "════ (end) anet node ls --all"
(cd "$WORKDIR" && anet node ls --all 2>&1 | head -20)

say "════ SUMMARY"
say "script old $OLD_NODE: $S1_OLD"
say "script new $NEW_NODE: $S1_NEW"
say "script→owned $NEW_NODE: $S1_OWNED"
say "anet   old $OLD_NODE: $S_OLD"
say "anet   new $NEW_NODE: $S_NEW"
echo "FAILS=$FAILS"
[ "$FAILS" -eq 0 ]
