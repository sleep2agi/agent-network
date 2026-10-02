# agent-network 2.3.0-preview.124

anet-only release. agent-node stays at `2.5.0-preview.96`.

## Behaviour

- `anet node start` / `anet node restart` for a codex co-presence node on Linux/macOS no longer fails spuriously with "TUI second-client health failed: managed TUI tree has no attributable connection to the exact app-server" on a loaded machine. The TUI paints its banner tens of milliseconds before it opens its websocket; the old check probed once right after the paint. It now polls every ~250 ms until the TUI owns a connection to the exact app-server port, giving up only when the TUI exits or after 25 s (the same budget as the Windows path), and the failure message says which way it ended (#477 / #2258).
- Pairing pin `PAIRED_AGENT_NETWORK_VERSION` bumped to `2.3.0-preview.124`; `PAIRED_AGENT_NODE_VERSION` stays `2.5.0-preview.96`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.124 @sleep2agi/agent-node@2.5.0-preview.96
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.124 @sleep2agi/agent-node@2.5.0-preview.96
```

Upgrade both packages together.

## Evidence

#2258: unit tests for the poll (late connect found, early stop on TUI exit, full deadline, budget equals Windows, real-socket 400 ms late connect); watchdog suite step with a 2 s paint→connect gap passes; witnessed red with a single probe. `agent-network/src/opencode-agent-node-pair.test.ts` checks the pins against both package versions.

## promote 时的 must_contain

`"version": "2.3.0-preview.124"`
