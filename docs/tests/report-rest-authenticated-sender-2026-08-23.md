# REST authenticated sender attribution — 2026-08-23

## Scope

`POST /api/task` now uses the authenticated username when a user-token caller
omits `from`. Explicit legacy `from` values remain supported, node tokens stay
bound to their node alias, and an auth context with no resolvable identity keeps
the legacy `api` fallback.

## Docker verification

- Image: `tests/test798-server-unit-ci/Dockerfile`
- Runtime: Bun 1.3.14, Node.js 22.23.2, non-root uid 1000
- Server test files discovered: 72
- Server test files executed: 72
- Failed files: 0
- Witnessed-red mutation: registration password floor weakening failed as expected
- Result: PASS

