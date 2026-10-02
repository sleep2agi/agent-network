# CommHub v0.9.0-preview.85

This release carries the Hub change merged since `0.9.0-preview.84`. Production is on `0.9.0-preview.84`.

- #2234 (f4f4002fd85512c918a01919c7210a7b2999f027) **Departments for human members — org chart v1 (#419).**
  - New table `network_departments` (id, name, parent_id, leader_user_id, sort) and a new nullable column `network_members.department_id` (NULL = unassigned). Both additive; created at startup if missing.
  - REST: `GET/POST /api/networks/:id/departments`, `PATCH/DELETE /api/networks/:id/departments/:did`, `PUT /api/networks/:id/members/:uid/department`.
  - Read: any network member, this network's node tokens and Hub admins. Write: network owner/admin and Hub admins only.
  - Rules: sibling names unique, no cycles, at most 10 levels, delete only when empty (409 with counts), leader must be a member (reads as null after they leave). Audit-logged; departments are removed when the network is deleted.
  - `/humans` is unchanged; the admin `/members` list gains `department_id`.

No other server change is in this release.

Checked in Docker with `tests/hub-release-compat`, candidate f4f4002fd85512c918a01919c7210a7b2999f027 (clean tree), baseline `0.9.0-preview.84` from npm, apps 0.2.166 / 0.2.181 / 0.2.189, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

#2234's own test (`server/src/departments-http.test.ts`) covers per-role permissions, create/rename/move/depth/cycle/leader, member assignment and counts, delete-only-when-empty, a departed leader and network-delete cleanup; it is registered in the PostgreSQL ladder.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.85`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.85
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.85
```

One new table (`network_departments`) and one new nullable column (`network_members.department_id`), both created automatically at startup. No data is rewritten.

## Rolling back

`0.9.0-preview.84` starts on a database that `.85` has run on: it does not read the new table and ignores the extra nullable column, so members, networks and tasks behave as before. Departments created on `.85` stay in the database and reappear after re-upgrading; they are simply invisible to `.84`.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
