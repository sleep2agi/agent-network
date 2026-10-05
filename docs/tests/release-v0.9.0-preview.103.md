# CommHub v0.9.0-preview.103

This release carries the Hub changes merged since `0.9.0-preview.102`. Production is on `0.9.0-preview.102`. It is built from main at b9700b93 plus this version bump.

Hub (`server/`) changes since `.102` (the `.102` bump was #2364), oldest first:

- #2384 (b9700b93) **Due reminders can be limited to listed card owners: `COMMHUB_DUE_REMINDERS_OWNERS` (#524).**
  - Our team and the TM team share one network, so the network allowlist (`COMMHUB_DUE_REMINDERS_NETWORKS`) cannot limit due reminders to us. The new owner allowlist can.
  - `COMMHUB_DUE_REMINDERS_OWNERS=<user id,user id>`: only cards whose owner is on the list are scanned. For those cards the owner, the participants and the agent owner are reminded as before. Cards owned by anyone else, and cards with no owner, get no reminder and no dedupe row.
  - Same semantics as `COMMHUB_DUE_REMINDERS_NETWORKS`: it also turns reminders on while `COMMHUB_DUE_REMINDERS=0`; an empty value, or one with only spaces and commas, counts as unset; it is ANDed with the network allow/exclude lists.
  - Applied in the candidate `SELECT` as `owner_json IN (…)` over exact `{"kind":"user","id":…}` refs (the same shape as the list `?owner=` filter). The parameters are bound only when the list is set, because PostgreSQL rejects bound-but-unused parameters.
  - No backlog per person: a `(network, owner)` baseline row (`kind='baseline_owner'`, `due_on` = user id) records when the owner entered scope, and "overdue" is measured against the later of the network and owner baselines. Retention keeps both baseline kinds.
  - The startup scope log line gains `; only cards owned by <user id>` (ids only).
  - Evidence: PR #2384 head had 127/127 checks green. Re-run for this note in Docker (`oven/bun:1.3.14`, the tree at b9700b93): `bun test src/requirement-due-reminders-http.test.ts` → 29 pass, 0 fail, 240 `expect()` calls, including the five new `#524` cases (scope parsing / blank = unset / params bound only when used; `=0` + owner list starts the timer and logs ids only; in one network only listed owners' cards are reminded, owner + agent owner; an owner added later gets no backlog).
- Not Hub: #2382 (b5f0e02c) changes `deploy/hub/hub-daemon.sh`, see **Deploy notes**. #2358, #2365, #2368, #2369, #2372–#2374, #2377, #2378, #2380, #2381 (anet / agent-node) ship with their own packages (#2366, #2370, #2376, #2379, #2383 were those releases); #2367, #2371, #2375 are docs-site updates.

## Schema and settings

No schema change: no new tables, columns or indexes. `requirement_due_reminders` gets rows of a new `kind` value (`baseline_owner`) only when `COMMHUB_DUE_REMINDERS_OWNERS` is set.

One new environment variable, `COMMHUB_DUE_REMINDERS_OWNERS`, unset by default. With it unset nothing changes; the defaults of all existing settings are unchanged.

## Deploy notes (not in the npm package)

#2382 (b5f0e02c) changed the production launcher `deploy/hub/hub-daemon.sh`, which is not part of `@sleep2agi/commhub-server`. Before sourcing `hub.env`, it now unsets inherited node/agent identity variables (`COMMHUB_TOKEN`/`ALIAS`/`NODE_ID`, `ANET_NODE_MARKER`, `TMUX`, and the `CLAUDE_CODE_*` / `CODEX_*` / `GROK_*` prefixes), so a Hub restarted from inside a node session no longer carries that node's token in `/proc/<hub>/environ`. `hub.env` still wins, and only names are logged. Covered by `tests/test2124-hub-launcher-env-scrub` (Docker, registered in qa.yml). It takes effect on the machine only when the deployed launcher copy is updated; this package does not change it.

## Checked

- **`tests/hub-release-compat`:**
  - Setup: candidate 5dc0b8da (b9700b93 plus this version bump; its `server/` tree is identical to this PR's), baseline `0.9.0-preview.102` from npm, apps desktop-v0.2.206 / desktop-v0.2.207 / desktop-v0.2.208 / desktop-v0.2.209 (the newest app tag), `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.102 NEW_LABEL=.103`.
  - Self-test (`bun tests/hub-release-compat/tools-compat-selftest.ts`): 8/8 PASS; all five known-bad controls go red (property removed, property retyped, new required param, tool removed, `additionalProperties` flipped).
  - A1 and A2: steps=62, unexpected=0, check_failures=0. Each of desktop-v0.2.206–.209 ignores the candidate's `member_presence` events.
  - B upgrade → rollback → re-upgrade (.102 → .103 → .102 → .103 on one database): upgrade_check_failures=0; full list byte-identical across all three switches.
  - Afterwards `pgrep -af "/tmp/tmp\..*/bin/commhub-server"` found no throwaway Hub left running, and no compat container was still up.
- **Unit:** `requirement-due-reminders-http.test.ts` 29/29 in Docker (see #2384 above).

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.103`, channel preview.

Promote `must_contain`: `COMMHUB_DUE_REMINDERS_OWNERS` (the promote gate runs `grep -rq` over `package/`; the `.102` tarball from npm gives 0 hits, this tree's `server/src` has it).

## Production enablement plan

After `.103` is installed on production and healthy:

1. Add to `hub.env`: `COMMHUB_DUE_REMINDERS_OWNERS=u_a4944afaa30b` (admin only). Leave `COMMHUB_DUE_REMINDERS=0` as it is: with `=0` and the owner list set, reminders run only for cards owned by admin, in every network, and nothing changes for any other owner (including the TM team in the shared network).
2. Announce the restart time first, then restart the Hub through the launcher.
3. Check the startup log for one scope line. With no network list set it reads `[due-reminders] scope: all networks; only cards owned by u_a4944afaa30b`; if `hub.env` also sets a network allow/exclude list, the network part shows that list and the line still ends in `; only cards owned by u_a4944afaa30b`.
4. No backlog: admin's cards that were already overdue before this restart get no reminder; only cards that become due/overdue after it do.

To turn it off again, remove the line from `hub.env` and restart.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.103
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.103
```

No migration runs. Existing settings keep their meaning.

## Rolling back

Rolling back to `0.9.0-preview.102` is safe: this release changes no schema, so `.102` reads the same database unchanged. `.102` does not know `COMMHUB_DUE_REMINDERS_OWNERS`; with `COMMHUB_DUE_REMINDERS=0` and only the owner list set, reminders are simply off again after a rollback. `.102` ignores `baseline_owner` rows and its 60-day retention prune may delete old ones; after a re-upgrade a missing owner baseline is recorded afresh, which only means no backlog from that moment.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
