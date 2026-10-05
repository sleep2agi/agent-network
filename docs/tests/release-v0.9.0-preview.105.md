# CommHub v0.9.0-preview.105

This release carries the Hub changes merged since `0.9.0-preview.104`. Production is on `0.9.0-preview.104`. It is built from main at 5b379394 plus this version bump.

Hub (`server/`) changes since `.104` (the `.104` bump was #2395, 21467508):

- #2403 (5b379394) **`stop_node` / `delete_node` refuse hand-started nodes even when the caller names a daemon (#571).**
  - Before: a node with no creator/daemon link (id not starting with `node_`, i.e. started by hand with `anet node start`) was refused with `not_daemon_managed` only when the caller passed no `daemon_node_id`. If the caller named any daemon in the same network, the Hub accepted it, wrote a stop/delete request row and rang that daemon. That daemon has no record of the node, so on `.104`-era agent-node it fell back to `pgrep` by alias across its whole machine and SIGTERMed every agent-node with that alias (any workdir, HOME or network), then acked `stopped`; for `delete_node` the ack then removed the node's Hub row.
  - Now: for a hand-started node (`resolveDaemonForChild` finds no creator and the id does not start with `node_`), both tools return `not_daemon_managed` whatever `daemon_node_id` says. No request row is written and `lifecycle_state` is not touched. The message now adds "(naming a daemon_node_id does not change that)" and still points at `anet node stop <alias>` on that machine.
  - Unchanged: daemon-created children (create record present) stop and delete as before; `node_` ids whose create record was pruned still accept an explicit `daemon_node_id` (the documented way out); `daemon_child_mismatch` is unchanged. Tool input schemas are unchanged.
  - Evidence: the new case in `server/src/stop-delete-node.test.ts` run against the `.104` server tree (21467508) fails on its first assertion (`stop_node` with an explicit daemon returned `ok: true`), and passes on main (5b379394), where the whole file is 48 pass / 0 fail (Docker `oven/bun:1.3.14`, throwaway `COMMHUB_DB`, run 2026-10-05). The PR's end-to-end suite `tests/test571-lifecycle-safety` (real Hub + real daemon + same-alias processes) scenario S3 covers this path: PASS=20 FAIL=13 on 3c045290, PASS=33 FAIL=0 with the fix. PR head 395d334f had 131/131 checks green.
  - The same PR also changes the daemon (`agent-node`: a stop for a child the daemon has no record of is refused with `not_my_child`, orphan sweeps require `--alias` and the daemon's own `--config`) and `anet project up` (keeps a live `.pid`). Those ship with their own packages, not with this Hub release.
- Not Hub: #2402 and #2404 (anet `--remote` node management and remote restart/model change) touch only `agent-network/`, `docs/`, `docs-site/`, `tests/` and `.github/`; the remaining commits since `.104` are docs-site only. `git log 21467508..origin/main -- server/` lists only #2403.

## Schema and settings

No schema change: no new tables, columns or indexes. No new environment variables; all defaults unchanged. `hub.env` is not touched by this release.

## Checked

- **`tests/hub-release-compat`:**
  - Setup: candidate b1b0d31b (main 5b379394 plus this version bump; `server/` identical to this PR, dirty_files=0), baseline `0.9.0-preview.104` from npm, apps desktop-v0.2.206 / .207 / .208 / .209 (newest app tag), `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.104 NEW_LABEL=.105`.
  - Self-test (`bun tests/hub-release-compat/tools-compat-selftest.ts`, Docker `oven/bun:1.3.14`, `--network none`): PASS; all known-bad controls go red (property removed, property retyped, new required param, tool removed, `additionalProperties` flipped).
  - A1 and A2: steps=62, unexpected=0, check_failures=0.
  - B upgrade → rollback → re-upgrade (.104 → .105 → .104 → .105 on one database): upgrade_check_failures=0, full list byte-identical across all four steps.
  - Afterwards `pgrep -af "/tmp/tmp\..*/bin/commhub-server"` found no throwaway Hub left running.
- **Coverage note:** the replay only compares the input schemas of `stop_node` / `delete_node` (unchanged, so no diff); it never calls them on a hand-started node, so it cannot observe #571 either way. Nothing was suppressed. The #571 evidence is the witnessed-red unit test and the PR's `test571` end-to-end run above.

## Old app × new Hub

The desktop app (checked desktop-v0.2.209, `runNodeLifecycleAction` in `src/api.ts`) calls `stop_node` / `delete_node` with `child_node_id` (+ `network_id`, `confirm_alias`, `force`, `delete_config`) and **never passes `daemon_node_id`**. For a hand-started node `.104` already returned `not_daemon_managed` on that request shape (the `daemon_node_id ?? resolveDaemonForChild` path), and the app also disables the stop/delete buttons when the Hub reports `lifecycle_controllable=false`. So the shipped app sees no change: it shows the same error as before. Only callers that name a daemon explicitly (CLI/scripts) see the new refusal.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.105`, channel preview.

Promote `must_contain`: `naming a daemon_node_id does not change that` (present in this tree's `server/src/tools.ts`; the `.104` tarball from npm gives 0 hits, checked 2026-10-05). Do **not** use `not_daemon_managed`: it already appears 4 times in the `.104` tarball (`src/tools.ts`, `src/node-id-alias.test.ts`).

## Production plan

1. Install into a new runtime `~/.commhub/runtime-v94-preview105`; boot it once on a throwaway Hub (`env -i HOME=$(mktemp -d)`, random port, temporary DB) and check `/health` reports `0.9.0-preview.105`.
2. Announce the restart time to the owner first (about 5 s of downtime), then switch the launcher's `RUNTIME_DIR` from `runtime-v93-preview104` to `runtime-v94-preview105` and restart through the launcher. `hub.env` unchanged. Back up launcher + database first.
3. Health must report `0.9.0-preview.105` within 30 s, otherwise roll back automatically. Watch 10 minutes.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.105
```

The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.105
```

No migration runs. Existing settings keep their meaning.

## Rolling back

Rolling back to `0.9.0-preview.104` (`RUNTIME_DIR` back to `runtime-v93-preview104`) is safe: no schema change, so `.104` reads the same database. After a rollback, a stop/delete that names a daemon for a hand-started node is accepted again.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
