# CommHub v0.9.0-preview.69

This release carries one Hub change, already on main:

- #2112 (e9e3b57abf9ea97249b43facb95c8cfcc2c6ef38) **P3 「极低」 requirement priority.**
  `priority` accepts `lowest` on REST POST / PATCH / upsert and in the MCP `requirements_create` / `requirements_update` /
  `requirements_upsert_by_external_ref` tools. Unknown values still return 400 `invalid_priority`.
  The list's `capabilities` gains `priority_lowest`, so app 0.2.155+ shows P3 only on hubs that accept it.
  The mapping is P0 = `high`, P1 = `normal` (default), P2 = `low` and P3 = `lowest`.

Older apps (0.2.153 / 0.2.154) show a `lowest` card as 普通. They only PATCH `priority` when the user changes it,
so opening or editing a P3 card in an old app does not rewrite it.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.69`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.69
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.69
```

For an existing instance, the operator backs up the database in an authorised window, then restarts the process with its usual service manager.

🔴 **Migration at startup: a one-time table rebuild.** Existing databases created `requirements` with
`CHECK(priority IN ('high', 'normal', 'low'))`. On first start, SQLite rebuilds the table from its own `sqlite_master` SQL
with only that CHECK widened to include `lowest`:
- It copies every row (`SELECT *`) and recreates the table's indexes.
- Databases that are already widened skip it (no-op), so a second start does nothing.
- On Postgres, the constraint `requirements_priority_check` is dropped and re-added.

The rebuild runs during startup and blocks it. Its cost grows with the number of requirement rows. Back up first.

The package contains no existing data, users, network members or secrets. To roll back, use `0.9.0-preview.68` with a previously
prepared data restore plan. Do not drop production tables or overwrite published packages. .68 reads the rebuilt table normally.
A row that already has `priority = 'lowest'` is shown as 普通 by apps, and .68 rejects writing `lowest`.
