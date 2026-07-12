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

```
NODE_ENV=test DATABASE_URL='postgres://fake:pw@127.0.0.1:5432/commhub' \
  bun -e "require('./server/src/db-adapter.ts').createAdapter()"
```

Expected: process exits non-zero. `stderr` contains
`REFUSING to honor inherited DATABASE_URL`. The banner
`[commhub] database: PostgreSQL` is **never** printed — that line only
runs after `resolveDatabaseTarget()` returns a `postgres` discriminant,
and the guard short-circuits before then.

## Reproducing the syscall-level proof (independent Linux verification)

```
strace -ff -e trace=connect,openat \
  env NODE_ENV=test DATABASE_URL='postgres://fake:pw@prod:5432/commhub' \
  bun -e "require('./server/src/db-adapter.ts').createAdapter()" 2>&1 \
  | grep -E 'connect\([^)]*:5432|openat.*\.commhub/commhub\.db'
```

Expected: zero matching lines. Any match means the guard regressed and
either PostgreSQL was dialed or the default SQLite path was opened
before refusal.

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
