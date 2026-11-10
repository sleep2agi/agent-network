# agent-network 2.3.0-preview.188

Since `.187`, the only behaviour change is in `anet daemon list`: the「创建能力」column
used to print `查不到 —— hub 返回 HTTP 400` on a perfectly healthy hub.

| Commit | PR | What |
|---|---|---|
| 480048b6 | #2846 | `daemon list` asks `/api/host-supervisors` **with** `network_id` |

## Behaviour

- **`anet daemon list`** asks for daemon capabilities with `?network_id=<登录态网络>`.
  Before, the request carried no query parameter, the hub answered
  `400 {"error":"missing_network_id"}`, and the CLI reported that as
  「hub 返回 HTTP 400 …… 看 hub 日志」— pointing the reader at the hub instead of at the
  missing parameter.
- When the login state has no `network_id`, the CLI reads `/api/networks` first and only
  uses the answer when the login belongs to exactly one network (no guessing).
- Everything else is identical to `2.3.0-preview.187`; `PAIRED_AGENT_NODE_VERSION` stays at
  `2.5.0-preview.150`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.188
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.188 @sleep2agi/agent-node@2.5.0-preview.150
```

Restart nodes and daemons on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.188 ↔ agent-node@2.5.0-preview.150`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
