#!/usr/bin/env bash
# Real-machine daemon acceptance — 查看 / 创建 / 编辑 / 操作 / 删除 一个节点
# against a REAL daemon registered on the PRODUCTION hub.
#
# 🔴 THIS SCRIPT TOUCHES PRODUCTION. Read the guard section before running.
#
# Scope (Vincent's goal): prove that from a client one can 查看/创建/编辑/
# 删除/操作 nodes on a real host daemon (daemon-relay / daemon-macmini).
#
# What it does NOT do, on purpose:
#   · never touches an existing node — it creates ONE temporary child of its
#     own and only ever addresses that one by the node_id it recorded
#   · never asserts anything file-level or process-level. The child runs on
#     another machine; the container e2e (tests/qa-daemon-lifecycle-e2e) can
#     stat its config.json and pgrep its process only because it shares a
#     filesystem and PID namespace with the child. Claiming the same here
#     without SSH would be asserting something weaker and calling it equal.
#     Config application is therefore judged at the hub's contract surface,
#     and that limitation is PRINTED, not hidden.
#
# Exit codes follow deploy/check-deployed-copies.sh:
#   0 = acceptance passed
#   1 = a step failed (real finding)
#   2 = refused to run / cannot judge (fail-closed)
#
# ── judge criteria come from tests/lib/daemon-hub-assertions.sh, the same
#    file tests/qa-daemon-lifecycle-e2e is to source once #1280 lands. Two
#    scripts calling one function cannot drift; two scripts "asserting the
#    same thing" always do.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
LIB="$REPO_ROOT/tests/lib/daemon-hub-assertions.sh"
[[ -f "$LIB" ]] || { echo "::error::judge library missing: $LIB — refusing (cannot判断)"; exit 2; }
# shellcheck disable=SC1090
source "$LIB"

# ── defaults: everything that writes is OFF ──────────────────────────
MODE="dryrun"            # dryrun | execute
HUB=""                   # must be passed explicitly; no env fallback
TOKEN_ENV="ANET_ACCEPT_UTOK"
DAEMON_NAME=""
AUTHORIZED_BY=""
NETWORK_ID=""
EXTRA_ALLOWED_DAEMON=""

# 🔴 Allow-list of daemons this script may target. A typo in --daemon must
# not silently point the run at some other machine's supervisor.
ALLOWED_DAEMONS=("daemon-relay" "daemon-macmini")

usage() {
  cat <<USAGE
Usage:
  $0 --hub <url> --daemon <name> [--network <id>] [--selftest]
  $0 --hub <url> --daemon <name> --execute --i-am-authorized-by <who>

  --hub <url>                REQUIRED. Full base URL of the target hub.
                             No environment fallback on purpose: a default
                             would let a mistyped flag hit production.
  --daemon <name>            REQUIRED. One of: ${ALLOWED_DAEMONS[*]}
  --network <id>             Network id to scope calls to (optional).
  --execute                  Perform writes. Without it NOTHING is written.
  --i-am-authorized-by <who> REQUIRED with --execute. Recorded in the report.
  --allow-daemon <name>      Extend the allow-list for this run (explicit).
  --selftest                 Verify the guards themselves. Contacts no hub.

  Token is read from \$$TOKEN_ENV (never a flag — flags land in shell history
  and in ps output).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --daemon) DAEMON_NAME="${2:-}"; shift 2 ;;
    --network) NETWORK_ID="${2:-}"; shift 2 ;;
    --execute) MODE="execute"; shift ;;
    --i-am-authorized-by) AUTHORIZED_BY="${2:-}"; shift 2 ;;
    --allow-daemon) EXTRA_ALLOWED_DAEMON="${2:-}"; shift 2 ;;
    --selftest) MODE="selftest"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "::error::unknown argument: $1"; usage; exit 2 ;;
  esac
done

PASS=0; FAIL=0
note() { printf "\n=== %s ===\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
refuse() { echo "::error::REFUSING — $*"; exit 2; }

daemon_is_allowed() {
  local want="$1" d
  [[ -n "$EXTRA_ALLOWED_DAEMON" && "$want" == "$EXTRA_ALLOWED_DAEMON" ]] && return 0
  for d in "${ALLOWED_DAEMONS[@]}"; do [[ "$d" == "$want" ]] && return 0; done
  return 1
}

# ── guard self-test — no hub contacted ───────────────────────────────
# 🔴 A guard that has never been seen refusing is not known to refuse.
if [[ "$MODE" == "selftest" ]]; then
  note "guard selftest (contacts no hub)"
  SPASS=0; SFAIL=0
  # 🔴 print the ARGUMENT, not just the function name. With only "$1" every
  # line reads "daemon_is_allowed" and the output is byte-identical no matter
  # what the allow-list contains — a green that cannot be told from a broken one.
  st() { if "$@" >/dev/null 2>&1; then printf "  ✗ [%s] guard did NOT fire — this input would be ACCEPTED\n" "$*"; SFAIL=$((SFAIL+1));
         else printf "  ✓ [%s] correctly refused\n" "$*"; SPASS=$((SPASS+1)); fi; }
  stn(){ if "$@" >/dev/null 2>&1; then printf "  ✓ [%s] correctly accepted\n" "$*"; SPASS=$((SPASS+1));
         else printf "  ✗ [%s] guard fired on a VALID input\n" "$*"; SFAIL=$((SFAIL+1)); fi; }

  st  daemon_is_allowed "daemon-relayy"          # typo must not pass
  st  daemon_is_allowed "daemon-macmini-old"     # prefix of an allowed name
  st  daemon_is_allowed ""                       # empty
  st  daemon_is_allowed "prod-hub"               # unrelated node
  stn daemon_is_allowed "daemon-relay"           # the real thing must pass
  stn daemon_is_allowed "daemon-macmini"

  # temp child naming must be unique per run and carry the acceptance prefix,
  # because the cleanup step keys on that prefix as a second safety net.
  N1=$(printf 'acc-%s-%s' "$(date +%s)" "$RANDOM")
  N2=$(printf 'acc-%s-%s' "$(date +%s)" "$RANDOM")
  if [[ "$N1" == acc-* && "$N2" == acc-* && "$N1" != "$N2" ]]; then
    printf "  ✓ temp child names are prefixed and unique (%s != %s)\n" "$N1" "$N2"; SPASS=$((SPASS+1))
  else
    printf "  ✗ temp child naming is not unique — cleanup could target the wrong node\n"; SFAIL=$((SFAIL+1))
  fi

  # the set-difference used to prove "left nothing behind" must actually
  # notice an extra id; a comparison that always says "equal" would make the
  # cleanup proof vacuous.
  BEFORE=$'node_a\nnode_b'; AFTER_OK=$'node_a\nnode_b'; AFTER_BAD=$'node_a\nnode_b\nnode_c'
  [[ "$(comm -13 <(echo "$BEFORE") <(echo "$AFTER_OK"))" == "" ]] \
    && { printf "  ✓ residue check: identical sets → no residue\n"; SPASS=$((SPASS+1)); } \
    || { printf "  ✗ residue check flagged an identical set\n"; SFAIL=$((SFAIL+1)); }
  [[ "$(comm -13 <(echo "$BEFORE") <(echo "$AFTER_BAD"))" == "node_c" ]] \
    && { printf "  ✓ residue check: extra node_c detected\n"; SPASS=$((SPASS+1)); } \
    || { printf "  ✗ residue check MISSED a leftover node — cleanup proof would be vacuous\n"; SFAIL=$((SFAIL+1)); }

  printf "\n  selftest PASS=%d FAIL=%d\n" "$SPASS" "$SFAIL"
  [[ "$SFAIL" -eq 0 ]] && { echo "SELFTEST: PASS"; exit 0; } || { echo "SELFTEST: FAIL"; exit 1; }
fi

# ── guards ───────────────────────────────────────────────────────────
note "guards"
[[ -n "$HUB" ]] || refuse "--hub is required (no default: a default would let a typo hit production)"
[[ "$HUB" =~ ^https?:// ]] || refuse "--hub must be a full URL, got '$HUB'"
[[ -n "$DAEMON_NAME" ]] || refuse "--daemon is required"
daemon_is_allowed "$DAEMON_NAME" || refuse "daemon '$DAEMON_NAME' is not in the allow-list (${ALLOWED_DAEMONS[*]}); pass --allow-daemon to extend deliberately"
UTOK="${!TOKEN_ENV:-}"
[[ -n "$UTOK" ]] || refuse "\$$TOKEN_ENV is empty — cannot authenticate"
[[ "$UTOK" == utok_* ]] || refuse "\$$TOKEN_ENV does not look like a user token"
if [[ "$MODE" == "execute" ]]; then
  [[ -n "$AUTHORIZED_BY" ]] || refuse "--execute requires --i-am-authorized-by <who> (recorded in the report)"
fi
ok "flags validated (mode=$MODE daemon=$DAEMON_NAME)"

hub_reachable "$HUB" || refuse "hub $HUB is not reachable (/health) — cannot judge"
ok "hub reachable: $HUB"

# ── P0. identify the daemon, and prove it is the right KIND of thing ──
note "P0. target daemon identity"
DAEMON_NODE_ID=$(curl -sS --max-time 20 "$HUB/api/nodes" -H "Authorization: Bearer $UTOK" \
  | jq -r --arg n "$DAEMON_NAME" '.nodes[]? | select(.node_name==$n or .alias==$n) | .node_id' | head -1)
[[ -n "$DAEMON_NODE_ID" ]] || refuse "daemon '$DAEMON_NAME' not found on $HUB — wrong hub, or it is not registered"
ok "resolved $DAEMON_NAME → $DAEMON_NODE_ID"
hub_role_is "$HUB" "$UTOK" "$DAEMON_NODE_ID" "host_supervisor" \
  || refuse "'$DAEMON_NAME' is not a host_supervisor — refusing to send create_node to a non-daemon node"
ok "role=host_supervisor confirmed (config_snapshot.role)"

# ── P0.5 baseline snapshot — the ONLY way to later prove we left nothing ──
note "P0.5 baseline node set"
BEFORE_SET=$(hub_node_id_set "$HUB" "$UTOK")
BEFORE_N=$(printf '%s\n' "$BEFORE_SET" | grep -c . || true)
[[ "$BEFORE_N" -gt 0 ]] || refuse "baseline node set is empty — 0 nodes and 'could not read nodes' print identically; refusing (fail-closed)"
ok "baseline: $BEFORE_N node(s) recorded"

NET_ARG=""
[[ -n "$NETWORK_ID" ]] && NET_ARG=",\"network_id\":\"$NETWORK_ID\""

CHILD_NAME="acc-$(date +%s)-$RANDOM"
CHILD_NODE_ID=""        # set only after create; cleanup keys on THIS value
CREATED=0

# 🔴 cleanup addresses exactly the node_id this run created, and refuses to
# act if that variable is empty or does not carry our prefix. It never
# enumerates-and-deletes, because an enumeration that goes wrong deletes
# someone else's node.
cleanup() {
  [[ "$CREATED" -eq 1 && -n "$CHILD_NODE_ID" ]] || return 0
  if ! hub_node_exists "$HUB" "$UTOK" "$CHILD_NODE_ID"; then return 0; fi
  echo "  · cleanup: removing $CHILD_NODE_ID ($CHILD_NAME)"
  mcp_call "delete_node" "{\"node_id\":\"$CHILD_NODE_ID\",\"confirm_alias\":\"$CHILD_NAME\"$NET_ARG}" >/dev/null 2>&1
}
trap cleanup EXIT

mcp_call() {
  local tool="$1" args="$2" resp inner
  if [[ "$MODE" != "execute" ]]; then
    echo "{\"dryrun\":true,\"tool\":\"$tool\"}"; return 0
  fi
  resp=$(curl -sS --max-time 30 -X POST "$HUB/mcp" -H "Authorization: Bearer $UTOK" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$RANDOM,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}")
  inner=$(echo "$resp" | grep -oP '(?<=data: ).+' | head -1 | jq -r '.result.content[0].text' 2>/dev/null)
  [[ -z "$inner" || "$inner" == "null" ]] && inner=$(echo "$resp" | jq -r '.result.content[0].text' 2>/dev/null)
  [[ -z "$inner" || "$inner" == "null" ]] && echo "$resp" || echo "$inner"
}

if [[ "$MODE" != "execute" ]]; then
  note "DRY RUN — no write will be issued"
  cat <<PLAN
  Would run, against $HUB, daemon $DAEMON_NAME ($DAEMON_NODE_ID):
    P1 查看   list nodes (read-only, already done above)
    P2 创建   create_node → temp child "$CHILD_NAME"
    P3 编辑   update_node_config on that child only
    P4 操作   restart_node on that child only
    P5 停止   stop_node   (arg name is child_node_id — see issue #1281)
    P6 删除   delete_node (confirm_alias="$CHILD_NAME")
    P7 证明   node-id set must equal the $BEFORE_N recorded above, exactly

  Re-run with:  --execute --i-am-authorized-by <who>
PLAN
  echo; echo "RESULT: DRY-RUN OK (nothing written)"; exit 0
fi

# ── P1..P7 (execute mode) ────────────────────────────────────────────
note "P1. 查看 — node list is readable"
ok "listed $BEFORE_N node(s) (read-only)"

note "P2. 创建 — create_node (temp child only)"
CREATE_RESP=$(mcp_call "create_node" "{\"daemon_node_id\":\"$DAEMON_NODE_ID\",\"node_spec\":{\"name\":\"$CHILD_NAME\",\"runtime\":\"claude-agent-sdk\",\"model\":\"claude-opus-original\",\"flags\":{\"maxTurns\":7}}$NET_ARG}")
REQ_ID=$(echo "$CREATE_RESP" | jq -r '.request_id // empty')
if [[ -z "$REQ_ID" ]]; then bad "create_node failed: $CREATE_RESP"; echo "RESULT: FAIL"; exit 1; fi
CHILD_NODE_ID="node_${REQ_ID#cr_}"; CREATED=1
ok "dispatched; child node_id = $CHILD_NODE_ID"
hub_wait_until 90 hub_node_exists "$HUB" "$UTOK" "$CHILD_NODE_ID" \
  && ok "child registered with hub" || bad "child never registered within 90s"

note "P3. 编辑 — update_node_config"
UPD=$(mcp_call "update_node_config" "{\"node_id\":\"$CHILD_NODE_ID\",\"base_revision\":0,\"patch\":{\"flags\":{\"maxTurns\":99}}$NET_ARG}")
UPD_ID=$(echo "$UPD" | jq -r '.update_id // empty')
[[ -n "$UPD_ID" ]] && ok "hub accepted patch (apply_mode=$(echo "$UPD" | jq -r '.apply_mode // "?"') update_id=$UPD_ID)" \
  || bad "update_node_config rejected: $UPD"
# 🔴 Honest scope note, printed rather than quietly skipped.
if hub_wait_until 60 bash -c "[[ \"\$(hub_node_field '$HUB' '$UTOK' '$CHILD_NODE_ID' '.nodes[0].config_snapshot.flags.maxTurns')\" == '99' ]]"; then
  ok "hub's config_snapshot converged to maxTurns=99 (child reported it back)"
else
  echo "  · NOT PROVEN HERE: the child's on-disk config was not read."
  echo "    config_snapshot did not surface flags.maxTurns within 60s. That may mean"
  echo "    the hub does not mirror this flag, not that the patch failed."
  echo "    On-disk application is proven in tests/qa-daemon-lifecycle-e2e (container,"
  echo "    same filesystem). Proving it HERE requires SSH to $DAEMON_NAME — out of scope."
fi

note "P4. 操作 — restart_node"
RST=$(mcp_call "restart_node" "{\"node_id\":\"$CHILD_NODE_ID\"$NET_ARG}")
echo "$RST" | jq -e '.ok == true or (.request_id|length>0)' >/dev/null 2>&1 \
  && ok "restart_node accepted" || bad "restart_node failed: $RST"
hub_wait_until 90 hub_lifecycle_is "$HUB" "$UTOK" "$CHILD_NODE_ID" "active" \
  && ok "lifecycle_state=active after restart" || bad "lifecycle_state did not return to active"

note "P5. 停止 — stop_node"
# arg is child_node_id here but node_id above — see issue #1281.
STOP=$(mcp_call "stop_node" "{\"child_node_id\":\"$CHILD_NODE_ID\",\"force\":true$NET_ARG}")
echo "$STOP" | jq -e '.ok == true or (.request_id|length>0)' >/dev/null 2>&1 \
  && ok "stop_node accepted" || bad "stop_node failed: $STOP"
hub_wait_until 90 hub_lifecycle_is "$HUB" "$UTOK" "$CHILD_NODE_ID" "stopped" \
  && ok "hub TERMINAL state lifecycle_state=stopped" || bad "lifecycle_state never became stopped"

note "P6. 删除 — delete_node"
DEL=$(mcp_call "delete_node" "{\"node_id\":\"$CHILD_NODE_ID\",\"confirm_alias\":\"$CHILD_NAME\"$NET_ARG}")
echo "$DEL" | jq -e '.ok == true' >/dev/null 2>&1 && ok "delete_node accepted" || bad "delete_node failed: $DEL"
hub_wait_until 60 bash -c "! hub_node_exists '$HUB' '$UTOK' '$CHILD_NODE_ID'" \
  && { ok "child row gone from hub"; CREATED=0; } || bad "child row still present after delete"

# ── P7. residue proof — the point of the whole guard design ───────────
note "P7. 证明没留下任何东西"
AFTER_SET=$(hub_node_id_set "$HUB" "$UTOK")
EXTRA=$(comm -13 <(printf '%s\n' "$BEFORE_SET") <(printf '%s\n' "$AFTER_SET"))
MISSING=$(comm -23 <(printf '%s\n' "$BEFORE_SET") <(printf '%s\n' "$AFTER_SET"))
[[ -z "$EXTRA" ]] && ok "no node added that was not there before" \
  || bad "LEFTOVER node(s): $(echo "$EXTRA" | tr '\n' ' ')"
[[ -z "$MISSING" ]] && ok "no pre-existing node disappeared" \
  || bad "🔴 PRE-EXISTING node(s) VANISHED: $(echo "$MISSING" | tr '\n' ' ')"

note "Result"
echo "  authorized_by=$AUTHORIZED_BY  hub=$HUB  daemon=$DAEMON_NAME"
echo "  PASS=$PASS  FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]] && { echo "RESULT: PASS"; exit 0; } || { echo "RESULT: FAIL ($FAIL)"; exit 1; }
