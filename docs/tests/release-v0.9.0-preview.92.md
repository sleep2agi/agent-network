# CommHub v0.9.0-preview.92

This release carries the Hub changes merged since `0.9.0-preview.91`. Production is on `0.9.0-preview.91`. It is built from main at 609d32c9.

- #2271 (609d32c9) **Node permissions, phase 1 (RFC-041, #487).**
  - A node's permissions are its owner's permissions narrowed by the node's mode. Human-only actions (deleting tasks, managing projects, members, roles, departments and permissions) are never allowed for a node token.
  - New flag `COMMHUB_NODE_PERMISSIONS` = `log` (default; also used when unset or misspelled) | `enforce` | `off`. In `log`, a normal-mode node is never blocked; each would-be denial is merged into `node_permission_log`, one row per (network, node, route, reason, hour). `enforce` returns `403 node_permission_denied` (REST and MCP) with `reason`, `route` and `hint`. `off` neither evaluates nor logs normal-mode nodes.
  - New per-node mode `nodes.permission_mode` (`normal` default, `readonly`, `restricted`). An owner-set `readonly` or `restricted` mode is enforced regardless of the flag. Every existing node starts as `normal`, so nothing is blocked at upgrade.
  - `PUT /api/nodes/:id/permission-mode`: node owner, network owner/admin or Hub admin, user tokens only, audited as `node_permission_mode_changed`. Department heads cannot change it.
  - `GET /api/networks/:id/node-permission-report?since=` (owner/admin): would-have-blocked counts per node by reason and route, default window 7 days.
  - Log retention 30 days, pruned at most hourly, capped at 20,000 rows; a failed log write never affects the request.

Migration: additive only — a new column `nodes.permission_mode TEXT NOT NULL DEFAULT 'normal'` and a new table `node_permission_log`. No existing column changes.

Checked in Docker with `tests/hub-release-compat`, candidate 609d32c9a8ddebd5582a5452599feb5042fcadb2, baseline `0.9.0-preview.91` from npm, apps 0.2.166 / 0.2.181 / 0.2.195, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each. MCP `tools/list`: 74 → 74 tools, no incompatible change, no new params.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.
- The old-app owner coercion tests plus the node-permission tests (`requirements-http`, `requirements-owner-strict-mcp-http`, `node-permissions-http`) pass on the candidate: 41/41.
- The packed server (`npm pack` of `server/` at the candidate, global install into a throwaway prefix) starts and answers `/health` immediately.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.92`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.92
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.92
```

The new column and table are created on first start. With `COMMHUB_NODE_PERMISSIONS` unset the Hub only logs; existing MCP and REST callers keep working.

## Rolling back

`0.9.0-preview.91` starts on a database that `.92` has run on: it ignores `nodes.permission_mode` and `node_permission_log`. Any owner-set `readonly` / `restricted` node mode stops being enforced after a rollback.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
