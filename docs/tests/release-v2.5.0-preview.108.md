# agent-node 2.5.0-preview.108

Since `.107` (release merge `1c404bf8`, #2383), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 6e0aa248 | #2386 | #557: claude runtime logs say what actually happened (banner model, false 「返回空响应」, per-turn cost) |

## Behaviour

- **Banner model.** With no model configured, the claude-agent-sdk banner now says `(account default)` instead of naming `claude-sonnet-4-6` (the CLI really uses the account default). The model named by the SDK `system/init` message is logged once per session: `[claude] model in use: X`. Runtimes that fell through to the old claude default name (e.g. opencode) also show `(account default)`; codex keeps `(default)`.
- **No false 「返回空响应」.** After a turn that left a background task running, SDK 0.3.289 yields an extra empty `result` before the real one. The empty verdict and the #383 thinking-only re-prompt now come from the LAST result of the query only. A genuinely empty turn is still reported and still rescued.
- **Cost line.** `total_cost_usd` is cumulative per session (also across resume); the log now prints `$<turn> (session $<total>)`. The last total is stored next to the session in `config.json` (`claudeSessionCost`, written by the same private atomic writer as the other config fields) so a restart + resume still logs a delta; `$?` when the delta can't be derived. Logging only.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.108
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.141 @sleep2agi/agent-node@2.5.0-preview.108
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.141 ↔ agent-node@2.5.0-preview.108`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.108` first, then agent-network `.141`, both from the same merge commit.

## Evidence

- #2386: test725 (full agent-node unit, Docker, lockfile install) 2335 pass / 0 fail; new banner cases (real CLI spawn) witnessed red against the pre-fix `cli.ts`; helper unit tests for model notice / result tracker / cost; test631 private-config gate RESULT PASS with the writer count 6 → 7 (mutation reds still red); 127/127 checks.
- Not covered end to end: the result-tracker and cost wiring inside `processWithClaude` (helpers are unit-tested).

## promote 时的 must_contain

`"version": "2.5.0-preview.108"`
