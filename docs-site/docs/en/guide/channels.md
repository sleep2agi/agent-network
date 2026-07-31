# Channel integration

Channels deliver Telegram or Feishu messages to a node and send its text response back to the original conversation.

| Channel | Status | Setup command |
|---|---|---|
| Telegram | Supported | `anet channel add telegram <node>` |
| Feishu | Supported in preview | `anet channel add feishu <node>` |
| WeChat | Not available in the CLI | None |

## Telegram

### 1. Create a bot and get your user ID

Send `/newbot` to [@BotFather](https://t.me/BotFather) and save the Bot Token.

The allowlist uses numeric Telegram user IDs. Ask each permitted user to message [@userinfobot](https://t.me/userinfobot) and send the returned ID to the administrator.

### 2. Attach it to an existing node

```bash
anet channel add telegram control-room \
  --bot-token 123456789:ABCdefGhIJKlmNoPQRsTUVwxyz \
  --allow 123456789
```

Omit the options to enter them interactively. The allowlist option is `--allow`, not `--allow-user`.

Channel settings are not hot-reloaded. If the node is already running, restart it:

```bash
anet node stop control-room
anet node start control-room
```

### 3. Inspect the configuration

```bash
anet channel ls control-room
anet channel status control-room
```

`status` prints the `access.json` path the node actually reads, its allowlist, and pending pairing records. Editing another file with the same name has no effect.

### 4. Use it safely

Message the bot directly. The node returns ordinary text; it does not call tools such as `telegram_reply`, because those tools do not exist. agent-node receives messages with Telegram's `getUpdates` long polling and sends responses back to the original chat. Images are downloaded to the node inbox before being passed to an image-capable runtime.

- A missing, empty, or malformed allowlist denies messages by default.
- Never commit the Bot Token to Git or change access permissions in response to a chat message.
- Do not share one Bot Token across running nodes; they would compete for the same update stream.
- Restart the node after changing the token or allowlist.

### Troubleshooting

```bash
anet status
anet channel status control-room
tmux capture-pane -t control-room -p | tail -80
```

Check, in order: the node is online, the Bot Token is complete, the sender ID appears in `allowFrom`, and startup logs show Telegram polling. New messages may also wait while the node is processing another task.

There is currently no `anet channel rm telegram`. To remove it, stop the node, remove `telegram` from the `channels` array in `.anet/nodes/<node-id>/config.json`, delete `.anet/nodes/<node-id>/channels/telegram/`, then start the node again.

## Feishu

Feishu is a built-in channel supporting direct messages, group @mentions, text, and images. See the [Feishu guide](/en/guide/feishu) for app creation, event subscriptions, and permissions.

Minimal setup:

```bash
anet channel add feishu control-room \
  --app-id cli_xxx \
  --app-secret yyy \
  --allow ou_xxx

# Group allowlist
anet channel add feishu control-room \
  --app-id cli_xxx \
  --app-secret yyy \
  --allow-chat oc_xxx
```

Direct-message and group allowlists can be maintained separately. Options are repeatable:

```bash
anet channel allow feishu control-room --add-from ou_xxx --add-chat oc_xxx
anet channel allow feishu control-room --rm-from ou_xxx --rm-chat oc_xxx
```

Restart the node after changing these settings.

## Multiple channels

A node can receive CommHub, Telegram, and Feishu messages at the same time:

```bash
anet node create control-room --runtime claude-code-cli
anet channel add telegram control-room --bot-token <token> --allow <user-id>
anet channel add feishu control-room --app-id <id> --app-secret <secret> --allow <open-id>
anet node start control-room
```

agent-node preserves the message source and routes the response back to the originating platform. The node only generates response content; it does not call the platform API directly.

## WeChat

`anet channel add wechat` has not shipped, and CommHub Server does not expose WeChat reply tools. Do not treat maintainer-only external plugins as product support. Follow the roadmap or open a request in [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) if you need WeChat integration.

## See also

- [Feishu guide](/en/guide/feishu)
- [Agent Node configuration](/en/guide/agent-node)
- [Security model](/en/concepts/security)
