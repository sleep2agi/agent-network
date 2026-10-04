# agent-network 2.3.0-preview.133

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.133`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.100` (see [`release-v2.5.0-preview.100.md`](./release-v2.5.0-preview.100.md)), so codex co-presence and `opencode-cli` resolve agent-node `.100`, which carries the opencode child-env `execve` fix (#517 / #2340). No `anet` code changes since `.132`.

At the time of writing the registry serves `2.3.0-preview.131` on the `preview` tag; `2.3.0-preview.132` is not yet visible. Relative to what users can install today, `.133` therefore also carries everything in `.132` (#516 parts 1 and 2: plain-language errors, masked secrets, `--help` on every command, `anet node delete` removes the Hub row). See the [`.132` notes](./release-v2.3.0-preview.132.md) for details and its behaviour-change section.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.133 @sleep2agi/agent-node@2.5.0-preview.100
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.133 @sleep2agi/agent-node@2.5.0-preview.100
```

Upgrade both packages together (`agent-network@2.3.0-preview.133 ↔ agent-node@2.5.0-preview.100`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## promote 时的 must_contain

`"version": "2.3.0-preview.133"`
