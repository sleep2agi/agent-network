# server aggregate test runner (issue #434)

The canonical way to run the CommHub server test suite:

```
cd server
bun run test
```

which delegates to `scripts/test-runner.ts`. Every real-server integration
suite gets its own isolated Bun child with an independent OS-assigned
port, a fresh `mkdtemp` DB, and an env allowlist that excludes
`DATABASE_URL`. Serial by design. Exit code is authoritative; counters are
evidence.

## Why the runner

Two suites (`api-host-supervisors-fallback.test.ts`,
`uploads-http.test.ts`) import `./index.js` and call `bootServer()`.
On the pre-#434 code path, they used a shared `bun test src/` process
and a parent-side random `PORT = 18000 + Math.random() * 1000`. That
combination hit three separate problems in the aggregate lane:

1. Only one `Bun.serve` binding wins the port. The loser's tests reach
   assertions but the fetch calls hit `ECONNREFUSED`.
2. `db.ts`'s module singleton is set at first import from whatever env
   was live at that moment — subsequent `beforeAll` env mutations don't
   move the DB path, so combined fixtures write into the winning suite's
   database.
3. The parent-side random port range is a TOCTOU pattern that races
   with anything else that happens to bind in that range.

The runner replaces the shared process with per-suite children,
requests `port: 0` on the seam (kernel picks a free port at bind time),
gives each child its own DB dir, and drives its own manifest instead of
relying on shell globs.

## Two suite kinds

- `isolated_server` — integration suites that import the server module
  and call `bootServer(...)`. One Bun child per file.
- `shared_unit` — pure logic / DB-only fixture code. Runs in a single
  shared child.

Every `*.test.ts` under `server/src/` (and `server/scripts/`) must be
registered explicitly in `scripts/test-manifest.ts`. The runner performs
a set-equality check between manifest and the filesystem at start; a
missing or extra entry hard-fails the whole run before any test executes.

If a `shared_unit` file is ever found to pollute the shared child (leaked
DB state, module-singleton mutation), promote it to `isolated_server`
rather than muting an assertion — the aggregate-fail is the load-bearing
signal here.

## What the runner does per child

- Env: explicit allowlist of parent keys (`PATH`, `TMPDIR`, `TERM`,
  `LANG`, `LC_ALL`, `LC_CTYPE`, `CI`, `GITHUB_ACTIONS`, `SHELL`, `USER`,
  `LOGNAME`). Any other parent variable is dropped, including
  **`DATABASE_URL` which is unset unconditionally**. This is a
  defense-in-depth against a leaked shell / CI variable, on top of the
  `#435` guard inside `db-adapter.ts`. The `scripts/test-runner-self.test.ts`
  suite proves the runner's env-shaping keeps this invariant.
- `HOME`, `COMMHUB_DB`, `COMMHUB_UPLOADS_DIR`, `TMPDIR`: each child gets
  a fresh `mkdtempSync` directory. On child exit the runner rms the
  whole dir (sweeps `db`, `db-wal`, `db-shm` in one shot).
- `NODE_ENV`: forced to `"test"` for every child so the `#435` guards
  are always in scope.
- `stdin`: ignored. `stdout` / `stderr`: continuously drained;
  `--verbose` streams live, otherwise the runner prints a tail on
  non-zero exit.
- Exit code: authoritative gate. The parsed pass/fail/expect counts are
  summary-only — a mismatch between counts and exit code always resolves
  against the exit code (i.e., silent green-washing via count-parse tricks
  is impossible).
- Signals: on `SIGINT` / `SIGTERM` the runner forwards to every live
  child, then cleans up temp dirs before propagating exit.

## `test:raw` is diagnostic-only

The former `test` script (`bun test src/`) is preserved as `test:raw`.
It prints a stderr warning that it will reproduce the singleton /
port / DB conflicts under `#434` and is not a CI gate. Use it when you
need to see the interleaved log lines of the two integration suites at
the same time; use `bun run test` for anything else.

## CLI shape

```
bun run scripts/test-runner.ts [--suite=<manifest-path>] [--verbose]
```

- `--suite=<path>` — filter to a single manifest entry (exact match).
  Pattern-based filtering is not offered; the manifest is the source
  of truth for what runs.
- `--verbose` / `-v` — stream child stdout/stderr live instead of
  buffering.

Concurrency is fixed at 1 in this PR — the runner runs isolated suites
serially, then the shared_unit child. Opening `--concurrency=N` is
deferred until we have live evidence it stays deterministic.

## Reproducibility check

```
for i in 1 2 3; do bun run test | tail -6; done
```

Expected: three identical `total pass / total fail / total expects`
lines. Per-suite wall-clock times may vary slightly; counts and exit
codes must not.

## Related

- Issue: #434 (this)
- Related: #435 (`DATABASE_URL` reject guard) — the runner is the
  operational half of #435's "ordinary test commands explicitly unset
  DATABASE_URL" requirement.
- RFC tracking: #428.
