# Connectivity / Channels / MCP Troubleshooting

Use this page when the node appears to start, but messages or tools do not work:

- `anet doctor` reports hub, token, node config, MCP, or Telegram channel problems
- Telegram does not receive an agent reply, or allowlist / pairing state is unclear
- The agent cannot see CommHub MCP tools and cannot actively call `send_task`
- A codex-sdk node cannot actively collaborate with other nodes

## 1. Run the health check first

```bash
anet doctor
```

Focus on:

| Check | Meaning |
|---|---|
| Hub / health | Whether the CLI can reach CommHub Server |
| Token | Whether project and node tokens are missing, expired, or the wrong type |
| Node config | Whether `.anet/nodes/<node>/config.json` is readable and current enough |
| CommHub MCP | Whether the runtime can receive CommHub tools |
| Telegram channel | Whether bot token, allowlist, and pending pairing are configured |

For repairable local config problems, run:

```bash
anet doctor --fix
```

## 2. Inspect channel state

```bash
anet channel ls [node]
```

This shows the channel config the CLI actually reads. Check:

- the real `access.json` path
- numeric user ids in the allowlist
- pending pairing state
- whether a bot token is present

If you just changed `access.json`, bot token, or allowlist, restart the node:

```bash
anet node stop <node>
anet node start <node>
```

Recent `anet node start` / `anet node resume` prints an explicit warning when channel initialization fails. If Telegram replies are missing, check startup logs and `anet channel ls` before digging into task logs.

## 3. Agent does not have `send_task`

Each runtime receives CommHub tools through a different path:

| Runtime | Current behavior |
|---|---|
| `claude-agent-sdk` | SDK MCP injects CommHub tools |
| `claude-code-cli` | Project `.mcp.json` / `.anet/node-server.js` injects CommHub tools |
| `codex-sdk` | agent-node injects per-node CommHub tools; codex nodes can actively call `get_all_status` / `send_task` / `get_task` |
| `grok-build-acp` | ACP runtime injects the CommHub MCP server |

If the agent says it has no `send_task` or `get_all_status`:

1. Confirm the node runtime.
2. Run `anet doctor`.
3. For Telegram / channel issues, run `anet channel ls [node]`.
4. Restart the node so the runtime reloads MCP / channel config.

## 4. Sent, but the receiver did not see it

From the user's perspective, check in this order:

1. `anet status` to see whether the target node is online.
2. `anet doctor` for token / MCP / hub health.
3. If the target is a Telegram channel, run `anet channel ls [node]`.
4. For agent-to-agent tasks, inspect the sender log for the `send_task` result.

Offline nodes may still receive inbox messages, but real-time replies depend on the node coming back online and reconnecting SSE.
