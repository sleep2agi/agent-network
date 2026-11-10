# NOT-IN-CI

Isolated acceptance harness, not a CI suite.

`run.sh` mounts the **test-only** patched native build
(`/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode`,
version `2.0.22-anet-test.29040e2`, SHA-256 pinned inside
`agent-node/src/cli.ts`) and runs with `--network none`. The binary is not a
published artifact, so CI cannot reproduce this run.

Product-level coverage of the same code lives in the CI suites:
`server/src/session-source-*.test.ts` (server unit) and the agent-node
typecheck ratchet.

Verified: 2026-11-08
Revisit-when: the `2.0.22-anet-test.*` overlay build is published as a
downloadable, integrity-pinned artifact that a CI runner may fetch.
