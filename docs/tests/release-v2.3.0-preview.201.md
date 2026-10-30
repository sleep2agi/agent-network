# agent-network 2.3.0-preview.201

Since `.200`, `agent-network/` follows the agent-node `.166` pair. The CLI itself has no
behavioural change; the version exists so the published pair stays whole.

| Commit | PR | What |
|---|---|---|
| 07452a4a | #3262 | pins agent-node `.166` (queueing cap, late-reply channel, Windows-safe persistence) |
| b42baf11 | — | paired release bump |

## Behaviour

- **No CLI surface change.** `anet` commands, flags and defaults are unchanged.
- **Paired runtime pin moves to `agent-node@2.5.0-preview.166`.** `anet` refuses any other
  agent-node version for codex co-presence and `opencode-cli`, which is why the two packages
  must be upgraded together.
- The agent-node changes that ride along: queueing (admission) gets its own cap so a busy shared
  session no longer starves the reply budget; the late-reply channel no longer accepts tasks that
  already ended `replied`; late-reply persistence uses `renameOverExistingSync` on Windows.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.201
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.201 @sleep2agi/agent-node@2.5.0-preview.166
```

- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.201 ↔ agent-node@2.5.0-preview.166`).
- Running nodes must be restarted on the new agent-node build for the fix to take effect.

## Evidence

- `agent-network` version-consistency + pair tests: 8 pass / 0 fail (package.json, package-lock and
  the two `PAIRED_*` constants all read `.201` / `.166`).
- `agent-node@2.5.0-preview.166` published to npm before this half (pair check flags a half pair).

## promote 时的 must_contain

`"version": "2.3.0-preview.201"`
