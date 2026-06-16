# Incident retro — `rm -rf $HOME` wipe (2026-06-16 07:26 BJT)

**Status**: Resolved (cloud-snapshot recovery, guardrails shipped)
**Severity**: P0 — user data loss
**Reporter**: Vincent (direct), via 总指挥 escalation
**Author**: 通信工程马
**Date**: 2026-06-16

## Summary

A test script in `agent-orchestra/tests/` ran `rm -rf $HOME` where `$HOME` had fallen back to the **real** host home directory `/home/vansin`. Multiple unrelated user projects were wiped: `ai-insight/`, `blueleap/`, `paper/`, others. **Cloud snapshot recovered all data**, so the incident is closed from a data-loss perspective — but the underlying class of bug had ~40 vulnerable scripts in the repo. Guardrails shipped same day.

## Timeline (Beijing time, 2026-06-16)

| Time | Event |
|---|---|
| 07:26 | `tests/test-new-user-flow.sh` runs in a context where `export HOME=/tmp/test-new-user-$$` does not take effect (suspected: parent shell HOME bleeds through, or `$$` race / `set -e` exit before export). `rm -rf $HOME` resolves to `/home/vansin`. |
| 07:26 | Vincent notices project dirs gone. Files removed include `ai-insight/`, `blueleap/`, `paper/`. |
| 07:30 | Cloud snapshot identified, restore initiated. |
| ~08:00 | Restore complete; all projects back. |
| ~10:00 | Vincent escalates via 总指挥 → 通信龙 (dispatch `0c9a2505`) → 通信工程马 (this owner). |
| 11:00 | 总指挥 had already added a `TEST_HOME + /tmp` guard to `test-new-user-flow.sh`. |
| 11:20 | 通信工程马 audit: 40 more scripts with the same pattern. |
| 11:30 | #1 quick-fix shipped: `tests/test31-claude-code-cli-resume/run.sh` inline guard (commit `e94f284`). |
| 14:30 | #2 full sweep shipped: `tests/lib/safe-rm.sh` + automated transformation of 40 scripts (commit `826c8a7`). |
| 15:30 | #3 CI linter shipped: `tests/scripts/lint-no-bare-rm-rf.sh` (this commit). |
| 15:35 | #5 retro + RFC-023 shipped: this file + RFC sketch for agent-node Bash tool guard. |

## Root cause

Two-layer:

**Surface layer**: `tests/test-new-user-flow.sh` (and 40 others) used the pattern `export HOME=/tmp/test-new-user-$$ ; ... ; rm -rf $HOME`. Safe only if the export sticks. Anything that bypasses the export (shell shadowing, subshell, early-exit-then-resume, parent shell with conflicting `set -e`) leaves `$HOME` pointing at the real home.

**Structural layer**: No pre-`rm` validation that the target falls under `/tmp/*`. The test design assumed "the export will always work" without enforcing it. One uncaught exception in the assumption → catastrophic data loss.

## Why this slipped

1. **Pattern reuse**: the `export HOME=/tmp/...$$; rm -rf $HOME` idiom predates 40 scripts. Authors copied it without thinking about the fail-open case.
2. **CI didn't lint**: nothing scanned for `rm -rf $VAR` patterns.
3. **`--dangerously-skip-permissions` is anet's default**: when this same pattern reaches an agent's Bash tool, there's no review step either.
4. **No prior incident triggered awareness**: the pattern looked safe in dev because dev shells reliably exported HOME correctly. The failure mode requires a specific environment shift.

## Fixes (defense in depth)

| Layer | Fix | Status | Ref |
|---|---|---|---|
| Single highest-risk script | Inline `case $X in /tmp/*)` guard | Shipped | commit `e94f284` |
| All 40 test scripts | `tests/lib/safe-rm.sh` helper + sweep | Shipped | commit `826c8a7` |
| New scripts | `tests/scripts/lint-no-bare-rm-rf.sh` CI guard | Shipped (this commit) | — |
| LLM Bash tool (agent-node) | RFC-023 sketch | Proposed | `docs/rfcs/RFC-023-destructive-command-guardrail.md` |
| Documentation | This retro + RFC-023 cross-ref | Shipped (this commit) | — |

## Lessons banked

1. **Never rely on `export VAR=...` alone for destructive operations.** Always validate the resolved path under an allow-list right before the `rm`.
2. **Treat `rm -rf $VAR` as a class of bugs, not an individual mistake.** Sweep the entire codebase whenever one is found.
3. **Add CI lint as soon as a fix exists.** A linter prevents the next author from re-introducing the same pattern.
4. **The same defense pattern applies to LLM-driven Bash tools.** RFC-023 propagates the test-side fix to the agent-side execution path.

## Refs

- 通信龙 dispatch `0c9a2505` (P0 sweep order)
- `tests/lib/safe-rm.sh` (defense)
- `tests/scripts/lint-no-bare-rm-rf.sh` (regression prevention)
- `docs/rfcs/RFC-023-destructive-command-guardrail.md` (LLM Bash tool variant)
- `[[feedback_no_host_test_nodes]]` (sibling red line — "don't run test nodes on the host")
- `[[feedback_default_flags]]` (`--dangerouslySkipPermissions` default)
