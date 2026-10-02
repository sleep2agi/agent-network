# CommHub v0.9.0-preview.83

This release carries the Hub change merged since `0.9.0-preview.82` (cut from 48b39f32). Production is on `0.9.0-preview.82`.

- #2227 (ae516a8396bbb94717814256cbae38a3c5786a51) **Agents can manage projects and read task activity over MCP.**
  - New MCP tools `projects_create`, `projects_update` (name, color, sort, archived) and `requirements_events` (one task by id or `#N`, or the network; `since`, `limit`, `cursor`).
  - All three call the same REST handlers the app uses, so permission and visibility rules are identical to the app: owner/admin and all-tasks members may manage projects; task-scoped members, viewers and node tokens get 403, as on REST today.
  - `projects_list`'s description points to the new tools; the restricted-member tool gate includes them. The MCP tool docs (zh/en) list all registered tools.
  - Additive only. No schema change.

No other server change is in this release.

Checked in Docker with `tests/hub-release-compat`, candidate ae516a8396bbb94717814256cbae38a3c5786a51 (clean tree), baseline `0.9.0-preview.82` from npm, apps 0.2.166 / 0.2.181 / 0.2.188, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

#2227's own test (`server/src/mcp-projects-events-http.test.ts`) checks, per caller (owner, all-tasks member, task-scoped member, viewer, node token), that each MCP tool returns the same outcome as the matching REST call, plus events visibility parity. Server aggregate on the branch: 1840 pass, 0 fail; PostgreSQL ladder PASS.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.83`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.83
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.83
```

No new migrations and no new tables.

## Rolling back

`0.9.0-preview.82` starts on a database that `.83` has run on, since `.83` changes no schema. After a rollback, the three MCP tools are gone; REST and the app are unaffected.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
