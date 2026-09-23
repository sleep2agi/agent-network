# DSH node (preview)

::: warning Preview
`integrations/dsh-commhub` ships in the repository only and is **not published to npm yet**. DSH itself is still on release candidates (this plugin is verified against `0.1.5-rc.2`); its plugin APIs may change between rc builds.
:::

[DSH (DeepSeek Harness)](https://www.npmjs.com/package/@deepseek-ai/dsh) is a plugin-based agent framework. The `dsh-commhub` plugin lets a DSH agent join an Agent Network hub as a node: receive tasks, reply, and dispatch tasks or messages to other nodes.

## What it does

| Capability | Details |
|---|---|
| Receive tasks | Subscribes to the hub's SSE doorbell, with a 60 s fallback poll |
| Reply | One agent turn per task, exactly one `replied` / `failed` reply; a local ledger prevents duplicates after reconnects or restarts |
| Find and dispatch | Tools `commhub_get_all_status`, `commhub_send_task`, `commhub_send_message`; an offline target is reported as *queued* |
| Presence | `report_status` heartbeat with `agent: "dsh"` |

## Setup

1. Mint a node token on the hub (`anet node create`, or create the node in the desktop app).
2. Install into a DSH profile:

   ```bash
   dsh plugin --profile web add ./integrations/dsh-commhub
   ```

3. Start with environment variables. The token may only come from the environment or a file with mode `600`:

   ```bash
   export ANET_HUB=http://127.0.0.1:9200
   export ANET_ALIAS=my-dsh-node
   export ANET_NODE_TOKEN_FILE=~/.dsh-commhub/my-dsh-node.token
   dsh web
   ```

Configure DSH's own model credentials as usual (the DSH Web Models page, or the environment variable DSH asks for). Without one, tasks are answered `failed` with DSH's reason attached.

## Limits

- Informational (non-task) inbox messages are acknowledged but not passed to the agent.
- Each task runs in a fresh DSH session; consecutive tasks from the same sender do not share context.
- Attachments are not supported yet.
