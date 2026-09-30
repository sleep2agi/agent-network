# CommHub v0.9.0-preview.71

This release carries 7 Hub changes, all already on main. It stacks on `0.9.0-preview.70` and `.69`: an instance on `.68` that upgrades
straight to `.71` also gets #2112 (P3 priority plus the one-time `requirements` table rebuild) and #2114 (sign-in session idle expiry,
under which long-idle sign-in tokens are rejected right away). See `release-v0.9.0-preview.69.md` and `release-v0.9.0-preview.70.md`.

- #2122 (8a0d508d84bbf70674e66521375b94bbfa26313d) **A hub admin can delete an empty network owned by someone else.**
  `DELETE /api/networks/:id` with a hub-admin user token now works on another user's network, but only if the network is empty.
  - It is refused with 409 and per-table `counts` if the network still has nodes, sessions, tasks, inbox, user_inbox, requirements,
    projects, scheduled tasks, providers, secrets, skills, side chats, or pending create/start requests.
  - The network `default` is always refused.
  - In the same transaction it removes members, grants, invites, node-request leftovers, and API tokens scoped to that network,
    so their node tokens stop working. The audit log is kept, with a new `network_deleted` row recording `admin_override: true`.
  - Owners deleting their own network behave as before.
- #2124 (eaa2512038e1a0613373e9388499df657a6969d9) **Optional `start` date on requirements** for the app's Gantt view.
  - It uses the same format as `due` and is accepted on REST create / PATCH / upsert and in the MCP requirements tools.
    An invalid value returns 400 `invalid_start`, and `""` clears it.
  - Capabilities gain `start_date`.
- #2128 (be7abc116733ca1882404423f86b5ad5e3406bce) **`GET /api/status?alias=<name>`** returns only that agent's rows. It uses the same
  projection and is applied inside the existing network scope. Without `alias`, the response is unchanged.
- #2132 (0893752db93e31fd6f1f2810cb1a99496f9cf942) **`GET /api/requirements` returns a weak ETag** and `Cache-Control: private, no-cache`.
  A matching `If-None-Match` gets 304 with an empty body. Clients that never send the header get the same 200 JSON as before.
- #2127 (149ad56aa7f90049a10f244c3b0401815aebff5c) **PostgreSQL schema-build fixes (RFC-039 S2a).** These change only the PostgreSQL
  path, and PostgreSQL support is still in development (not usable yet). SQLite code paths are unchanged.
- #2129 (e85198aa194d25bf109cfde7a81cd4082fe0dd22) **PostgreSQL adapter on one connection with real transactions (RFC-039 S2b).** Also PostgreSQL work (still not usable).
  Shared code now asks the adapter `transactionalFeaturesRefusal` instead of `dialect !== "sqlite"` before enabling the scheduler, the
  side-thread command outbox and runtime-evidence batches. On SQLite that value is `null`, so those features behave as before.
- #2131 (1ae041013a9b1ef84d667999304a2aaeec1067ea) **Agent groups (RFC-038 §8 step 1).** Owners and admins can create agent groups and grant a whole
  group to a member. Agents added to the group later become visible to that member automatically.
  - New endpoints: `GET/POST /api/networks/:id/agent-groups`, `PATCH/DELETE …/agent-groups/:gid`, `PUT …/agent-groups/:gid/members`.
    They need a user token from the owner/admin or a hub admin. Node tokens and ordinary members get 403.
  - `agent-grants` GET adds `group_grants`. PUT accepts `group_grants`, and **omitting it keeps existing group grants**, so older apps don't wipe them.
  - New tables start empty, so nobody's current access changes at upgrade.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.71`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.71
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.71
```

For an existing instance, the operator backs up the database in an authorised window, then restarts the process with its usual service manager.

Migrations at startup (additive): `requirements.start_on TEXT` (nullable, no default, no existing values changed; #2124), and the new tables
`agent_groups`, `agent_group_members` and `network_member_group_grants` with their indexes (#2131; they start empty).
Coming from `.68`, the `.69` `requirements` rebuild and the `.70` `api_tokens` columns also apply, and `.70`'s idle-token expiry takes effect.

The package contains no existing data, users, network members or secrets. To roll back, use `0.9.0-preview.70` / `.69` / `.68` with a previously
prepared data restore plan. Do not drop production tables or overwrite published packages. `start_on` stays in the database and older versions ignore it.
A network deleted with the admin override is not restored by a rollback. Restoring it needs the pre-upgrade database backup.
