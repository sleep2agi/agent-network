# Server aggregate test isolation (#434)

Run the server suite with:

```bash
cd server
bun run test
```

This remains the single canonical entry point, but it no longer expands to a
flat `bun test src/` process. The runner automatically enumerates every
`server/src/**/*.test.ts` file and executes each file in its own child process
with a unique `COMMHUB_DB`, `HOME`, `TMPDIR`, and uploads directory.
`DATABASE_URL` is explicitly cleared in every child. A non-zero exit, signal,
timeout, or missing Bun summary fails the aggregate run.

## Why the orchestration changed

A flat Bun process shares ESM modules, `process.env`, and the current working
directory. Several integration files changed `COMMHUB_DB` after another file
had already evaluated the `db.ts` singleton. The old command could therefore
be deterministic and green while two suites wrote the same database. By
August 2026 it also made the scheduled-task race worker inherit a file-test DB
from another suite, producing four order-dependent failures.

Per-file processes are slower than one flat process because Bun and the schema
start once per file. That cost is intentional: it removes module/env/cwd
coupling without changing production database construction. Automatic
enumeration replaces the rejected fixed manifest from draft PR #438, so a new
test is isolated by default instead of being silently omitted.

`--reverse` reverses the enumerated order, `--verbose` streams child output,
and `--file=server/src/name.test.ts` runs one exact enumerated file for local
diagnosis. The default still runs every file. `--timeout-ms=N` can lower or
raise the per-file 90-second limit.

The two real HTTP suites also import `require-explicit-test-db.ts` before their
application modules. Running either file outside the canonical runner without
an explicit temporary `COMMHUB_DB` fails with a clear message instead of ever
falling back to the production path.

## Relationship to earlier corrective work

- #474/#475 made `server.ts` safe to import and gave HTTP suites private
  `bootServer({ port: 0 })` lifecycles.
- #481 moved remaining module timers under `startHub()`.
- #435 rejects inherited `DATABASE_URL` before adapter construction.
- This runner closes the remaining process-level DB/env/cwd isolation gap.

The old flat command is intentionally not exposed as `test:raw`: draft #438's
diagnostic path inherited `DATABASE_URL`, and preserving a known-unsafe command
under an official script name would recreate that footgun.
