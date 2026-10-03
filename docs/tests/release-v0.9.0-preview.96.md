# CommHub v0.9.0-preview.96

This release carries the Hub changes merged since `0.9.0-preview.95`. Production is on `0.9.0-preview.95`. It is built from main at 03238df1.

- #2299 (03238df1) **One node-scoped SSE subscriber per node (#507).** When a second process connects to `/events/<alias>` with that node's own token, the Hub keeps the newest stream and closes the older one after a final `node_connection_superseded` event (`superseded_by_new_connection`, or `replaced_by_reconnect` when both carry the same `X-Anet-Instance-Id`). A rate-limited `node_identity_conflict` warning goes to the server log, the network observer stream, the audit log and `/api/stats/sse` → `identity_conflicts` (last 50; remote address, user agent, instance id, connect time; never a token). Within 10 minutes of a conflict, `report_status(offline)` is held while another node connection is live and applied when the last one leaves. A new task therefore reaches exactly one copy. Dashboard monitors, master-token streams and other nodes' tokens watching an alias are never closed.
- Not Hub: #2298 (anet codex TUI resume), #2296 (docs site).

Migration: none.

Checked:
- Packed candidate installed with `npm install` into an empty prefix resolves `@modelcontextprotocol/sdk` 1.32.0 and `zod` 4.6.5; it starts on an empty HOME and random port, `/health` ok, unauthenticated `/events/x` → 401.
- `tests/hub-release-compat`, candidate 03238df13ebd81a7d67c86bc74cd8815aef7a39b, baseline `0.9.0-preview.95` from npm, apps 0.2.166 / 0.2.181 / 0.2.199, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`: A1 and A2 steps=62 unexpected=0 check_failures=0; MCP `tools/list` 74 → 74, no new tools or params; candidate 5xx none; B upgrade → rollback → re-upgrade upgrade_check_failures=0.
- A read-only `VACUUM INTO` copy of a real database (29 users) started on the candidate, then `.95`, then the candidate again, with `COMMHUB_DUE_REMINDERS=0`; every start answered `/health` with no errors in the log; `integrity_check` ok.
- Before merge of #2299, production `/api/stats/sse` showed 114 aliases each with exactly one stream — no current node legitimately holds two of its own streams.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.96`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.96
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.96
```

No schema change. Existing settings such as `COMMHUB_DUE_REMINDERS` keep working. Released agent-node versions do not send an instance id; two live copies of the same node will now flap instead of both receiving every task, and each takeover is logged as `node_identity_conflict`.

## Rolling back

`0.9.0-preview.95` starts on a database that `.96` has run on; nothing to undo.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
