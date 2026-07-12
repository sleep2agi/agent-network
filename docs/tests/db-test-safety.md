# db-adapter test-safety guard (issue #435)

## Rule

Under `NODE_ENV=test`, `createAdapter()` refuses **any** inherited
`DATABASE_URL` — regardless of value or URL scheme — before constructing
`PgAdapter`, before opening a socket, and before the SQLite default-path
guard runs. Production behavior (`NODE_ENV != "test"`) is unchanged.

There is no opt-in bypass in this build. A future isolated PostgreSQL
test harness will land under a separate RFC/issue with explicit review.

## Rationale

`createAdapter()` on `main` at `d418862` selected the PostgreSQL branch
BEFORE the SQLite test guard fired. A developer machine, CI worker, or
container that inherited a production PostgreSQL URL could therefore
open a socket to production PostgreSQL from inside `bun test` and hammer
prod. The current machine had `DATABASE_URL` unset, so no incident is
known — but the ordering hole was live.

## Reproducing the negative case (operator's actionable check)

Run from the repository root (path is relative to CWD). A bare
`require(...).createAdapter()` top-level expression does not reliably
surface a non-zero exit code under Bun 1.3.14 — wrap in an explicit
try/catch as the automated test does:

```
env -u COMMHUB_DB NODE_ENV=test \
  DATABASE_URL='postgres://fake:pw@127.0.0.1:5432/commhub' \
  bun -e "const m = require('./server/src/db-adapter.ts'); \
          try { m.createAdapter(); process.exit(0); } \
          catch(e) { console.error(e.message); process.exit(2); }"
```

Expected: process exits `2`. `stderr` contains
`REFUSING to honor inherited DATABASE_URL`. The banner
`[commhub] database: PostgreSQL` is **never** printed — that line only
runs after `resolveDatabaseTarget()` returns a `postgres` discriminant,
and the guard short-circuits before then.

## Reproducing the syscall-level proof (independent Linux verification)

Use `strace -f` so all bun worker threads are traced, then assert on
two distinct evidence streams (do NOT try to shoehorn both into one
regex — strace's `connect()` argument shape hides the port inside a
`sin_port=htons(...)` field, so a naive `connect\([^)]*:5432` pattern
false-negatives on typical output):

```
# Negative case: NODE_ENV=test + fake DATABASE_URL, both DB vars given
# via `env` so no shell leak. Run once, split the log two ways.

strace -f -o /tmp/strace-435.log -e trace=connect,openat \
  env -u COMMHUB_DB NODE_ENV=test \
  DATABASE_URL='postgres://fake:pw@prod:5432/commhub' \
  bun -e "const m = require('./server/src/db-adapter.ts'); \
          try { m.createAdapter(); process.exit(0); } \
          catch(e) { console.error(e.message); process.exit(2); }"

# (1) All connect() syscalls — MUST be zero for this negative path.
#     Nothing legitimate connects here; any hit is a regression.
grep -c 'connect(' /tmp/strace-435.log

# (2) Optionally scope to the postgres port. sin_port is the field
#     name strace prints; matching the whole family+port fragment is
#     the safe pattern.
grep -E 'connect\([^)]*sin_port=htons\(5432\)' /tmp/strace-435.log | wc -l

# (3) Default SQLite path — MUST be zero.
grep -E 'openat\([^)]*\.commhub/commhub\.db' /tmp/strace-435.log | wc -l
```

Expected: (1) `0`, (2) `0`, (3) `0`. Any non-zero count means the
guard regressed and either PostgreSQL was dialed (or any socket at
all was opened) or the default SQLite path was touched before refusal.

Running (2) alone is insufficient because it presumes attack traffic
uses 5432. Line (1) is the authoritative negative — every `connect()`
during this refusal path is a bug — and (2)+(3) narrow the diagnostic
if (1) ever regresses.

## Restrictions on tests

- Ordinary test commands **must** `unset DATABASE_URL` before invoking
  `bun test`. See #434 for the aggregate-runner change that enforces
  this per child process.
- Tests **must not** contact a real external database endpoint. The
  production-branch regression is covered by pure-helper unit tests
  (`resolveDatabaseTarget(env)` returns a `postgres` discriminant
  without constructing `PgAdapter`).
- The subprocess negative test uses a fake-prod URL that is never
  dialed; the guard short-circuits before any socket is opened.

## Related

- Issue: #435 (this)
- Historical isolation debt: #434
- RFC tracking: #428
- Test file: `server/src/db-adapter-guard.test.ts`
- Product code: `server/src/db-adapter.ts` — `assertSafeTestDatabaseEnv`,
  `resolveDatabaseTarget`, `createAdapter`
