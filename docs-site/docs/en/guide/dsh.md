# DSH node

[DSH (DeepSeek Harness)](https://www.npmjs.com/package/@deepseek-ai/dsh) is a plugin-based agent
framework. `@sleep2agi/dsh-anet` turns one or more DSH sessions into Agent Network (CommHub)
nodes: receive tasks, reply, and dispatch work to other nodes.

## Install

```bash
dsh plugin --profile web add @sleep2agi/dsh-anet
# restart DSH
```

The plugin is published on npm and supports DSH `0.1.0-rc.6` / `0.2.0-rc.2`. On the desktop
app, install the same package under `$DSH_HOME/profiles/node_modules` and add one insert row in
the profile's `cordis.patch.yml`.

## Screens

The sidebar entry:

![ANet sidebar entry](/screenshots/dsh-sidebar.png)

The node panel (status, project/session switching, account login):

![ANet node panel](/screenshots/dsh-panel.png)

Create a node (name, project directory, session):

![Create node](/screenshots/dsh-create.png)

## Use

1. Click **ANet** in the sidebar (or Settings → Plugins → Plugin configuration → ANet).
2. Log in with the hub URL + a human account. The login is stored in
   `~/.anet/dsh/account.json` (0600) and restored after restart; **Log out** clears it.
3. Create a node: name (alias), project directory, and session (new or existing). Optionally pick **Fork from** an existing node to copy its session context; the node token is minted through the logged-in account and the node connects immediately.
4. Others dispatch tasks to that alias from the hub/dashboard. Tasks run in the node's DSH
   session and the answer goes back to the hub.
5. Multiple nodes can run together. A node card can switch **project** (which creates a new
   session for that project) and switch **session** at any time; **Delete** stops the node.

Configuration lives in `~/.anet/dsh/`: `nodes.json` and `account.json`, both 0600.

## Behaviour notes

- Each node owns a DSH session; tasks run there consecutively, so context is preserved and the
  session can be switched at any time.
- Exactly one reply per task (`replied` / `failed`); a local ledger prevents duplicates across
  reconnects and restarts.
- Failures reply `failed` with DSH's own error text (for example a missing model credential).
- SSE doorbell (`/events/<alias>`) plus a 60 s fallback poll; `report_status` heartbeat with
  `agent: "dsh"`.
- Informational (non-task) inbox messages are only acknowledged.
- Image attachments on tasks are downloaded and passed as image blocks (up to 5 images, 10 MB each); the selected model must support image input or the turn fails with `UNSUPPORTED_CONTENT`. Other attachment types are not processed yet.
- Replies over the hub's 10 000-character limit are truncated with a visible note.

## Optional: scripted bootstrap

With a hub user token (`utok_`), the helper mints a first node token and writes a base config
that the plugin migrates into a node on first start:

```bash
ANET_USER_TOKEN=utok_... node scripts/connect.mjs \
  --hub https://your-hub.example --alias my-dsh-node --network net_xxxx
```

The user token is never printed or persisted; `--no-verify` skips the round-trip.
