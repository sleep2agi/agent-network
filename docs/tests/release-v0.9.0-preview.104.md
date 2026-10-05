# CommHub v0.9.0-preview.104

This release carries the Hub changes merged since `0.9.0-preview.103`. Production is on `0.9.0-preview.103`. It is built from main at b4578933 plus this version bump.

Hub (`server/`) changes since `.103` (the `.103` bump was #2385):

- #2390 (5ee61b39) **🔴 Privacy change: members who can see a node see that node's whole timeline (#563).** Approved by the owner on 2026-10-05 15:50 (「可以可以可以可以」), after being told the 4 restricted members in production would immediately see past history with their granted nodes.
  - Before: restricted members (`member`/`viewer` with `agent_access=granted`) only saw their own exchanges with a granted node (RFC-038 rule, pinned by `agent-acl-http.test.ts`). Hub admins, network owners/admins and `agent_access=all` members already saw everything.
  - Now: a restricted member who can see node N (direct or group grant) sees every exchange with N in that network, whoever sent it — including history from before the grant and from before a rename (matched on `to_node_id` as well as the alias). New scope helper `addAgentTimelineScope` (`server/src/network-scope.ts`), applied to `/api/tasks` (and its stats), `/api/tasks/:id`, `/api/task_events`, the network-detail task counts, and MCP `list_tasks` / `get_task`. The network event stream also wakes a restricted member for events on a visible node's timeline (grant changes reach the stream within ~5 s because of a short cache). Attachments on visible messages (others' and the node's replies) are downloadable (`restricted-files.ts`).
  - Unchanged: members without a grant see nothing; exchanges between a visible node and a node the member cannot see stay hidden in both directions (REST and stream); sending is still gated by `canMessageAgent`; the inbox (`/api/messages`) and agent-to-person `user_inbox` messages stay private to their addressee; node tokens and unrestricted users are unaffected; a username colliding with an agent name keeps that network closed to the member.
  - Evidence (from the PR): 7 assertions witnessed red against origin/main (1ff904b3) and green on the branch (task list matching admin's view, `/api/tasks/:id` 200 granted / 404 not, group grant, attachments, stream wake, `task_events`); the hide-invisible-nodes rule removed from the SQL → 3 tests red, from the stream filter → the stream test red; full server suite 2177 pass / 1 fail (`tool-audience-http` size budget 72514 > 72500, also failing on unmodified origin/main in that environment, not this change); `tests/test2123-hub-postgres-ladder` with `agent-acl-http.test.ts` added: PASS at level 6, `agent-acl-http` 60/60 on real PostgreSQL. PR head 128/128 checks green. RFC-038 and the docs-site multi-user / rest-admin pages (zh + en) describe the new rule.
- Not Hub: #2386, #2388 (agent-node), #2389 (anet), #2391, #2393 (tests) ship with their own packages (#2387 and #2392 were those releases) or are CI-only.

## Schema and settings

No schema change: no new tables, columns or indexes. No new environment variables; all defaults unchanged. `hub.env` is not touched by this release.

## Checked

- **`tests/hub-release-compat`:**
  - Setup: candidate e4d47dc9 (main b4578933 plus this version bump; `server/` identical to this PR), baseline `0.9.0-preview.103` from npm, apps desktop-v0.2.206 / .207 / .208 / .209 (newest app tag), `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.103 NEW_LABEL=.104`.
  - Self-test (`bun tests/hub-release-compat/tools-compat-selftest.ts`, Docker `oven/bun:1.3.14`, no network): PASS; all known-bad controls go red (property removed, property retyped, new required param, tool removed, `additionalProperties` flipped).
  - A1 and A2: steps=62, unexpected=0, check_failures=0.
  - B upgrade → rollback → re-upgrade (.103 → .104 → .103 → .104 on one database): upgrade_check_failures=0.
  - Afterwards `pgrep -af "/tmp/tmp\..*/bin/commhub-server"` found no throwaway Hub left running.
- **Coverage note:** the compat replay's fixtures contain no `agent_access=granted` member, so it cannot observe #563 either way; the #563 evidence is the PR's witnessed-red tests and the PostgreSQL ladder run above.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.104`, channel preview.

Promote `must_contain`: `addAgentTimelineScope` (present in this tree's `server/src`; the `.103` tarball from npm gives 0 hits, checked 2026-10-05).

## Production plan

1. Install into a new runtime `~/.commhub/runtime-v93-preview104`; boot it once on a throwaway Hub.
2. Announce the restart time to the owner first (about 5 s of downtime), then switch the launcher's `RUNTIME_DIR` from `runtime-v92-preview103` to `runtime-v93-preview104` and restart through the launcher. `hub.env` unchanged. Back up launcher + database first.
3. Health must report `0.9.0-preview.104` within 30 s, otherwise roll back automatically. Watch 10 minutes.
4. Ask the owner to open the same node from his second (restricted) account and confirm he sees the same history as admin.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.104
```

The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.104
```

No migration runs. Existing settings keep their meaning.

## Rolling back

Rolling back to `0.9.0-preview.103` is safe: no schema change, so `.103` reads the same database. After a rollback, restricted members go back to seeing only their own exchanges with granted nodes (the data was never changed — only what is returned).

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
