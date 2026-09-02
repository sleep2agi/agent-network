#!/usr/bin/env bash
# Hub-side terminal-state assertions for daemon node lifecycle.
#
# WHY THIS FILE EXISTS
# These predicates started life inside tests/qa-daemon-lifecycle-e2e/run.sh
# (#1280). They are extracted here so the container e2e and the real-machine
# acceptance script judge node state with THE SAME criterion rather than two
# lookalikes written months apart. When two scripts "assert the same thing"
# by convention, they drift; when they call the same function, they cannot.
#
# 🔴 Follow-up once #1280 lands: change tests/qa-daemon-lifecycle-e2e/run.sh
# to source this file too. Until then the e2e keeps its own copies and the
# sameness is by inspection, not by mechanism — which is exactly the weaker
# guarantee this file exists to replace.
#
# SCOPE — read this before reusing.
# Everything here judges the HUB's view. It deliberately contains no
# file-level or process-level predicate, because those cannot be evaluated
# for a node running on another machine: the e2e can stat the child's
# config.json and pgrep its process only because container and child share
# a filesystem and a PID namespace. A real-machine run would need SSH to the
# target host to make the same claims. Do not paper over that difference by
# asserting something weaker and calling it equivalent.
#
# Contract: every function takes the hub base URL and a user token as its
# first two arguments — no globals — so a caller cannot accidentally judge
# one hub while believing it judged another.

# Raw single field of one node, or the empty string. Never fails the caller;
# an unreachable hub and a missing field both yield "" — so callers that need
# to tell those apart must check reachability separately (see hub_reachable).
hub_node_field() {
  local base="$1" tok="$2" node_id="$3" jqpath="$4"
  curl -sS --max-time 15 "$base/api/nodes?node_id=$node_id" \
    -H "Authorization: Bearer $tok" 2>/dev/null \
    | jq -r "$jqpath // empty" 2>/dev/null
}

hub_reachable() {
  local base="$1"
  curl -fsS --max-time 10 "$base/health" >/dev/null 2>&1
}

hub_node_exists() {
  local base="$1" tok="$2" node_id="$3"
  [[ -n "$(hub_node_field "$base" "$tok" "$node_id" '.nodes[0].node_id')" ]]
}

# lifecycle_state is the terminal state stop_node/restart_node converge to.
# Same predicate the e2e uses for its red gate (asserted BEFORE stop, where
# it must be false) and for its green assertion (asserted after).
hub_lifecycle_is() {
  local base="$1" tok="$2" node_id="$3" want="$4"
  [[ "$(hub_node_field "$base" "$tok" "$node_id" '.nodes[0].lifecycle_state')" == "$want" ]]
}

# 🔴 The daemon's role is NOT nodes[0].role — it lands in config_snapshot,
# which the daemon reports AFTER registering. Reading the wrong field yields
# "" and looks exactly like "the product did not set a role". The fallback to
# .role is kept only so a hub that later promotes the field keeps working.
hub_role_is() {
  local base="$1" tok="$2" node_id="$3" want="$4"
  [[ "$(hub_node_field "$base" "$tok" "$node_id" '.nodes[0].config_snapshot.role // .nodes[0].role')" == "$want" ]]
}

# Poll until a predicate holds. Returns 1 on timeout — callers must not
# treat a timeout as success. Prints nothing; the caller reports.
hub_wait_until() {
  local timeout="$1"; shift
  local i
  for ((i=0; i<timeout; i++)); do
    "$@" && return 0
    sleep 1
  done
  return 1
}

# The full set of node_ids the hub currently knows about, sorted, one per
# line. Used to prove an acceptance run left nothing behind: comparing this
# before and after is a claim about REALITY, whereas "we called delete_node"
# is only a claim about what we asked for.
hub_node_id_set() {
  local base="$1" tok="$2"
  curl -sS --max-time 20 "$base/api/nodes" -H "Authorization: Bearer $tok" 2>/dev/null \
    | jq -r '.nodes[]?.node_id' 2>/dev/null | sort
}
