# CommHub v0.9.0-preview.77

This release carries the Hub changes merged since `0.9.0-preview.76` (cut from 51f77c72). Production is on `0.9.0-preview.76`.

- #2189 (eb6156b5fc3e8840d37f2f23d125d54a16fa21fd) **Task change history: `requirement_events` + `GET /api/requirements/events`.**
  - Every requirement write now records who changed what, and when, in the same transaction as the write: creation, each changed field (old → new), checklist items, tag renames, project deletes and card deletes. The actor is the user, or the node for a node token.
  - `GET /api/requirements/events?network_id=…` returns them newest first with `limit`, `next_cursor` and `since`. Its visibility is the same as the requirements list: a scoped member only sees events for cards they can see (deleted cards by their tombstone), and an agent-restricted member has hidden nodes masked.
  - The list advertises capability `events`, appended at the end of `capabilities`. Responses to clients that send nothing new are otherwise unchanged.
  - Events older than 180 days are pruned on write.

No other server change is in this release. #2190 only updates the download page.

Checked in Docker with `tests/hub-release-compat`, candidate c66489f187aca59ab357053f667a835c804f8144 (clean tree), baseline `0.9.0-preview.76` from npm, apps 0.2.162–0.2.169 (`APP_TAGS` set explicitly; the harness default stops at 0.2.166):
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.
- #2189's own HTTP tests cover the scoped-member and agent-restricted visibility, one-transaction writes, paging, and an idempotent migration.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.77`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.77
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.77
```

One new table, `requirement_events`, and three indexes, all created only if missing. No existing table or column changes.

## Rolling back

`0.9.0-preview.76` ignores `requirement_events` and starts on a database that `.77` has run on. This was checked in Docker: .76 → .77 → .76 → .77 on one database. While running `.76`, task changes are not recorded, so the history has a gap for that period. `.76` does not read or write `requirement_events`, so events recorded before the rollback stay in the table; this follows from the code, and the harness does not replay events across the rollback.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
