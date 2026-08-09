#!/usr/bin/env bash

# Select the same network that the Base E2E MCP helper injects into writes.
# Login alone leaves legacy/default selection state in place; node creation
# must never infer a different network from that stale state.
e2e_select_network() {
  local network_id=${1:?network_id is required}
  anet network use "$network_id" >/dev/null || return 1
  true
}

# Create the fixture through the public CLI so its config carries the same
# stable node_id + ntok_ binding as a real node. Hand-written or alias-only
# configs bypass the identity contract that the E2E suite is meant to test.
e2e_create_agent() {
  local alias=${1:?alias is required}
  local runtime=${2:?runtime is required}
  local model=${3:?model is required}
  local network_id=${4:?network_id is required}
  local config_path="$(pwd)/.anet/nodes/$alias/config.json"

  anet node create "$alias" --runtime "$runtime" --model "$model" >/dev/null || return 1
  [[ -f "$config_path" ]] || return 1
  e2e_config_token_bound_to_network "$config_path" "$network_id"
}

# Node configs intentionally do not persist network_id: the ntok_ binding in
# Hub is authoritative. Ask Hub with that token and require exactly the
# expected single network instead of trusting a local snapshot field.
e2e_config_token_bound_to_network() {
  local config_path=${1:?config path is required}
  local expected_network=${2:?network_id is required}
  local hub token networks

  hub=$(jq -r '.hub // empty' "$config_path") || return 1
  token=$(jq -r '.token // empty' "$config_path") || return 1
  [[ $hub == http://* || $hub == https://* ]] || return 1
  [[ $token == ntok_* ]] || return 1
  networks=$(curl -fsS "$hub/api/networks" -H "Authorization: Bearer $token") || return 1

  python3 - "$config_path" "$expected_network" "$networks" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
expected_network = sys.argv[2]
document = json.loads(sys.argv[3])
networks = document.get("networks", [])
valid = (
    isinstance(config.get("node_id"), str)
    and config["node_id"].startswith("n_")
    and isinstance(config.get("token"), str)
    and config["token"].startswith("ntok_")
    and len(networks) == 1
    and networks[0].get("network_id") == expected_network
)
raise SystemExit(0 if valid else 1)
PY
}

# Consume one /api/status document and succeed only for the exact alias.
# Printing `found`/`not_found` and grepping `found` recreated the same class of
# false-green fixed in Layer 3, because `not_found` contains the substring.
e2e_status_has_alias() {
  local alias=${1:?alias is required}
  python3 -c '
import json
import sys

alias = sys.argv[1]
document = json.load(sys.stdin)
sessions = document.get("sessions", [])
raise SystemExit(0 if any(s.get("alias") == alias for s in sessions) else 1)
' "$alias"
}
