# @sleep2agi/agent-network 2.3.0-preview.43 — release notes

This preview adds native Windows support for the interactive Codex co-presence
workflow. `codex-cli` remains a non-default picker choice and starts the Codex
TUI alongside Agent Network. Restarting the node resumes its existing Codex
thread instead of creating a replacement node or conversation.

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.43
anet node create
```

Choose `codex-cli — Codex 共存 TUI` in the interactive runtime picker, then use
`anet node start <name>`. Windows uses its native console/ConPTY path and does
not require tmux; Linux and macOS retain the tmux path.

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.43
anet node stop <name>
anet node start <name>
```

The restart reuses the node's stored `codexThreadId`. Existing `atok_` tokens
remain supported.

## Verification

- Native Windows ConPTY E2E: interactive create and `codex-cli` selection,
  start/TUI/stop, then restart/TUI/stop; exactly one `thread/start` and one
  `thread/resume`, both TUI launches on the same thread.
- Linux Docker E2E: one-command interactive picker and co-presence flow passed.
- Legacy `atok_` authentication, unit, security, docs, and complete repository
  QA gates passed before merge.
