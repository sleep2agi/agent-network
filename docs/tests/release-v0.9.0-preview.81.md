# CommHub v0.9.0-preview.81

This release carries the Hub change merged since `0.9.0-preview.80` (cut from 8bd314fc). Production is on `0.9.0-preview.80`.

- #2214 (f0f733626326eeb98cb5a36db727aabec0a1b33f) **The project list says which projects the caller can put tasks into.**
  - `GET /api/requirements/projects` adds `viewer_can: { edit }` to every row. `edit` is true only if the caller could create a task in, or move a task into, that project right now, using the same checks as the write paths: `canWrite`, archived projects rejected, then `canUseProject` (scoped members need `can_edit` on the grant).
  - Owner, admin, `task_access='all'` member, Hub admin, node token on its own network: true for every non-archived project. Scoped member: true only for `can_edit` grants. Scoped viewer: always false.
  - Additive field, no schema change. App 0.2.179 and earlier ignore it; app 0.2.180 (agent-network-app#637) uses it to leave non-editable projects out of the create/move project pickers.

No other server change is in this release.

Checked in Docker with `tests/hub-release-compat`, candidate f0f733626326eeb98cb5a36db727aabec0a1b33f (clean tree), baseline `0.9.0-preview.80` from npm, apps 0.2.162–0.2.179 (`APP_TAGS` set explicitly):
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

#2214's own test (`server/src/project-viewer-can-http.test.ts`) checks the value per caller and that `edit` equals "POSTing a task into it succeeds" for all 11 caller×project pairs; it fails 4/4 against the pre-change code. The PostgreSQL ladder passed with the new file registered.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.81`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.81
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.81
```

No new migrations and no new tables.

## Rolling back

`0.9.0-preview.80` starts on a database that `.81` has run on, since `.81` changes no schema. After a rollback, project rows simply lack `viewer_can`, and app 0.2.180 behaves as before (all granted projects listed).

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
