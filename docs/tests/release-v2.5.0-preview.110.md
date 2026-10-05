# agent-node 2.5.0-preview.110

Pairing release only. Since `.109` (release merge `89e41713`, #2392), `agent-node/` has no source changes; this version exists so anet `2.3.0-preview.143` (see [`release-v2.3.0-preview.143.md`](./release-v2.3.0-preview.143.md)) and agent-node move together.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.110
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.143 @sleep2agi/agent-node@2.5.0-preview.110
```

- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.143 ↔ agent-node@2.5.0-preview.110`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.110` first, then agent-network `.143`, both from the same merge commit.

## promote 时的 must_contain

`"version": "2.5.0-preview.110"`
