# agent-node 2.5.0-preview.150

Since `.149`, `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 82985d7f | #2838 | say why `ANET-COMMHUB.md` is occupied instead of a bare `EEXIST` |

## Behaviour

- **Second OpenCode node in one directory now says what to do.** Starting a co-presence node whose working directory already holds another node's `ANET-COMMHUB.md` used to die with a bare `EEXIST` (admin had to hand-run tmux after hitting it). The error keeps the `EEXIST` code and now names the cause and the fix: one OpenCode node per working directory.
- Same-alias restart still overwrites its own file (the #1946 fix is unchanged).
- The V2 co-presence start orchestration itself (bridge tmux → wait for `opencode-attach.sh` → TUI tmux, exact `=alias` attach, shared-server validation) has been in the CLI since `2.3.0-preview.184`; nothing about it changed here.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.150
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.186 @sleep2agi/agent-node@2.5.0-preview.150
```

Nodes and daemons must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.186 ↔ agent-node@2.5.0-preview.150`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
