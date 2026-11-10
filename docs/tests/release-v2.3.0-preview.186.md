# agent-network 2.3.0-preview.186

Since `.184`, `agent-network/` has no behaviour change. This release only moves the **paired** agent-node version:

| Commit | PR | What |
|---|---|---|
| 82985d7f | #2838 | `ANET-COMMHUB.md` occupied message (agent-node side) |

## Behaviour

- CLI behaviour is identical to `2.3.0-preview.184`, which already contains the OpenCode V2 co-presence start orchestration (bridge tmux → wait for the attach script → TUI tmux, exact `=alias` attach, shared-server validation).
- The only difference is `PAIRED_AGENT_NODE_VERSION` moving to `2.5.0-preview.150`.
- Ship it together with `agent-node@2.5.0-preview.150`; a mismatched pair is refused for codex co-presence and `opencode-cli`.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.186
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.186 @sleep2agi/agent-node@2.5.0-preview.150
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.186 ↔ agent-node@2.5.0-preview.150`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
