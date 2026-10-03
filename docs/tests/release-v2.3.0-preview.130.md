# agent-network 2.3.0-preview.130

anet-only release. `PAIRED_AGENT_NODE_VERSION` stays `2.5.0-preview.98`; only `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.130`.

The registry currently serves `2.3.0-preview.128` as `preview`; `2.3.0-preview.129` was published but is not yet visible on the registry. This release therefore carries everything from `.129` as well.

Changes since `.129`:

- **One codex login per node** (#514 / #2326). A ChatGPT codex login is single-use on refresh, so two nodes sharing one `auth.json` knock each other out (`token_revoked` / "signed in to another account"). New sharing is now refused (exit `1`) on the three paths that copy a login into a node: co-presence `anet node start` staging the host `~/.codex/auth.json`, `anet node codex fork`, and `anet node codex account install`. The message names the other node(s) and how to log this one in (`CODEX_HOME=<node codex-home> codex login --device-auth`). `--allow-shared-codex-login` overrides (unsafe); `anet node codex fork --no-codex-login` forks without a login. Logins are compared by fingerprint only — no token is read from another node or printed. `anet doctor` lists groups of nodes sharing one login. `anet node clone` never copied a login (regression test added).
- **Claude Code nodes can reply and close in one call** (#519 / #2330, RFC-030). The claude-code channel exposes `commhub_send_peer_reply`: it wakes the agent that sent a task and closes that task. It uses the Hub's atomic `send_peer_reply` when available, otherwise falls back to `send_task` (wake) → terminal reply (close). A failed wake leaves the task open; a failed close after the wake returns the exact `commhub_reply` call to finish. Tasks from a person / the Dashboard get a reply only. The channel instructions now point agent senders to this tool. Takes effect when a claude-code node restarts and regenerates `.anet/node-server.js`.

Changes carried from `.129` (not yet visible on the registry):

- **`anet logout` revokes the login on the Hub** (#513 / #2317); `anet init` / `anet login --hub` to a different Hub revokes the old session there and never sends the old token to the new Hub.
- **Codex co-presence nodes use the model from their own config** (#512 / #2320): `--model` > node `config.json` `model` > default, for app-server, `thread/resume` and TUI; start prints the model and its source.
- **Consistent exit codes** (#515 / #2321): `0` success, `1` failure, `2` usage error; `anet hub stop` works without `lsof` and only signals a verified `commhub-server`.

## ⚠️ Behaviour change

- **Shared codex logins (#2326).** Creating, forking or installing a codex login that another node on this machine already uses is now **refused** (exit `1`). Nodes that **already** share a login are not refused — they start with a warning; give each its own login when convenient. See [codex co-presence → 一个登录只给一个节点](../../docs-site/docs/guide/codex-copresence.md#one-login-per-node) / [One login per node](../../docs-site/docs/en/guide/codex-copresence.md#one-login-per-node).
- **From `.129`:** exit codes are now non-zero after errors (#2321) — scripts that relied on `0` will see `1` or `2`; co-presence nodes switch to their configured model on next restart (#2320). See the [`.129` notes](./release-v2.3.0-preview.129.md).

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.130 @sleep2agi/agent-node@2.5.0-preview.98
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.130 @sleep2agi/agent-node@2.5.0-preview.98
```

Upgrade both packages together: anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`. Claude Code nodes pick up `commhub_send_peer_reply` on their next restart.

## promote 时的 must_contain

`"version": "2.3.0-preview.130"`
