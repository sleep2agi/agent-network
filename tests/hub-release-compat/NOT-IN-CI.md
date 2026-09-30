# Why hub-release-compat is not in per-PR CI

Verified: 2026-09-30
Revisit-when: the baseline stops being "the last published commhub-server on npm" and the
              app tags stop being clones of another repo — i.e. both sides come from this
              commit — or a release workflow grows a step that runs it before release-gate.

## What it is

A release-prep check for `@sleep2agi/commhub-server`, run once per Hub release before the
prep PR is pushed:

- **A** (run twice) replays the REST/MCP calls the desktop app makes against the last
  published Hub (`BASE_VERSION`, installed from npm) and against this tree's `server/`.
  Every step must return the same status and a superset shape (`compare.ts`).
  `mcp.tools_list` is compared per tool name (`tools-compat.ts`): a removed tool, a removed or
  retyped property, a changed `required` list or any other changed top-level `inputSchema`
  key is UNEXPECTED; new tools and new optional properties are additive.
- **B** runs upgrade → rollback → re-upgrade on one database (`run-upgrade.sh`).

```bash
BASE_VERSION=0.9.0-preview.74 bash tests/hub-release-compat/run.sh
# release-specific checks are opt-in, e.g. for .75:
BASE_VERSION=0.9.0-preview.74 CHECK_75=1 SCHED_BASELINE=counted \
  CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.74 NEW_LABEL=.75 bash tests/hub-release-compat/run.sh
```

## Why not per PR

Half of what it compares is not this commit: the baseline is a published npm version and the
app sources are tags of `sleep2agi/agent-network-app`. Its red/green therefore depends on
what was released outside this repo, which makes it a release check rather than a PR gate.
Each run also needs the network (npm and GitHub clones) and takes a few minutes.

## The self-test runs every time

`compare.ts` calls `toolsSelftest()` before comparing anything, so a blind comparator fails
the run. The self-test holds the recorded .74 → .75 `tools/list` pair (`fixtures/`, must be
additive only: `requirements_list` gains `view`, `changes`) and five controls that must be red:
property removed, property with only its `type` changed, a new required param on an existing
tool, a tool removed, `additionalProperties` flipped. Run it alone with
`bun tests/hub-release-compat/tools-compat-selftest.ts`.
