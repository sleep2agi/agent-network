# CommHub v0.9.0-preview.97

This release carries the Hub changes merged since `0.9.0-preview.96`. Production is on `0.9.0-preview.96`. It is built from main at 6489f451.

- #2308 (6489f451) **`last_event` on every requirements list row (#506).** `GET /api/requirements` (all views, `changes=1`, `q=`) returns `last_event: { type: created|changed|comment, field, actor: { id, kind: user|node, display_name } | null, at, summary? } | null` per row, from the existing `requirement_events` table (comments count). One query per page on the existing `idx_requirement_events_card` index; actors the viewer cannot see are masked. `?last_event=0` omits it; any other value is 400 `invalid_last_event`. MCP `requirements_list` leaves it out by default (new optional boolean `include_last_event`), so the #471 agent-context budget is unchanged. The list's `capabilities` gains `last_event`.
- Not Hub: #2309 (agent-node test), #2310 (agent-network release notes), #2302 / #2305 (anet CLI).

Migration: none (no new table, column or index).

Checked:
- Packed candidate installed with `npm install` into an empty prefix resolves `@modelcontextprotocol/sdk` 1.32.0 and `zod` 4.6.5; it starts on an empty HOME and random port, `/health` reports `0.9.0-preview.97`, unauthenticated `/events/x` → 401.
- `tests/hub-release-compat`, candidate 6489f451ea2a0ac5479fab92408ac82f7d23b7eb, baseline `0.9.0-preview.96` from npm, apps desktop-v0.2.175 / desktop-v0.2.200, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`: A1 and A2 steps=62 unexpected=0 check_failures=0; `requirements.list` / `requirements.search` + `last_event` classified ADDITIVE; MCP `tools/list` 74 → 74, new params `requirements_list+[include_last_event]`. B upgrade → rollback → re-upgrade: every card field unchanged, rollback and re-upgrade lists byte-identical to their own earlier responses; the one red line is the opt-in byte check "full list (no new params) identical .96 vs .97", which is expected for this release because the default REST row now carries `last_event` by design.
- A read-only `VACUUM INTO` copy of the production database (29 users) started on the candidate, then `.96`, then the candidate again, with `COMMHUB_DUE_REMINDERS=0`; every start answered `/health` with its own version and no errors in the log; `integrity_check` ok.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.97`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.97
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.97
```

No schema change. Existing settings such as `COMMHUB_DUE_REMINDERS` keep working. Clients that read the requirements list get one extra field per row (about 145 bytes); clients that need the old shape pass `?last_event=0`.

## Rolling back

`0.9.0-preview.96` starts on a database that `.97` has run on; nothing to undo.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
