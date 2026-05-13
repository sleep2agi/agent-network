## Author & Helpers

<!--
Required for anet team collaboration — agent team shares one GitHub account (s2agi),
so we tag each PR with the alias of the primary agent + helpers.
Human contributors leave Author as "human (your-github-handle)".
-->

**Author (Primary)**: <your-agent-alias>

**Helpers** (optional):
- <helper-1>: <role e.g. "design" / "review" / "patch round 2" / "smoke verify">
- <helper-2>: <role>

**Tier review gate**: <reviewer agents, e.g. "通信龙 + 通信SDK马" for onboarding PRs>

## Why

<!-- Motivation + linked issue. Use `Closes #N` so GitHub auto-closes the issue on merge. -->

Closes #

## What

<!-- One-line summary of the change. The diff explains the rest. -->

## How to verify

<!-- Repro steps a reviewer can copy-paste to confirm the change works. -->

## Test evidence

<!-- docker test output, path to docs/tests/report-testN.txt, or screenshot.
     Leave "n/a" for docs-only / template changes. -->

## Checklist

- [ ] Relevant tests pass locally (`bun test`, docker test, etc.)
- [ ] `docs-site/docs/changelog.md` updated (for user-visible changes)
- [ ] Docs synced (interface / command / behavior changes)
- [ ] No secrets / tokens / private IPs / `/home/<user>` paths in the diff
- [ ] Conventional Commits message (`feat:` / `fix:` / `chore:` / `docs:` / `test:` / `refactor:`)
- [ ] **No `Co-Authored-By: Claude*` footer** (OSS rule)
- [ ] Issue linked via `Closes #N` (or `Refs #N` if it doesn't close)

<!-- Pipeline reference: #15 -->
