# qa-rfc024-config-apply — RFC-024 §7.2 Docker e2e

End-to-end integration test for the **dashboard 改 node config 真生效** chain. Real hub from `server/` (PR A code under test) + real agent-node from `agent-node/` (PR B code under test), driven via curl /mcp as a mock dashboard.

## What it proves today (no W1 dependency)

- Hub boots + admin bootstrap + utok / ntok minting (the contract-surface plumbing)
- `update_node_config` enforces SEC-1 cross-network reject hub-side (#275 防护带 pattern at the API boundary, not just the SQL layer)
- `update_node_config` enforces SEC-2 admin-or-owner role gate for security-sensitive flags (admin can flip, stranger network user 403's)
- `update_node_config` enforces patch allowlist + range validation (bad maxTurns → `invalid_patch`)

## What's stubbed (`skip`) pending W1

- Hot patch end-to-end (POST → ack applied <3s → file write + in-process flag swap)
- Restart patch end-to-end (POST → ack restarting → exit 75 → re-spawn → ack applied <15s, PID changed)
- Drain-mid-kill resilience

These three need the W1 parent-supervisor wrap (depends on PR #284 `superviseChild` helper). Each `skip` carries an inline impl plan so the next iteration is mechanical — write a tmp config, `bun run agent-node/src/cli.ts`, poll the apply state, assert.

## Run

```bash
# from repo root
docker build -f tests/qa-rfc024-config-apply/Dockerfile -t anet-rfc024-e2e .
docker run --rm anet-rfc024-e2e
```

Exit 0 = pass; non-zero = at least one assertion failed. The summary line reports `PASS=N FAIL=M SKIP=K`.

## Why a skeleton now (not "wait for W1")

通信龙 dispatch 2026-06-28: "introspection ≠ capability — #288 CLI 哑炮 was the lesson". The skeleton lets us:
1. Catch contract-surface regressions immediately (today)
2. Have the full e2e ready to flip live the moment W1 lands (10 minutes to remove `skip` markers + fill the impl per the inline plans)
3. Ship preview2 with the "dashboard 改配置真生效" claim backed by a real integration test, not just unit tests of pure helpers

## Follow-up tasks (post-W1)

- Replace each `skip` block with the impl from its inline plan
- Add a 7th scenario: PINNED PR A's `restart_node` MCP tool drives the same restart-only path the W1 sentinel handles
- Wire into the release-gate workflow (`.github/workflows/release.yml`) so every preview tag fires this e2e
