# agent-network 2.3.0-preview.128

Pairing release: the only `anet` change since `.127` is `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.98` (see `release-v2.5.0-preview.98.md`) and `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.128`.

The registry currently serves `2.3.0-preview.126` as `preview`; `2.3.0-preview.127` (#2312) was published by CI but is not yet visible. So relative to what users can install today, `.128` also carries `.127`:

- `anet node clone <source> <new-name>` (#509 / #2307), and `anet node create <new-name> --from <source>` now does the same (it used to ignore `--from`). The clone is registered as its own node (new `node_id` + token); token, sessions, logs, inbox, codex `auth.json` and secret env values are never copied. See `release-v2.3.0-preview.127.md`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.128 @sleep2agi/agent-node@2.5.0-preview.98
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.128 @sleep2agi/agent-node@2.5.0-preview.98
```

Upgrade both packages together: anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## promote 时的 must_contain

`"version": "2.3.0-preview.128"`
