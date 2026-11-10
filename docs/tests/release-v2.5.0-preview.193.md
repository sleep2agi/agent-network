# agent-node 2.5.0-preview.193

Since `.192`: OpenCode V2 nodes report `model_effective` even when the current model has no thinking-level variants.

## Why

`config_snapshot.model_effective` was only filled from the variant readback, which exists only when the catalog says the selected model supports variants. On a model without variants (2026-11-09: 通信客户端欧, `openai/gpt-6.1-terra`) the node never reported its session model, so the app could not confirm a successful hot model switch and showed it as failed.

## What changed

```text
agent-node/src/opencode-model-effective.ts (new, pure)
  · variant readback present ⇒ model_effective + modelVariant (unchanged)
  · otherwise, live V2 session with a known session model ⇒ model_effective only;
    modelVariant stays absent (unknown), never guessed
agent-node/src/cli.ts
  · config_snapshot uses that helper for OpenCode V2
```

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.193
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.193 @sleep2agi/agent-network@2.3.0-preview.225
anet node stop <alias> && anet node start <alias>
```
