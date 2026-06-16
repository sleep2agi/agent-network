# RFC-023 — Destructive-command guardrail for agent-node bash tool

**Status**: Sketch (Vincent-gate, SDK马 lane implementation)
**Author**: 通信工程马
**Date**: 2026-06-16
**Drives from**: incident retro `docs/troubleshooting/rm-rf-incident-2026-06-16.md`
**Sibling shipped**: `tests/lib/safe-rm.sh` + linter (commit `826c8a7`) — same defense for the test-script attack surface

## Background

The 2026-06-16 `rm -rf $HOME` incident was triggered by a **test script** running with `$HOME` falling back to the real host home directory. Defense-in-depth has been shipped for the test-script attack surface (per-script inline guard, shared `safe_rm_rf` helper across 40 scripts, CI linter).

But the **same failure mode** is reachable from a different vector: an LLM-driven agent executing a `Bash` tool call. If an agent (claude-code-cli / claude-agent-sdk / codex-sdk / grok-build-acp) emits `rm -rf $HOME` and the runtime forwards it to a shell, the result is identical — only with a more politically embarrassing root cause (an AI agent wiped the user's data, vs. a test script).

agent-node currently has no pre-exec scanner on the Bash tool input. RFC-023 proposes one.

## Threat model

| Vector | Likelihood | Severity | Current defense |
|---|---|---|---|
| LLM hallucinates `rm -rf $HOME` to "clean up" | Medium | Critical | None |
| LLM `rm -rf /` ("disk full") | Low | Critical | None |
| LLM destructive `find ... -delete` against `$HOME` | Low | Critical | None |
| Prompt injection → `rm -rf` against `/home/<user>` | Medium | Critical | None |
| LLM in `--dangerously-skip-permissions` mode hits the above | Increased likelihood | Critical | None |

The Bash tool's current contract assumes the user reviews each call (claude-code-cli default permission mode). In `--dangerously-skip-permissions` (the anet default — see `[[feedback_default_flags]]`), nothing is reviewed. This RFC adds a server-side scanner that runs regardless of permission mode.

## Proposal

### Phase 1 — refuse `rm` against `$HOME`, `/`, `/home/`, `/root`, `~/`

agent-node's Bash tool handler runs a pre-exec scanner on the command string. If the command matches a "destructive against critical path" pattern, the tool returns a refusal error message instead of executing.

```ts
// agent-node/src/bash-guard.ts (new module)
const DESTRUCTIVE_VERBS = /\brm\s+-[rRf]+|\bfind\b.*-delete|\bshred\b|\bdd\s+if=.*of=/i;
const CRITICAL_PATHS = [
  process.env.HOME ?? "",
  "/",
  "/root",
  "/home",
  "/var",
  "/etc",
  "/usr",
];

export function classifyBashCommand(cmd: string): { allow: boolean; reason?: string } {
  if (!DESTRUCTIVE_VERBS.test(cmd)) return { allow: true };
  for (const p of CRITICAL_PATHS) {
    if (!p) continue;
    if (cmd.includes(p) || cmd.includes("$HOME") || cmd.includes("~/")) {
      return {
        allow: false,
        reason: `[guard] refuse: destructive command targets a critical path. ` +
                `If you actually need to clean up, use a /tmp/ subdirectory.`,
      };
    }
  }
  return { allow: true };
}
```

### Phase 2 — refuse based on resolved target

Phase 1 is string-pattern based, which an adversary can defeat (e.g. `rm -rf "$(realpath ~)"`). Phase 2 spawns a `shell -c "echo <target>"` subshell to resolve the actual paths the destructive verb would touch, then checks each against the allow-list.

Trade-off: subshell overhead per Bash tool call (~5ms). Acceptable for the safety margin.

### Phase 3 — opt-in allow-list

Like `SAFE_RM_ALLOW_PREFIXES` for tests, agents could request elevated trust via:

```ts
flags: { "bash-guard-allow-prefixes": ["/home/<user>/playground/", "/var/log/myapp/"] }
```

Per-node config, never auto-elevated from agent input. User reads + approves.

### Phase 4 — telemetry

Every refusal logs a `bash_guard_refuse` event to commhub. Operators can see which agents tried what, debug prompt-injection patterns, tune allow-lists.

## Open questions

1. **Performance budget** — Phase 2 subshell + Phase 1 regex per Bash call. Is +5ms acceptable for the ~50ms baseline? Yes (negligible).
2. **False positives** — `git clean -fdX` is destructive but doesn't trigger our verbs. Add `git clean -[fxXd]+` patterns? Punt to Phase 5.
3. **Bypass via `bash -c`** — `bash -c "rm -rf $HOME"` would also be caught by Phase 1 string match. Phase 2 also resolves.
4. **Interaction with `[[feedback_no_host_test_nodes]]`** — test red line bans agent nodes on the host. RFC-023 is independent — it protects whatever host the agent runs on, including hosted prod nodes.

## Implementation order

| Phase | Owner | ETA | Gate |
|---|---|---|---|
| 1 (string pattern) | SDK马 | ~2h | 通信龙 review |
| 2 (resolved target) | SDK马 | ~4h | 通信龙 review + soak |
| 3 (opt-in allow-list) | SDK马 | ~2h | After Phase 2 |
| 4 (telemetry) | SDK马 + 通信牛 | ~3h (server side) | After Phase 1 |

## Refs

- `docs/troubleshooting/rm-rf-incident-2026-06-16.md` (incident retro)
- `tests/lib/safe-rm.sh` (sibling helper for test scripts, commit `826c8a7`)
- `tests/scripts/lint-no-bare-rm-rf.sh` (sibling CI guard)
- `[[feedback_no_host_test_nodes]]` (sibling red line)
- `[[feedback_default_flags]]` (the `--dangerously-skip-permissions` default that makes this acute)
