# CommHub v0.9.0-preview.106

This release carries the Hub changes merged since `0.9.0-preview.105`. Production is on `0.9.0-preview.105`. It is built from main at d3e73242 plus this version bump.

Hub (`server/`) changes since `.105` (the `.105` bump was #2406, ecb0c78c):

- #2410 (d3e73242) **`create_node` accepts `node_spec.flags.copresence` for `codex-app-server` (#584).**
  - Before: the app's 「Codex（TUI 共存）」 option produced a headless node, and `create_node` had no field that could say "co-presence": `flags.copresence` was rejected with `flag_key_unknown`.
  - Now: `copresence` is in `FLAG_KEYS` and must be a boolean (`flag_value_invalid` otherwise). A new cross-field check `validateFlagsForRuntime` accepts it only for `codex-app-server`; any other runtime gets `flag_not_applicable_to_runtime` (detail `{field: "copresence", runtime, applicable: ["codex-app-server"]}`) instead of silently starting headless. `buildAnetArgs` emits the CLI's bare `--copresence` for `true` and nothing for `false`. The flag is stored in the request's `flags_json` like the other flags.
  - The daemon half (turning the flag into the child config's `codexCopresence: true`) ships in agent-node `2.5.0-preview.113`; a `.112` or older daemon rejects the flag with `flag_key_unknown:copresence`, so the request fails visibly rather than producing a headless node.
  - Unchanged: requests without `flags.copresence` behave exactly as on `.105`. The `create_node` input schema is unchanged (`flags` is already `z.record(z.string(), z.unknown())`); only the server-side value check widens. `update_node_config` does not use `FLAG_KEYS` and is unaffected.
  - Evidence: `server/src/create-node-validate.test.ts` +4 tests witnessed red on the previous main e1e8ad2e (`validateFlagValue("copresence", true)` and `buildAnetArgs` threw `flag_key_unknown`); new Docker suite `tests/qa-create-node-codex-copresence` (real Hub + `anet daemon up`) PASS=13 FAIL=8 on e1e8ad2e → PASS=21 FAIL=0 with the fix. PR head e4d3b504 had 133/133 checks green.
- Not Hub: #2409 (release workflow registry polling) touches only `.github/`. `git log ecb0c78c..origin/main -- server/` lists only #2410.

## Schema and settings

No schema change: no new tables, columns or indexes. No new environment variables; all defaults unchanged. `hub.env` is not touched by this release.

## Checked

- **`tests/hub-release-compat`:**
  - Setup: candidate e3a3650c (main d3e73242 plus this version bump; `server/` identical to this PR, dirty_files=0), baseline `0.9.0-preview.105` from npm, apps desktop-v0.2.206 / .207 / .208 / .209 (newest app tag), `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.105 NEW_LABEL=.106`.
  - Self-test (`bun tests/hub-release-compat/tools-compat-selftest.ts`, Docker `oven/bun:1.3.14`, `--network none`): PASS; all known-bad controls go red (property removed, property retyped, new required param, tool removed, `additionalProperties` flipped).
  - A1 and A2: steps=62, unexpected=0, check_failures=0. `mcp.tools_list`: 74 → 74 tools, no new tools, no new params.
  - B upgrade → rollback → re-upgrade (.105 → .106 → .105 → .106 on one database): upgrade_check_failures=0, full list byte-identical across all four steps.
  - Afterwards `pgrep -af "/tmp/tmp\..*/bin/commhub-server"` found no throwaway Hub left running.
- **Coverage note:** the replay compares `create_node`'s input schema, which is unchanged because the new key lives inside the existing free-form `flags` record, so no diff is expected and none was suppressed. The replay does not send `flags.copresence`; the #584 evidence is the witnessed-red unit tests and the PR's Docker suite above.

## Old app × new Hub

The desktop app (checked desktop-v0.2.209, `handleSubmit` in `src/CreateNodeWizardScreen.tsx`) sends `node_spec.flags` with only `permissionMode` and optionally `maxTurns` / `budget` / `timeout`; it never sends `copresence`. `validateFlagsForRuntime` returns immediately when the key is absent, so the shipped app's `create_node` requests are accepted and processed exactly as on `.105` (still headless for `codex-app-server`). Only an app that adds `flags.copresence: true` (not shipped yet) sees the new behaviour, and it needs this Hub plus a daemon on agent-node ≥ `2.5.0-preview.113`.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.106`, channel preview.

Promote `must_contain`: `flag_not_applicable_to_runtime` (present in this tree's `server/src/create-node-validate.ts`; the `.105` tarball from npm gives 0 hits, the packed `.106` tarball gives 2 — `src/create-node-validate.ts` and its test — checked 2026-10-06).

## Production plan

1. Install into a new runtime `~/.commhub/runtime-v95-preview106`; boot it once on a throwaway Hub (`env -i HOME=$(mktemp -d)`, random port, temporary DB) and check `/health` reports `0.9.0-preview.106`.
2. Announce the restart time to the owner first (about 5 s of downtime), then switch the launcher's `RUNTIME_DIR` from `runtime-v94-preview105` to `runtime-v95-preview106` and restart through the launcher. `hub.env` unchanged. Back up launcher + database first.
3. Health must report `0.9.0-preview.106` within 30 s, otherwise roll back automatically. Watch 10 minutes.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.106
```

The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.106
```

No migration runs. Existing settings keep their meaning.

## Rolling back

Rolling back to `0.9.0-preview.105` (`RUNTIME_DIR` back to `runtime-v94-preview105`) is safe: no schema change, so `.105` reads the same database. After a rollback, `create_node` with `flags.copresence` is rejected again with `flag_key_unknown`.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
