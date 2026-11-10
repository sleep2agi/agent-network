# agent-network 2.3.0-preview.185

Since `.184`, `agent-network/` has no behaviour change. This release exists only to keep the **paired** agent-node version in step:

| Commit | PR | What |
|---|---|---|
| 10f8695e | #2835 | #1650: codex failed-create reaping (agent-node side) |

## Behaviour

- CLI behaviour is identical to `2.3.0-preview.184`; the only difference is `PAIRED_AGENT_NODE_VERSION` moving to `2.5.0-preview.149`.
- Ship it together with `agent-node@2.5.0-preview.149`; a mismatched pair is refused for codex co-presence and `opencode-cli`.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.185
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.185 @sleep2agi/agent-node@2.5.0-preview.149
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.185 ↔ agent-node@2.5.0-preview.149`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
