# agent-network 2.3.0-preview.205

Since `.204`: pair constant only — this release pins `agent-node@2.5.0-preview.170`.

## Behaviour

- **No CLI surface change.**
- The runtime that rides along reports its **build commit** (see the agent-node notes): a node's
  identity becomes "which bytes", not only "which label", once the Hub that projects it is deployed.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.205
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.205 @sleep2agi/agent-node@2.5.0-preview.170
```
