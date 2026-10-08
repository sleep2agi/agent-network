Verified: 2026-10-09
Revisit-when: Any test file below is removed from the complete server-unit collector, or this runner gains assertions that the collector does not execute.

# Focused local reproduction, covered by existing CI

This Docker runner executes only `server/src/node-permissions-http.test.ts`,
`server/src/schedule-agent-mcp-http.test.ts` and
`server/src/tool-audience-http.test.ts`. All are discovered by
`server/scripts/test-aggregate.ts` and run in the existing `server-unit` job in
`.github/workflows/qa.yml` (`tests/test798-server-unit-ci/`). The schedule test
also runs in the PostgreSQL ladder.

The wrapper has no additional assertions. A separate matrix entry would run
the same tests again. Keep this Dockerfile as the small local reproducer;
the behavior tests are not exempted from CI. Local validation: 15 + 19 + 12 tests
passed; see `docs/tests/report-test816-schedule-batch-interval.txt`.
