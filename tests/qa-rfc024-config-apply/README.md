# qa-rfc024-config-apply — RFC-024 §7.2 Docker e2e

End-to-end integration test for the **dashboard 改 node config 真生效** chain. Real hub from `server/` + real agent-node from `agent-node/` (NPM-installed globally from the LOCAL source under test) + real `anet node start` under launchAgent's W1 supervisor wrap, driven via curl /mcp as a mock dashboard.

## What it covers (live, no skip-escape)

### Contract surface (no W1, no running node)
- Hub boots + admin bootstrap + utok / ntok mint
- `update_node_config` enforces SEC-1 cross-network reject hub-side (#275 防护带 pattern at the API boundary, not just the SQL layer)
- `update_node_config` enforces SEC-2 admin-or-owner role gate for security-sensitive flags
- `update_node_config` enforces patch allowlist + range validation

### Restart-finalize real path — scenario 9
- `anet node start` under W1 supervisor wrap (cmd from `agent-network` installed globally from LOCAL source — not `npx @preview` fallback)
- Send restart-required patch (model swap) via `update_node_config` MCP tool
- agent-node receives SSE doorbell → validates → writes new config + .prev backup → ack restarting → drain → exit 75
- W1 catches exit 75 → re-spawns child (same config now)
- New child boots from new config → registers → reports status with snapshot
- Hub content-matches snapshot vs pending patch → `finalizePendingMatchingUpdates` fires → row → `applied`, `nodes.config_revision` bumps
- Test polls `/api/nodes/<id>/config`; **hard-FAILs** if revision doesn't bump within 100s budget (60s drain + 30s respawn + 10s slack)
- Per 通信龙's C BLOCKER catch: scenario 9 was previously skip-degrading when the Docker image lacked `anet` install. This Dockerfile now `npm pack` + `npm install -g` both `agent-node` and `agent-network` from the LOCAL trees before the test runs, AND `which anet` / `which agent-node` are sanity-checked at image build. Register timeout = hard FAIL, no skip-escape.

### Premature-finalize guard documentation — scenario 10
The drain-window false-positive guard is pinned at two layers — source-level conditional at `cli.ts:923` (`config_snapshot: configApplyDraining ? undefined : ...`) + a `buildConfigSnapshot`-stays-pure unit test that would break if anyone tried to fold drain detection into the helper. A real e2e of the heartbeat actually firing during drain would need timing coincidence with the 3-minute heartbeat interval, so this scenario is doc-only.

## What's still out of scope

- Hot patch + "next think reads new maxTurns" SDK-side assertion — needs a vendor key + a real think
- Drain-mid-kill resilience (heavy timing, vendor)
- Parseable-but-broken config (e.g. wrong model name accepted by validate, rejected by vendor on first think) — `applied` triggers because the config landed; runtime failure surfaces separately

These are tracked for longer-form QA matrix, not the per-PR gate.

## Run

```bash
# from repo root
docker build -f tests/qa-rfc024-config-apply/Dockerfile -t anet-rfc024-e2e .
docker run --rm anet-rfc024-e2e
```

Exit 0 = pass; non-zero = at least one assertion failed. Summary line reports `PASS=N FAIL=M SKIP=K`.

## Note on `applied` semantics

`status='applied'` means **the patch landed on the node's effective config** — `nodes.config_snapshot` reflects the new value, and the next think will read it via per-think accessors. It does NOT mean "the new config works at runtime". A parseable-but-broken patch (e.g. a model name the vendor will reject on the first call) lands `applied`, then subsequent think turns surface vendor errors separately. The validate-layer gates obvious schema issues; semantic-validity (model exists, vendor accepts) is out of pre-apply scope by design.
