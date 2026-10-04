# agent-node 2.5.0-preview.103

Since `.102` (release merge `b9dbd483`, #2355), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 127cc992 | #2356 | #540: opencode provider errors fail the task; readable Zen free-tier rejection |

## Behaviour

- **opencode co-presence: a provider error now fails the task** (#540 / #2356). An assistant message that carries `info.error` (an upstream provider failure) throws `OpenCodeProviderError` with the upstream name and text, so the task is marked `failed` instead of being replied to with `[opencode: assistant returned no reply]`.
  - An empty *successful* turn still replies with that marker.
- The OpenCode Zen free-tier rejection ("free tier can only be used from within OpenCode") maps to a readable explanation on both the co-presence lane and the headless ACP lane, with the upstream text kept.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.103
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.136 @sleep2agi/agent-node@2.5.0-preview.103
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.136 ↔ agent-node@2.5.0-preview.103`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.103` first, then agent-network `.136`, both from the same merge commit.

## Evidence

- #2356: `src/runtime/opencode-provider-error.test.ts` (real captured shape) and the co-presence `runtime.test.ts` (fake serve returning `info.error`, the free-tier text and an empty successful turn). Witnessed red with the `openCodeTurnError` call stubbed out (1 pass, 2 fail).
- Docker e2e (real anet CLI, throwaway Hub, `opencode-ai@1.18.1`, `opencode/nemotron-3-ultra-free`, default safe preset): this build `status=failed` with the readable Zen message; `.102`-era agent-node `status=replied` with `[opencode: assistant returned no reply]` (witness).
- test725 2262 pass / 0 fail; test745 1698 pass / 0 fail; test228, test230, test1225 pass.

## promote 时的 must_contain

`"version": "2.5.0-preview.103"`
