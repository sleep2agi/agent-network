# CommHub v0.9.0-preview.95

This release carries the Hub changes merged since `0.9.0-preview.94`. Production is on `0.9.0-preview.94`. It is built from main at 22c5bc74.

- #2294 (22c5bc74) **Exact dependency pins (#498).** `server/package.json` now pins `@modelcontextprotocol/sdk` `1.32.0` and `zod` `4.6.5` (was `^1.12.0` / `^4.4.3`), the versions production already resolves from npm; the lockfile matches. agent-network and the channel plugin pin the SDK to `1.32.0` too. test629 now requires the installed SDK to equal the exact pin. The published package therefore installs the same dependency versions CI tests.
- Tests only: #2291 (41 suite Dockerfiles install server deps from the lockfile), #2292 (qa-rfc026 section B tests the role gate again).

Migration: none.

Checked:
- Fresh `npm install -g` of the packed candidate resolves `@modelcontextprotocol/sdk` 1.32.0 and `zod` 4.6.5 — the same as the production `.94` runtime.
- `tools/list` (all 74 tools, unfiltered) is byte-identical between the production `.94` install and the candidate (71,614 bytes, same sha256).
- `tests/hub-release-compat`, candidate 22c5bc74aef4a9619b978f7d14a81c610efcd173, baseline `0.9.0-preview.94` from npm, apps 0.2.166 / 0.2.181 / 0.2.198, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`: A1 and A2 steps=62 unexpected=0 check_failures=0; MCP `tools/list` 74 → 74, no new tools or params; B upgrade → rollback → re-upgrade upgrade_check_failures=0.
- A copy of a real database (29 users) started on the candidate, then `.94`, then the candidate again, with `COMMHUB_DUE_REMINDERS=0`; every start answered `/health`; `integrity_check` ok; 0 reminder rows.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.95`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.95
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.95
```

No schema change. Existing settings such as `COMMHUB_DUE_REMINDERS` keep working.

## Rolling back

`0.9.0-preview.94` starts on a database that `.95` has run on; nothing to undo.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
