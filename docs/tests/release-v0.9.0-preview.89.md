# CommHub v0.9.0-preview.89

This release carries the Hub changes merged since `0.9.0-preview.88`. Production is on `0.9.0-preview.88`. All three come from the MCP task-lifecycle audit (#469).

- #2255 (2234d441) **MCP: a task's owner must be a person (#470).**
  - Over MCP, `requirements_create` / `requirements_update` / `requirements_upsert_by_external_ref` with a node as `owner` now return `400 owner_must_be_human` and write nothing, with a hint to use `agent_owner`. Before, the call returned 200 and silently cleared the human owner.
  - MCP write responses are built from the stored row, so they always match a fresh `requirements_get`.
  - The old-app REST path (app ≤0.2.142: `owner` set to a node with no `agent_owner` key) keeps its coercion and its echo, unchanged.
- #2257 (bc3e01c6) **MCP `requirements_list`: smaller default, strict parameters, `tag` filter (#471).**
  - Default is the summary view, 50 per page, with the existing cursor. `view:'full'` and an explicit `limit` (up to 1000) still work.
  - Unknown parameters return `-32602` naming them and listing the valid ones, instead of being silently dropped.
  - New exact, case-sensitive `tag` filter (MCP and REST `?tag=`). REST defaults are unchanged (full view, 500 per page).
- #2256 (1fc66091) **Actionable task and project errors (#472).**
  - Error bodies keep the same `error` code strings and gain `field`, `message` and `hint` where they apply (59 codes covered). Codes without an entry return exactly the old shape.

No schema change.

Checked in Docker with `tests/hub-release-compat`, candidate 1fc6609100b3118aa8183fec4fc7e3891c2f86a4, baseline `0.9.0-preview.88` from npm, apps 0.2.166 / 0.2.181 / 0.2.194, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, check_failures=0 each, unexpected=1 each: `mcp.tools_list: requirements_list: inputSchema.additionalProperties undefined → false`. This is the intended #471 strict schema, acknowledged.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.
- The old-app owner coercion tests (`requirements-http`, `requirements-owner-strict-mcp-http`) pass on the candidate: 27/27.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.89`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.89
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.89
```

No migration; the database is not changed by this release. MCP callers that send unknown keys to `requirements_list`, or a node as `owner`, now get an error instead of a silent drop.

## Rolling back

`0.9.0-preview.88` starts on a database that `.89` has run on: `.89` adds no tables or columns.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
