#!/usr/bin/env bash
# #146 part 2 — the CLI restart choreography (stop → confirm dead → relaunch).
#
# The hub-side half was verified separately (docs/tests/p146-rerun-2026-07-30).
# This half exercises the two blockers a prior review raised against the fix:
#   R1 a process that IGNORES SIGTERM must be escalated to SIGKILL, and the
#      rename must not proceed while a survivor can still heartbeat the OLD
#      alias back into place.
#   R2 if the relaunch does not actually come up, the CLI must NOT report
#      success ("restarted + re-registered") — a false green here is worse
#      than a failure.
#
# Everything runs inside the container: hub from source on loopback, a fake
# HOME, a throwaway cwd. No host hub, no production database.
set -uo pipefail
export HOME=/work/home
W=/work; OUT=$W/out; mkdir -p "$OUT" "$HOME"
say(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT/cli.log"; }
run(){ local tag="$1"; shift; echo -e "\n===== $tag =====\n\$ $*" >> "$OUT/cli-evidence.log"; "$@" >> "$OUT/cli-evidence.log" 2>&1; local rc=$?; echo "(exit=$rc)" >> "$OUT/cli-evidence.log"; return $rc; }

VERDICTS=$OUT/cli-verdicts.txt; : > "$VERDICTS"
verdict(){ # name, ok(0/1), note
  local v="FAIL"; [ "$2" = "1" ] && v="PASS"
  echo "$v | $1 | $3" | tee -a "$VERDICTS"
}

# ── hub from source ─────────────────────────────────────────────────────
export COMMHUB_DB=$W/cli-hub.db PORT=9201 HOST=127.0.0.1
( cd /src/server && bun run src/index.ts > "$OUT/cli-hub.log" 2>&1 & echo $! > $W/hub.pid )
HUB=http://127.0.0.1:9201
for i in $(seq 1 60); do bun -e "fetch('$HUB/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break; sleep 0.5; done
say "hub up"

# ── identities via REST (same calls the CLI would make) ─────────────────
bun -e "
const HUB='$HUB';
const reg=await (await fetch(HUB+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'p146cli',password:'p146-cli-pass'})})).json();
const ntok=await (await fetch(HUB+'/api/auth/node-token',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+reg.token},body:JSON.stringify({network_id:reg.network_id,node_name:'before'})})).json();
await Bun.write('$W/ids.json', JSON.stringify({utok:reg.token,net:reg.network_id,ntok:ntok.token}));
" || { say "FATAL bootstrap"; exit 1; }
UTOK=$(bun -e "console.log((await Bun.file('$W/ids.json').json()).utok)")
NET=$(bun -e "console.log((await Bun.file('$W/ids.json').json()).net)")
NTOK=$(bun -e "console.log((await Bun.file('$W/ids.json').json()).ntok)")
say "ids ready net=$NET"

# CLI global config so `anet` talks to our throwaway hub.
mkdir -p "$HOME/.anet"
cat > "$HOME/.anet/config.json" <<JSON
{ "hub": "$HUB", "token": "$UTOK", "network_id": "$NET" }
JSON

cd $W/proj 2>/dev/null || { mkdir -p $W/proj; cd $W/proj; }
ANET="bun /src/agent-network/bin/cli.ts"

# ── build a node directory the way `anet node create` does ──────────────
run "anet node create before" $ANET node create before --runtime claude-agent-sdk --yes
ls -la .anet/nodes 2>/dev/null >> "$OUT/cli-evidence.log"
NODE_DIR=.anet/nodes/before
if [ ! -d "$NODE_DIR" ]; then
  say "node create did not produce $NODE_DIR — recording and continuing with a hand-built dir"
  mkdir -p "$NODE_DIR"
  cat > "$NODE_DIR/config.json" <<JSON
{ "node_name": "before", "alias": "before", "hub": "$HUB", "token": "$NTOK",
  "network_id": "$NET", "runtime": "claude-agent-sdk", "node_id": "node_cli_before" }
JSON
fi

# ── R1: a process that swallows SIGTERM ─────────────────────────────────
export HUB NTOK NET
NODE_ID=$(bun -e "console.log((await Bun.file('$NODE_DIR/config.json').json()).node_id || 'node_cli_before')")
# The process must look like a REAL agent to the CLI's finder, which
# (by design, #180 R1) only matches genuine agent executables and requires
# an `--alias <name>` argv pair — a substring match would risk killing
# unrelated processes. So: run from a path carrying the real package name
# and pass the same --alias the launcher does.
COMMHUB_ALIAS=before HUB=$HUB NTOK=$NTOK NETWORK_ID=$NET NODE_ID=$NODE_ID \
  ALIAS=before OUT=$OUT/deaf-agent.log PIDFILE=$NODE_DIR/.pid \
  bun /work/fakepkg/node_modules/@sleep2agi/agent-node/dist/cli.js --alias before &
DEAF=$!
sleep 3
say "deaf agent pid=$DEAF (writes $NODE_DIR/.pid, ignores SIGTERM, heartbeats 'before')"
echo "$DEAF" > $W/deaf.pid

run "anet node rename before after --force" timeout 120 $ANET node rename before after --force
RENAME_RC=$?
sleep 2

# R1 verdict: the SIGTERM-deaf process must be gone (escalated to SIGKILL).
if kill -0 "$DEAF" 2>/dev/null; then ALIVE=1; else ALIVE=0; fi
verdict "R1 SIGTERM-deaf old process is escalated to SIGKILL (no survivor)" \
  "$([ $ALIVE -eq 0 ] && echo 1 || echo 0)" "old_pid_alive=$ALIVE rename_exit=$RENAME_RC"

# R1b: with the survivor gone, the hub must not be holding the OLD alias.
sleep 3
bun -e "
const ids=await Bun.file('$W/ids.json').json();
const r=await fetch('$HUB/api/status?network_id='+ids.net,{headers:{Authorization:'Bearer '+ids.utok}});
const t=await r.text(); await Bun.write('$OUT/cli-status-after-rename.json',t); console.log(t.slice(0,400));
" >> "$OUT/cli-evidence.log" 2>&1
STALE=$(bun -e "
const t=await Bun.file('$OUT/cli-status-after-rename.json').text();
console.log(/\"alias\"\s*:\s*\"before\"/.test(t)?'1':'0');
")
verdict "R1b hub no longer reports the OLD alias as a live session" \
  "$([ "$STALE" = "0" ] && echo 1 || echo 0)" "stale_before_alias_present=$STALE"

# ── R2: did the CLI claim a successful relaunch it cannot back up? ──────
# In this container the relaunch cannot succeed (no tmux / no runtime creds).
# The requirement is that the CLI SAYS SO rather than printing a green.
EV=$OUT/cli-evidence.log
CLAIMED_OK=$(grep -ciE "restarted \+ re-registered|✅ .*re-?register" "$EV" || true)
ADMITTED=$(grep -ciE "left stopped|needs tmux|could not (start|restart)|❌|⚠" "$EV" || true)
verdict "R2 relaunch that cannot happen is reported honestly (no false green)" \
  "$([ "$CLAIMED_OK" = "0" ] && [ "$ADMITTED" != "0" ] && echo 1 || echo 0)" \
  "false_success_claims=$CLAIMED_OK honest_signals=$ADMITTED"

# ── routing after the CLI-driven rename ────────────────────────────────
bun -e "
const ids=await Bun.file('$W/ids.json').json();
async function mcp(tok,name,args){
  const r=await fetch('$HUB/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+tok},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  const t=await r.text(); const m=t.match(/data:\s*(\{.*\})/s);
  let inner=null; try{ inner=JSON.parse(JSON.parse(m?m[1]:t)?.result?.content?.[0]?.text??'null'); }catch{}
  return {t,inner};
}
const send=await mcp(ids.utok,'send_task',{alias:'after',task:'cli-case routing after CLI rename',priority:'normal',network_id:ids.net,from_session:'p146cli'});
await Bun.write('$OUT/cli-send.json', JSON.stringify(send.inner??send.t));
console.log(JSON.stringify(send.inner));
" >> "$EV" 2>&1
SENT=$(bun -e "
const t=await Bun.file('$OUT/cli-send.json').text();
console.log(/\"ok\"\s*:\s*true/.test(t)?'1':'0');
")
verdict "R3 after a CLI rename the hub accepts traffic for the NEW alias" \
  "$([ "$SENT" = "1" ] && echo 1 || echo 0)" "send_task_to_new_alias_ok=$SENT"

say "DONE"
cat "$VERDICTS"
kill -9 "$(cat $W/hub.pid)" 2>/dev/null || true
kill -9 "$DEAF" 2>/dev/null || true
