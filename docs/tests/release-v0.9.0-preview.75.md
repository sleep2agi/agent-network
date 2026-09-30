# CommHub v0.9.0-preview.75

This release carries the Hub changes merged since `0.9.0-preview.74` (cut from aa271d94). Production is on `0.9.0-preview.74`.

- #2180 (717223454a47daa9e0563bcdd8982f661cd52a17) **A lighter task list.** Targets the app's 「连接较慢」 banner.
  - `GET /api/requirements?view=summary` (capability `list_summary`) drops `description` and `checklist` and adds `has_description` and `checklist_count {total, done}`. The full card stays at `GET /api/requirements/:id`.
  - `?changes=1&updated_since=…` (capability `changes`) returns only the cards changed since then, archived ones included. It also returns `deleted` (ids from the new tombstone table), `server_time` (the next `updated_since`) and `tombstones_since` (30-day retention).
    A scoped member only gets deletions of cards they could see.
  - Deleting a parent now bumps `updated_at` on the children it detaches. Deleting a project bumps `updated_at` on the cards whose `project_id` it clears.
  - The list body and ETag are cached per caller and query until the next requirements write, for at most 60 s. Scoped and agent-restricted members, `q=` searches and `changes=1` are never cached.
  - Gzip is cached per content-hash ETag (LRU, 16 MiB).
  - `GET /api/stats/routes?minutes=N` (admin only) reports per-route count, average, p95, max, bytes and 5xx.
- #2181 (d1812d0b858b69d1af6e4c5989eb550eef879643) **The MCP tool `requirements_list` takes `view` and `changes`.** Agents that only need titles or status can ask for the summary. Callers that pass neither argument get the same result as before.

**Responses to clients that send none of the new params are identical to `.74`, except that `capabilities` gains `list_summary` and `changes` at the end.** The old entries keep their order.
- Because the ETag is a content hash, the first poll after the upgrade is a 200 instead of a 304. It settles after that.
- Old apps check `capabilities` with `includes()` and are unaffected.

Checked in Docker against apps 0.2.162–0.2.166, with `0.9.0-preview.74` as the baseline:
- Every response an app already reads keeps its fields and types.
- A member who existed before the upgrade sees the same cards with the same values after it, after a rollback to `.74`, and after upgrading again.
- On the same database, the full list is identical between `.74` and `.75` apart from `capabilities`.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.75`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.75
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.75
```

For an existing instance, the operator backs up the database in an authorised window (`VACUUM INTO` or `sqlite3 .backup`, never a copy of the `.db` file alone), then restarts the process with its usual service manager.

Migrations at startup. They are idempotent and run on every start.
- New table `requirement_tombstones` and index `idx_requirement_tombstones_network(network_id, deleted_at)`, both created only if missing (#2180).
- Deleting a card writes a tombstone. Tombstones older than 30 days are pruned on each delete.
- No existing table or column changes.

## Rolling back

`0.9.0-preview.74` starts on a database that `.75` has touched and ignores the tombstone table. This was checked in Docker: .74 → .75 → .74 → .75 on one database, with the same cards and byte-identical lists each time.

Cards deleted while on `.74` have no tombstone. A `changes=1` client (app #605, not yet released) drops them at its next full read, which happens every ≤10 min, on truncation, or on `has_more`. Old apps are unaffected.

Do not drop the new table and do not overwrite published packages. The package contains no existing data, users, network members or secrets.
