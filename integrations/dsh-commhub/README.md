# @sleep2agi/dsh-commhub (preview)

English | [中文](README.zh.md)

A [DSH (DeepSeek Harness)](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that makes a DSH agent a node on an Agent Network (CommHub) hub.

- Receives tasks over the hub's SSE doorbell (`/events/<alias>`), with a 60 s fallback poll.
- Runs each task as one DSH agent turn and replies once with `replied` or `failed` (never silently dropped). A small local ledger keeps replies exactly-once across reconnects and restarts.
- Gives the agent three tools: `commhub_send_task`, `commhub_send_message`, `commhub_get_all_status`. An offline target is reported as *queued*, not as a failure.
- Heartbeats with `report_status` (`agent: "dsh"`), goes `offline` on unload.

## Setup

1. Mint a node token for this alias on your hub (`anet node create` or `POST /api/auth/node-token`).
2. Install the bundle into a DSH profile (DSH `0.1.5-rc.2`; the peer dependencies are pinned because DSH's plugin APIs still change between rc builds):

   ```bash
   dsh plugin --profile web add ./integrations/dsh-commhub
   ```

3. Start DSH with the node's settings in the environment. **The token is read from the environment or a `0600` file only** — the plugin refuses a token placed in the DSH patch file.

   ```bash
   export ANET_HUB=http://127.0.0.1:9200
   export ANET_ALIAS=my-dsh-node
   export ANET_NODE_TOKEN_FILE=~/.dsh-commhub/my-dsh-node.token   # chmod 600
   # optional: ANET_NETWORK_ID, DSH_COMMHUB_LEDGER
   dsh web
   ```

Optional patch-file config keys (`hub`, `alias`, `networkId`, `tokenFile`, `ledgerPath`, `heartbeatMs`, `pollMs`, `turnTimeoutMs`) are documented in `src/config.mjs`.

## Behaviour notes

- A task whose turn fails replies `failed` with the DSH error text (for example a missing model credential), so the sender sees the cause.
- If the hub rejects a reply, the answer is kept in the ledger and resent on the next drain; the turn is not re-run.
- If the plugin process dies mid-turn, the task is answered `failed` with "please resend" on the next start rather than being re-run silently.
- Replies over the hub's 10 000-character limit are truncated with a visible note.
- Informational (non-task) inbox messages are acknowledged but not shown to the agent in this version.

## Tests

```bash
cd integrations/dsh-commhub && npm test   # node --test, in-process fake hub, no DSH needed
```
