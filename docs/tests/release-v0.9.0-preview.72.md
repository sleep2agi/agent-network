# CommHub v0.9.0-preview.72

This release carries 8 Hub changes, all already on main. Production is on `0.9.0-preview.71`.

- #2139 (a209d83892dadeaf533927a5d5ab01d16788970d) **A short task number per network (`#N`).**
  - Each requirement gets a `seq` that is shown as `#N`. The primary key `requirement_id` is unchanged.
  - `#N` is accepted wherever an id is (REST GET / PATCH / DELETE / checklist, and the MCP requirements tools), and `?seq=` filters by it.
  - Capabilities gain `requirement_seq`.
  - Numbers are never reused. `requirement_seq_counters` records the highest number handed out per network, so a deleted or archived number stays retired.
- #2142 (f9d9d10b450009fae20dabd7dedafe5ca09da59b) **`GET /api/requirements` server-side search and paging.**
  - `q=` uses the same matching as the app's task search: title, description text, people / agent / project names and tags.
    NFKC and case-folding are applied first, space-separated terms are ANDed, and the whole query also matches as a task id (`#N`, `N`, a full id or an id prefix).
  - Restricted members never match names of agents they can't see.
  - `limit` / `cursor` paging is added. `q` longer than 200 characters returns 400 `invalid_q`.
  - Requests without these parameters get the same response as before.
- #2146 (e812cb169812104f74d2445b59b8d05da6f7b5d0) **Network delete cleans agent groups (fixes #2144).**
  - A hub admin's delete of an "empty" network now counts `agent_groups` as content and refuses with 409 and `counts.agent_groups`.
  - Both the owner and admin delete paths remove the network's group grants, group members and groups. The owner path's deletes now run in one transaction.
- #2134 (fbf8ca773192c5adef87ff7536b0515637197356) **`visibleAgents()` runs a fixed number of queries** instead of one per grant, for direct and group grants. The output is identical.
- #2140 (313bfc801d1d1bf7e21e7322e1fe83f30d7e122c), #2145 (78c7769478f7dac46c7a7c98e67a92ddbf35e41e) **PostgreSQL work (RFC-039 S3, S4 part 1).**
  PostgreSQL is still in development and not usable. SQLite paths are unchanged, except that the PostgreSQL-only `side_chat_operations.rowid` column is added only on PostgreSQL.
- #2136 (a4eedb7b940b9dc993c4fdce8141faa947a242fd) test-only: scheduled-tasks HTTP tests own their data.
- #2147 (859bb29ca74bbc5f2b0f65bb737b06e789a4fcef) **PostgreSQL-only fixes (RFC-039 F3/F5).** This merged after the bump PR was cut, and it is in the published package.
  It adds `rowid` tie-break columns on `nodes` / `user_inbox`, translates `strftime`, and accepts `get(sql, [params])`, all on PostgreSQL only. SQLite is unchanged.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.72`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.72
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.72
```

For an existing instance, the operator backs up the database in an authorised window, then restarts the process with its usual service manager.

Migrations at startup:
- `requirements.seq INTEGER`, which is nullable. Existing rows are numbered once, per network, in `created_at` order (id as the tie-break),
  continuing after the network's current maximum.
- The new table `requirement_seq_counters` is seeded with each network's maximum.
- The unique index `(network_id, seq) WHERE seq IS NOT NULL` is created.
- Later starts only number rows that still have no `seq`, for example cards created while rolled back to an older Hub.

The package contains no existing data, users, network members or secrets. To roll back, use `0.9.0-preview.71` with a previously prepared data restore plan.
Do not drop production tables or overwrite published packages. `.71` ignores `seq` and the counter table. Cards created during the rollback get numbers after the current maximum on the next upgrade.
