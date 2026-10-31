# agent-network 2.3.0-preview.203

Since `.202`: pair constant only — this release exists so the CLI pins the new agent-node.

| Commit | PR | What |
|---|---|---|
| 339e6789 | — | agent-node `.169`: hot switch survives a transient disconnect; failure degrades to restart |

## Behaviour

- **No CLI surface change.** `anet` commands, flags and defaults are unchanged.
- **Paired runtime moves to `agent-node@2.5.0-preview.169`.** `anet` refuses any other agent-node
  version for codex co-presence and `opencode-cli`, so the two packages are upgraded together.
- The runtime change that rides along: a shared OpenCode v2 session's "alive" flag is now
  time-windowed (30 s) instead of sticky, and a failed hot model switch degrades to a restart
  rather than acking `rejected` with the model unchanged.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.203
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.203 @sleep2agi/agent-node@2.5.0-preview.169
```
