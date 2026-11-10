# agent-node — say when a shared session is busy, v2.5.0-preview.151

One behaviour change: **a shared OpenCode session that is busy is no longer silent**.

The first time admission reads a non-idle session, the node reports its status as working and the text says the task has not been submitted yet, it is waiting for the TUI turn to finish. It reports that once. The wait budget is unchanged (default 30 minutes). The task is not failed early and is not queued.

Undefined session status is still treated as possibly idle. A missing status map does not raise this notice.

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.151
```

Use the same Hub and network token as the node you are replacing. Do not copy another node's `config.json`.

## Upgrade

```bash
anet upgrade
```

Or install the version above into this node's own prefix and restart that node when it is idle. A restart drops the in-flight turn on that node. This release does not restart anyone for you.

Nodes that stay on 2.5.0-preview.150 or older keep the old silent wait.
