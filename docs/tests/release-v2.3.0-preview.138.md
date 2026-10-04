# agent-network 2.3.0-preview.138

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.138`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.105` (see [`release-v2.5.0-preview.105.md`](./release-v2.5.0-preview.105.md)), so codex co-presence and `opencode-cli` resolve agent-node `.105`, which fixes the `ANET_CODEX_STDIO_DIRECT=1` lane (sandbox/approval flags, thread resume, turn deadline and codex errors).

Since `.137` (release merge `b58e3c20`, #2370), `agent-network/` has no source changes besides this pairing bump.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.138 @sleep2agi/agent-node@2.5.0-preview.105
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.138 @sleep2agi/agent-node@2.5.0-preview.105
```

Upgrade both packages together (`agent-network@2.3.0-preview.138 ↔ agent-node@2.5.0-preview.105`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- Pairing test `src/opencode-agent-node-pair.test.ts`; version-claim / doc-pin gates.

## promote 时的 must_contain

`"version": "2.3.0-preview.138"`
