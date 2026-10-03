# agent-network 2.3.0-preview.131

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.131`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.99` (see [`release-v2.5.0-preview.99.md`](./release-v2.5.0-preview.99.md)), so codex co-presence and `opencode-cli` resolve agent-node `.99`. No `anet` code changes since `.130`.

The registry currently serves `2.3.0-preview.129` (`preview` tag at `2.3.0-preview.128`); `2.3.0-preview.130` was published by CI but is not yet visible. Relative to what users can install today, `.131` therefore also carries everything in `.130`:

- **One codex login per node** (#514 / #2326): new sharing of a codex login across nodes is refused (exit `1`) on co-presence start, `anet node codex fork` and `anet node codex account install`; `--allow-shared-codex-login` overrides (unsafe). Existing shared nodes only get a warning. `anet doctor` lists shared groups.
- **Claude Code nodes can reply and close in one call** (#519 / #2330): the claude-code channel exposes `commhub_send_peer_reply` (wake the sender + close the original task). Takes effect on node restart.

See the [`.130` notes](./release-v2.3.0-preview.130.md) for details and its behaviour-change section.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.131 @sleep2agi/agent-node@2.5.0-preview.99
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.131 @sleep2agi/agent-node@2.5.0-preview.99
```

Upgrade both packages together: anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## promote 时的 must_contain

`"version": "2.3.0-preview.131"`
