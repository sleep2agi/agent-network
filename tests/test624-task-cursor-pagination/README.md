# test624 — task cursor pagination

Runs a real isolated Hub and SQLite database to verify that `/api/tasks`:

- honors an exclusive `before` cursor;
- composes it with `to_name` and authenticated network scope;
- accepts SQLite and ISO UTC timestamp shapes;
- rejects malformed/rolled-over cursors;
- preserves the no-cursor response contract.

Three source mutations prove the cursor filter, exclusivity, and validation
are load-bearing.
