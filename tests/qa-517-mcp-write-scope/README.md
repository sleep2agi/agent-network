# qa-517-mcp-write-scope

Docker e2e for #517 / PR #519 — MCP write-path network resolution,
exercised through the **real authenticated chain** (the unit suite in
`server/src/mcp-write-network-resolution.test.ts` injects auth context
directly into `registerTools`; this suite does not):

```
/api/auth/register → /api/auth/login (utok_, current_network=null)
  → POST /mcp  (requireAuth → resolveRequestAuth → createServer)
```

Layers (env → auth → single write → multi-network → deleted-network → roles):

| layer | asserts |
|---|---|
| L1 | login yields `utok_` with `current_network=null` — the exact #517 precondition |
| L3 | single-network utok `send_task`/`send_message` succeed **without** `network_id`; task row lands in the right network |
| L4 | 2 networks → exact `network_id_required` + "spans 2 networks" message; explicit `network_id` works |
| L5 | deleting a network removes its memberships — auto-resolve works again (codex P2) |
| L6 | viewer (sole membership via invite) → exact `permission_denied` viewer wording |
| L7 | explicit foreign `network_id` → exact `access_denied` |
| L8 | zero memberships → exact `network_id_required` no-membership wording; no orphaned rows |

All error assertions match **both** `error` and `message` exactly.

Run:

```bash
sg docker -c 'docker build -f tests/qa-517-mcp-write-scope/Dockerfile -t qa-517-mcp-write-scope .'
sg docker -c 'docker run --rm qa-517-mcp-write-scope'
```

Reports: `docs/tests/report-qa-517.txt` (fix branch, 22/22 PASS) and
`docs/tests/report-qa-517-red-baseline.txt` (same suite against
origin/main's server: 11 FAIL — proves the suite detects the pre-fix
behavior, including the old misleading error text).

ntok_ zero-change pins are covered in the unit suite (they need a minted
network token; unit layer injects it, keeping this suite server-API-only).
