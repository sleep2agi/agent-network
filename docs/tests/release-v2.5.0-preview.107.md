# agent-node 2.5.0-preview.107

Since `.106` (release merge `c9d04c7e`, #2379), `agent-node/` has two changes:

| Commit | PR | What |
|---|---|---|
| 1b16225f | #2381 | #501: pin `@anthropic-ai/claude-agent-sdk` to exactly `0.3.289` (bundled Claude Code CLI 2.1.231 → 2.1.289); systemPrompt passed with `snapshot: false` |
| ecd33977 | #2380 | #543: OpenCode V2 (`@opencode/cli`) co-presence preview, gated behind `flags.opencodeUnsafeTools` |

## Behaviour

- **Claude SDK pinned, no caret.** A fresh install now gets the SDK we tested, not whatever is newest in the `^0.3.x` range. Everything agent-node calls (`query`, `createSdkMcpServer`, `tool`, every option we pass, every message field we read) is unchanged in 0.3.289.
- **systemPrompt applies after a restart again.** SDK 0.3.289 records a plain-string `systemPrompt` on a session's first request and replays it verbatim on `resume`, so an edited node `systemPrompt` was ignored after a restart (real-model canary: old prompt kept on 0.3.289, new prompt picked up on 0.3.231). agent-node now passes `{ type: "custom", prompt, snapshot: false }`; in the canary the already-stuck session switched to the new prompt. A source-shape test fails if this reverts to a bare string.
- **Effort default** is now chosen by the CLI (we don't set `effort`/`thinking`).
- **OpenCode V2 preview.** The opencode co-presence runtime can drive `@opencode/cli` 2.x; it is only selected when `flags.opencodeUnsafeTools=true` (V2 ignores `OPENCODE_PERMISSION`/`OPENCODE_PURE`, so the config `permission` block is what's honoured). V1 nodes are unaffected.
- Known, not regressions (tracked in #557): the startup banner's default model name, a false "返回空响应" after a turn that left a background task, and `$` in `[claude] success` now being a session total.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.107
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.140 @sleep2agi/agent-node@2.5.0-preview.107
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.140 ↔ agent-node@2.5.0-preview.107`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.107` first, then agent-network `.140`, both from the same merge commit.

## Evidence

- #2381: test725 (full agent-node unit, Docker, lockfile install) 2318/2319 (one codex `/proc` count flake under load, 19/19 ×3 alone, clean full rerun); test656 8/8 (real `query()` vs fake vendor); test657 5/5 (resolves SDK 0.3.289); test8-runtime 13/13; typecheck 81 = baseline. Real-model Docker canary (throwaway hub, access token only): pong / CommHub tool call / mid-turn abort then next task all PASS; systemPrompt-on-resume FAIL on the bare pin → fixed with `snapshot:false`, verified, guarded by a test witnessed red.
- #2380: new Docker suite `tests/test543-opencode-v2-copresence` (real `@opencode/cli` 2.0.22 binary + loopback stub model) RESULT PASS; 129/129 checks.

## promote 时的 must_contain

`"version": "2.5.0-preview.107"`
