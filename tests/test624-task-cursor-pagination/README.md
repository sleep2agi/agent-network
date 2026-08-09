# test624 — task cursor pagination

Runs a real isolated Hub and SQLite database to verify that `/api/tasks`:

- supports `before=<created_at>&before_task_id=<task_id>` as a stable
  compound cursor, so rows sharing SQLite's one-second timestamp precision
  are not skipped between pages;

- honors an exclusive `before` cursor;
- composes it with `to_name` and authenticated network scope;
- accepts SQLite and ISO UTC timestamp shapes;
- rejects malformed/rolled-over cursors;
- preserves the no-cursor response contract.

Three source mutations prove the cursor filter, exclusivity, and validation
are load-bearing.
