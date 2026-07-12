// #434 — exhaustive test manifest.
//
// The aggregate runner (scripts/test-runner.ts) uses this manifest to
// decide, per test file, whether the file needs its own isolated Bun
// child process (an integration suite that binds `Bun.serve` and/or
// mutates module-singleton state via `./db` and `./index`) or can share
// a single child with the rest of the pure-unit files.
//
// Registration is required for EVERY `*.test.ts` under `server/src/`.
// The runner performs a set-equality check between the union of both
// arrays here and the filesystem enumeration at start; a missing or
// extra entry fails the whole run before any test executes. That way
// a future PR that introduces a new integration suite cannot silently
// regress the isolation contract by defaulting to the shared child.
//
// Two kinds:
//
//   isolated_server — imports `./index.js` and calls `bootServer(...)`
//     (or otherwise starts `Bun.serve`), or holds any module-level
//     singleton that would race under a shared runtime (e.g. an
//     integration DB). Each such suite gets its own Bun.spawn child.
//
//   shared_unit — pure logic / DB-only fixture code that is safe to
//     load in a single shared child. If we later find one of these is
//     silently polluting shared state, promote it to isolated_server
//     rather than adding runtime workarounds that would hide the
//     leak (per #434 acceptance line "don't hide with assertion
//     changes").
//
// Paths are relative to `server/` and end in `.test.ts`.

export const ISOLATED_SERVER_SUITES: readonly string[] = [
  "src/api-host-supervisors-fallback.test.ts",
  "src/uploads-http.test.ts",
] as const;

export const SHARED_UNIT_SUITES: readonly string[] = [
  "src/ack-create-request.test.ts",
  "src/api-nodes-shape.test.ts",
  "src/auth-kdf-migration.test.ts",
  "src/auth-tokens.test.ts",
  "src/auth-validate.test.ts",
  "src/auth_login_guard.test.ts",
  "src/config-apply-sec1.test.ts",
  "src/config-apply-validate.test.ts",
  "src/create-node-validate.test.ts",
  "src/create-node.test.ts",
  "src/cross-tenant-injection.test.ts",
  "src/list-host-supervisors.test.ts",
  "src/password-dict.test.ts",
  "src/probe-validate.test.ts",
  "src/probe.test.ts",
  "src/push.test.ts",
  "src/response-charset.test.ts",
  "src/retention.test.ts",
  "src/send_dedup.test.ts",
  "src/shared/probe-host-allowlist-drift.test.ts",
  "src/shared/reserved-env-drift.test.ts",
  "src/shared/reserved-env.test.ts",
  "src/stale-sweeper.test.ts",
  "src/stop-delete-node.test.ts",
  "src/update-provider.test.ts",
  "src/uploads.test.ts",
  "src/vault.test.ts",
  // Runner's own hermetic self-test — proves inheritance-of-fake-prod
  // DATABASE_URL becomes UNSET in the spawned child (issue #434 rule 9,
  // #435 double-safety). Doesn't need isolation; validates spawn env.
  "scripts/test-runner-self.test.ts",
] as const;

/** All manifest-registered suites, as a `Set` for fast lookup. */
export function manifestSet(): Set<string> {
  return new Set<string>([...ISOLATED_SERVER_SUITES, ...SHARED_UNIT_SUITES]);
}
