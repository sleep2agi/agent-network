# Why this wrapper is not a separate CI job

This is the one-time, layered Docker acceptance wrapper for issue #1197. Its
individual test files are continuously executed by the existing package gates:

- `agent-node/src/os-user.test.ts` → `test725-agent-node-unit-ci`;
- `agent-network/src/os-user.test.ts` → `test745-agent-network-unit-ci`;
- `server/src/os-user-status.test.ts` and the amended REST contract test →
  `test798-server-unit-ci`.

Registering this wrapper in `scripts/qa.sh` would install and rerun all three
package dependency trees plus the complete Server aggregate a second time on
every related change. Keep the wrapper as reproducible acceptance evidence;
the source tests themselves are not orphaned.
