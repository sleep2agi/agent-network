# agent-network 2.3.0-preview.122

Since `.121`, `agent-network/` has no source change other than the pairing pins.

## Behaviour

- Pairing pins bumped to `agent-node 2.5.0-preview.95` / `agent-network 2.3.0-preview.122`, so anet accepts agent-node `.95` (App Server watchdog, #461 / #2243) as its exact pair for codex co-presence and `opencode-cli`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.122 @sleep2agi/agent-node@2.5.0-preview.95
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.122 @sleep2agi/agent-node@2.5.0-preview.95
```

Upgrade both packages together.

## Evidence

Pin-only bump; `agent-network/src/opencode-agent-node-pair.test.ts` checks the pins against both package versions.

## promote 时的 must_contain

`"version": "2.3.0-preview.122"`
