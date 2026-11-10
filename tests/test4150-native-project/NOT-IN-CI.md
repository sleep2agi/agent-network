# NOT-IN-CI

Isolated acceptance harness, not a CI suite.

`run.sh` drives the **test-only** patched native build
(`2.0.22-anet-test.29040e2`, SHA-256 pinned inside `agent-node/src/cli.ts`)
through an offline sandbox. The binary is not a published artifact, so CI cannot
reproduce these project-new / attach lanes; the README records each lane's
commands and boundaries.

Product-level coverage of the same contracts lives in the CI suites:
`server/src/session-project-*.test.ts` and `server/src/session-source-*.test.ts`
(server unit).

Verified: 2026-11-08
Revisit-when: the `2.0.22-anet-test.*` overlay build is published as a
downloadable, integrity-pinned artifact that a CI runner may fetch.
