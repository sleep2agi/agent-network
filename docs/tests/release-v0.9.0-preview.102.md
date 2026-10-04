# CommHub v0.9.0-preview.102

This release carries the Hub changes merged since `0.9.0-preview.101`. Production is on `0.9.0-preview.101`. It is built from main at b726b85f plus this version bump.

Hub (`server/`) changes since `.101` (the `.101` bump was #2348), oldest first:

- #2359 (a00754d5) **Capability flags survive a session handover (#550).**
  - When `report_status` arrives for an alias that already has a row under another `resume_id`, the Hub replaces the row (DELETE + INSERT). The replacement carried `registered_at` and the descriptive columns but not the sticky capability flags, so `rules_file_capable`, `skills_capable`, `files_capable` and `logs_capable` dropped to 0 on every `resume_id` change. The rules-file, skills, files and logs features then stayed dark for that node until it reported the flags again (board #548).
  - After the handover, one fixed `UPDATE` copies each flag that was 1 on the replaced row. It only ever sets a flag to 1, under the same binding rule as setting a flag directly (a node token bound to this alias). The `INSERT` itself is unchanged.
- #2362 (b726b85f) **Every rejected REST `POST /api/task` is logged (#552).**
  - Before, most refusals of `POST /api/task` left nothing in the Hub log, so "the message never arrived" and "the Hub rejected it" looked the same.
  - Every non-2xx branch now prints one line: `[HH:MM:SS] <user|anon> → /api/task → <alias>: REJECTED <status> <error> (net=<id> crid=<id>)`.
  - Only the status, error code, authenticated username and the requested alias / `network_id` / `client_request_id` are logged. The token, task text and attachment ids are never logged. Request values are clipped and control characters are stripped, so a request cannot forge log lines.
  - The two branches that already logged (409 `idempotency_conflict`, 429 duplicate) keep their existing line.
- #2360 (e8576e9a) touches only `server/src/*.test.ts` (de-flaking two performance budgets, #517). It does not change the package's behaviour.
- Not Hub: #2349, #2350, #2351, #2354, #2356 (anet / agent-node) ship with their own packages (#2355 was one such release, for agent-node and anet); #2353, #2357, #2361 are docs-site updates.

## Schema and settings

No schema change: no new tables, columns or indexes. No new environment variables. The defaults of all existing settings are unchanged.

## Checked

- **`tests/hub-release-compat`:**
  - Setup: candidate b726b85f (same `server/` tree as this bump apart from the version), baseline `0.9.0-preview.101` from npm, apps desktop-v0.2.204 / desktop-v0.2.205 / desktop-v0.2.206 (the newest app tag), `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.101 NEW_LABEL=.102`.
  - A1 and A2: steps=62, unexpected=0, check_failures=0.
  - B upgrade → rollback → re-upgrade: upgrade_check_failures=0.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.102`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.102
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.102
```

No migration runs. Existing settings keep their meaning.

## Rolling back

Rolling back to `0.9.0-preview.101` is safe: this release changes no schema, so `.101` reads the same database unchanged. After a rollback, capability flags are again reset on a session handover until the node reports them, and rejected `POST /api/task` calls are again mostly silent in the log.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
