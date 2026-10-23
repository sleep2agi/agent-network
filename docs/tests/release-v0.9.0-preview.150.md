# CommHub Server — daemon runtime version in the host-supervisor list, v0.9.0-preview.150

Ships `main` after `.149`. One additive read field; no behaviour change.

```
@sleep2agi/commhub-server@0.9.0-preview.150
```

## What changed

- **`GET /api/host-supervisors`** (and the MCP tool `list_host_supervisors`) now
  includes **`agent_node_version`** for each daemon — the version that daemon
  reported in its last `report_status`.

  Why it needed a join: nodes already send `version` in `report_status`
  (`agent-node` writes `AGENT_NODE_VERSION`) and the Hub stores it on the session
  row, which is why `/api/status` can show it. `nodes` has no version column, so
  the daemon list reads the newest session row for the same
  `(network_id, node_id)`.

- **Absent stays absent.** A daemon that never reported a version gets **no**
  field — not a default, not an empty string, not the Hub's own version. "Unknown"
  and "old" are different facts, and a client that shows a stale daemon as current
  is worse than one that says "unknown".

- Also in this release: the relay runbook gained the "two different 409s" table
  (`session_control_bridge_missing` vs `session_control_unavailable`, #2954) and
  `scripts/l1-shard.py` landed as the first CI step of #2136. Both are docs/CI
  only — no runtime change.

## What did not change

- No schema change, no migration.
- No new capability gate: the field is additive, and older clients ignore it.
- No upgrade action of any kind: this is a read-only version fact. Actually
  upgrading a daemon remains a separate, unauthorised action (#973 second slice).

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v150-preview150"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.150
```

## Upgrade

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v150-preview150"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.150"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point HUB_RUNTIME_DIR at $DIR, then reload
pm2 reload commhub-hub --update-env
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.150"'
```

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v149-preview149` and reload. No data
change is involved.

## Verification

- `server/src/host-supervisors-daemon-version.test.ts`: 3 pass (field present,
  **field absent when never reported**, newest session wins). Together with the
  existing host-supervisor suites: 36 pass / 0 fail.
- After publishing: `scripts/verify-hub-release.sh 0.9.0-preview.150` must PASS.
