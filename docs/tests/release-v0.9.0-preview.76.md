# CommHub v0.9.0-preview.76

This release carries the Hub changes merged since `0.9.0-preview.75` (cut from d8700a6b). Production is on `0.9.0-preview.75`.

- #2183 (8dd0b77f19eb2e6753a749e74e3f4a83cd316e76) **`GET /api/requirements/people` returns `display_name` as its own field.**
  - Each people entry (members and nodes) gains `display_name`. App 0.2.168's share card uses it to show a neutral label instead of an account name like `admin`.
  - **`name` is unchanged**: for a member it is the display name, falling back to the username; for a node it is the display name, then the alias, then the node name. The sort order (`name`, then `id`) is unchanged, so old apps read exactly what they read on `.75`.
- #2187 (854b1d78b0c380afd195d3afcfa857f47fb01255) **`display_name` is `""` when unset or equal to the username.**
  - Accounts registered without a display name store their username as it (`register()` in `auth.ts`), so without this the share card would still print `admin`.
  - For members, `display_name` is `""` when the stored value is empty or exactly equals the username (case-sensitive). For nodes, it is `""` when none is set.
  - Only this endpoint changes. Registration, stored data and `name` are untouched.

No other server change is in this release. #2184 (8ba1bf87) only adds the release compat harness under `tests/`.

Checked in Docker with `tests/hub-release-compat`, against apps 0.2.162–0.2.168 and with `0.9.0-preview.75` as the baseline:
- Every response an app already reads keeps its fields and types. The only addition is `display_name` on people entries.
- `kind` and `name` of every people entry, and their order, are identical between `.75` and `.76`. `display_name` reads `""` for `admin` and another member without a display name, `"Amy Display"` for a member registered with one, and `""` for a node without one.
- A member who existed before the upgrade sees the same cards with the same values after it, after a rollback to `.75`, and after upgrading again. On the same database, the full list is byte-identical between `.75` and `.76`.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.76`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.76
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.76
```

For an existing instance, the operator backs up the database in an authorised window (`VACUUM INTO` or `sqlite3 .backup`, never a copy of the `.db` file alone), then restarts the process with its usual service manager.

No new migrations. No table or column changes; `display_name` is read from existing columns.

## Rolling back

`0.9.0-preview.75` starts on a database that `.76` has run on, since `.76` changes no schema. This was checked in Docker: .75 → .76 → .75 → .76 on one database, with the same cards and byte-identical lists each time. After a rollback, people entries no longer carry `display_name`, and old apps are unaffected.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
