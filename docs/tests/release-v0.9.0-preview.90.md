# CommHub v0.9.0-preview.90

This release carries the Hub changes merged since `0.9.0-preview.89`. Production is on `0.9.0-preview.89`. All three come from the MCP task-lifecycle audit (#469). It is built from main at 56e0b643 and deliberately excludes #2264 (#476), which is still under investigation.

- #2260 (7f30110d) **MCP: look people up, and name people by username / alias (#473).**
  - New MCP tool `requirements_people` (backed by `GET /api/requirements/people/directory`): compact member rows (user id, username, display name, role, department, the member's Agents with node_id and alias), `q` filter, 50 per page. Agents a restricted member is not granted never appear. Strict parameters.
  - `owner`, `agent_owner` and `participants` on create / update / upsert also accept `{kind:'user', username}` and `{kind:'node', alias}`, resolved only within the task's own network. An unknown name returns `person_not_in_network`, an alias matching several Agents returns `person_ambiguous`, both with a hint naming `requirements_people`. An `id`, when given, wins.
- #2262 (237dd544) **Task comments (#474).**
  - New MCP tool `requirements_comment {id, text}` and `POST /api/requirements/{id}/comments`. Comments are append-only `kind=comment` events credited to the caller (node or user), up to 4000 characters. They never change the description or `updated_at`. Someone who cannot see the task gets 404; a read-only member gets 403. No edit or delete.
- #2263 (56e0b643) **Safer participant edits (#475).**
  - `status` is accepted as an alias of `column` on MCP create / update / upsert; if both are sent and differ, `400 status_conflicts_with_column`, nothing written. REST `status` behaviour is unchanged.
  - `requirements_update` gains `participants_add` / `participants_remove`, applied atomically with the rest of the patch (REST PATCH accepts the same keys). `participants` is still a full replace, and the descriptions now say so.
  - Projects tool descriptions now state that node tokens can only read projects (behaviour unchanged).

No schema change (comments use the existing events table).

Checked in Docker with `tests/hub-release-compat`, candidate 56e0b643a41698df5767f6f9a6565f108cbd11e7, baseline `0.9.0-preview.89` from npm, apps 0.2.166 / 0.2.181 / 0.2.194, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, check_failures=0 each, unexpected=1 each: `mcp.tools_list`: `owner` / `agent_owner` / `participants` on `requirements_create` / `requirements_update` / `requirements_upsert_by_external_ref` retyped, with `id` now optional and `username` / `alias` added. This is the intended #473 loosening; no previously valid call is rejected. Acknowledged.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.
- The old-app owner coercion tests (`requirements-http`, `requirements-owner-strict-mcp-http`) pass on the candidate: 27/27.
- The packed server (`npm pack` of `server/` at the candidate, global install into a throwaway prefix) starts and answers `/health` in under 1 s.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.90`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.90
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.90
```

No migration; the database is not changed by this release. Existing MCP and REST callers keep working: the person fields only accept more forms, and the new keys are optional.

## Rolling back

`0.9.0-preview.89` starts on a database that `.90` has run on: `.90` adds no tables or columns. Comments written on `.90` stay in the events table as `kind=comment` rows, which `.89` ignores.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
