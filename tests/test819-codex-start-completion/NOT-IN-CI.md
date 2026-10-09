Verified: 2026-10-09
Revisit-when: This runner adds assertions not present in the existing server-unit / agent-node-unit collectors.

# Focused local reproduction, already collected by CI

This wrapper runs three agent-node runtime test files and server/src/start-node.test.ts.
The existing agent-node-unit and server-unit jobs in .github/workflows/qa.yml
collect those files (test725 and test798 respectively). No assertion lives only
in this wrapper, so a second CI matrix entry would duplicate the same coverage.
The start-daemon tests include a real spawned child that exits nonzero after launch.
