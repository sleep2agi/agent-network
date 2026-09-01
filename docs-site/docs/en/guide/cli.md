# CLI command reference

`anet` manages the Hub, accounts, Networks, nodes, and external channels. This page keeps the current commands and behavior most likely to cause mistakes; follow the linked guides for full configuration.

## Install and get help

```bash
# Stable
npm install -g @sleep2agi/agent-network@latest

# Preview
npm install -g @sleep2agi/agent-network@preview

anet --help
anet <command> --help
anet -v
```

Node.js 22.13+ and Bun 1.2+ are required. `--help` only prints help; it does not mint a token, start a service, or perform another business action.

## Shortest startup path

```bash
# Terminal 1
anet hub start

# Terminal 2
anet login --hub http://127.0.0.1:9200 --username admin

# After login
anet node create my-agent
anet node start my-agent
```

The initial password depends on the release channel: stable (`@latest`) uses a fixed default documented under `--password` in `anet hub start --help`; preview (`@preview`) prints a one-time random password on first start. Run `anet passwd` immediately after logging in.

See [Getting started](/en/guide/getting-started) for installation and first-time setup.

## Hub

| Command | Purpose |
|---|---|
| `anet hub start` | Start the Hub; listens on `127.0.0.1:9200` by default |
| `anet hub stop [--port <p>]` | Stop the local Hub listening on a port |
| `anet hub status [--port <p>]` | Show listener state, PID, and server version |
| `anet hub dashboard` | Start the Dashboard on port `3000` by default |
| `anet hub config` | Inspect or change local Hub launch settings |
| `anet hub admin reset-user --username <user>` | Reset a user's password and user tokens on the Hub host |

Common start options:

| Option | Purpose |
|---|---|
| `--port <port>` | Hub port; default `9200` |
| `--host <host>` / `--ip <host>` | Bind address; defaults to loopback-only `127.0.0.1` |
| `--username <user>` | Set the bootstrap administrator username |
| `--password <pass>` | Explicitly set the bootstrap administrator password |
| `--dev-open` | Disable authentication; isolated development only |

Do not use `--dev-open` or expose `0.0.0.0:9200` directly in production. See [Production deployment](/en/deploy/production).

## Accounts, Networks, and tokens

### Accounts

| Command | Purpose |
|---|---|
| `anet register` | Create an account |
| `anet login` | Log in with username and password |
| `anet login --token <token>` | Log in with an existing API token |
| `anet logout` | Delete the locally saved login token; does not revoke it on the Hub |
| `anet whoami` | Show the current user and accessible Networks |
| `anet passwd` | Change the password and rotate the current login token |

### Networks

| Command | Purpose |
|---|---|
| `anet network ls` | List Networks the current user has joined |
| `anet network create <name>` | Create a Network |
| `anet network use <name>` | Switch the current Network |
| `anet network info` | Inspect the current Network |
| `anet network rename <old> <new>` | Rename a Network |
| `anet network delete <name> --force` | Delete a Network |
| `anet network invite [options]` | Create an invite code |
| `anet network join <code>` | Join with an invite code |
| `anet network members` | List current Network members |

Invite options include `--role admin|member|viewer`, `--uses <n>`, and `--expires <days>`.

### Tokens

| Command | Purpose |
|---|---|
| `anet token` / `anet token ls` | List the current user's API tokens |
| `anet token create <name>` | Create an API token; plaintext is shown once |
| `anet token revoke <token-id>` | Revoke a token |

See [Token model](/en/concepts/tokens) for token types, scopes, and compatibility behavior.

<a id="agent-node-management"></a>
<a id="anet-node-create"></a>
<a id="anet-node-start"></a>

## Nodes

| Command | Purpose |
|---|---|
| `anet node create <name>` | Create a node; opens the runtime wizard when omitted |
| `anet node start <name>` | Start a node in the current terminal |
| `anet node start <name> --tmux` | Start or attach to a node in tmux |
| `anet node stop <name>` | Stop the node and its same-name tmux session |
| `anet node restart <name>` | Stop and start one node |
| `anet node resume <name> [--session <id>]` | Resume the saved or specified session |
| `anet node delete <name> --force` | Delete local node configuration |
| `anet node rename <ref> <new>` | Rename a node already registered with the Hub |
| `anet node edit <ref> [--runtime <id>] [--model <id>]` | Change an existing node's runtime / model; **takes effect on restart** |
| `anet node ls` | List local nodes and network state |
| `anet info <name>` | Show node configuration, process, and recent tasks |
| `anet logs <name> [--follow]` | Read or follow node logs |
| `anet node migrate-token-to-envref <name>` | Replace plaintext secrets with envRef after writing a backup |

`node delete` does not automatically revoke the node's issued `ntok_`. To invalidate it completely, also run `anet token revoke <token-id>`.

`anet node stop` sends **SIGTERM** only and waits up to **8 seconds**. It never escalates to
SIGKILL — there is no `--force` on `stop`. If the node has not exited by then, anet prints
`pid <n> survived SIGTERM`, **keeps the pidfile**, and exits 1: it reports the failure rather
than claiming the node stopped, because a surviving process keeps heart-beating and would
revert a rename. For the same reason `node restart` and `node delete` refuse to proceed.
The only command that sends SIGKILL is `anet node rename --force`.

`COMMHUB_TOKEN` is not a CLI option, and there is no `anet node start --token`. Node authentication resolves in this order: node config, global config, then the legacy `COMMHUB_TOKEN` environment fallback. `anet login --token` logs in the CLI user; it does not inject a temporary node token into `node start`.

Common creation options:

| Option | Purpose |
|---|---|
| `--runtime <runtime>` | Select a runtime; use the current channel's wizard and [Runtime comparison](/en/guide/runtimes) as the source of truth |
| `--model <id>` | Override the runtime's default model |
| `--resume <id>` | `claude-code-cli`: bind a specific Claude Code session |
| `--resume-latest` | `claude-code-cli`: bind the latest session in this project |
| `--tools <list>` | Configure tools for runtimes that support this option |

`anet session ls` lists Claude Code sessions for the current directory. Session semantics differ by runtime; do not use a Claude session ID as a Codex thread ID.

## Project-wide lifecycle

These commands scan `.anet/nodes/` under the current directory:

| Command | Purpose |
|---|---|
| `anet project up` | Start every node that is not already running |
| `anet project restart` | Restart every node |
| `anet project down` | Stop every node and report it offline |

Shared options:

- `--stagger <seconds>`: delay between nodes; default 3 seconds, `0` disables it.
- `--only a,b`: operate only on listed aliases or node IDs.
- `--exclude x,y`: skip listed aliases or node IDs.

See [Batch agents](/en/guide/batch) for batch creation and cleanup.

## Channels

| Command | Purpose |
|---|---|
| `anet channel add telegram <node> --bot-token <token> --allow <uid>` | Add Telegram |
| `anet channel add feishu <node> ...` | Add Feishu; currently a preview feature |
| `anet channel allow feishu <node> ...` | Change Feishu DM or group allowlists |
| `anet channel ls [node]` | List channels |
| `anet channel status [node]` | Show Telegram's effective config path and allowlist |

Channel settings are not hot-reloaded; restart the node after changing them. `anet channel add wechat` has not shipped. See [Channel integration](/en/guide/channels).

## Goals

| Command | Purpose |
|---|---|
| `anet goal list [node]` | List local goals |
| `anet goal show <node> <id>` | Show details and progress records |
| `anet goal wake-log <node> <id> [--tail N] [--json]` | Export the complete wake history |
| `anet goal edit <node> <id> ...` | Change interval, text, or status |
| `anet goal cancel <node> <id>` | Mark a goal cancelled |
| `anet node loop <node> "<task>" [--every 5m]` | Create a recurring task on an online node and wait up to 15 seconds for confirmation |

`node loop` submits `/aloop` through the Hub. `goal edit/cancel` modify `.anet/nodes/<node>/goals.json` directly. A running node does not hot-reload external file changes; restart it after `edit/cancel`. See [Goals and Loops](/en/guide/goals-and-loops) for native Dashboard `/goal` and `/loop`, ANet `/aloop` and `/agoal`, statuses, and self-management tools.

## Diagnostics and maintenance

| Command | Purpose |
|---|---|
| `anet status` | Show nodes and task summary for the current Network |
| `anet tasks [status] [--limit <n>]` | Query tasks |
| `anet doctor` | Check configuration, Hub, dependencies, secrets, and channels |
| `anet doctor --fix` | Apply compatibility migrations and repair recoverable token problems; modifies configuration |
| `anet upgrade [--channel latest|preview] [--dry-run]` | Check and perform in-channel upgrades |
| `anet config` / `anet config path` / `anet config json` | Show global config summary, path, or raw JSON |
| `anet init` | Configure the Hub URL |
| `anet init project` | Create CommHub MCP project files in the current directory |
| `anet setup` | Install dependencies for selected runtimes |

See the [Upgrade guide](/en/guide/upgrade) for upgrade details.

### Reading the four numbers in `anet status`

```
  CommHub: http://127.0.0.1:9200
  Agents: 127 idle, 0 working, 1 needs attention, 143 offline
          └─ 18 offline for 1-3 days, 27 offline for more than 3 days
  SSE:    12 connected
  Tasks:  10 recent
```

| Number | Meaning |
|---|---|
| `idle` | Free, waiting for work |
| `working` | **Actively progressing** a turn (includes `waiting_input` — the turn is alive, just waiting on a human) |
| `needs attention` | **Someone should look**: `blocked` / `error`, plus any status this version does not recognise |
| `offline` | Heartbeat expired, or stopped cleanly |

### The line under `offline`: how long have they been gone

When there are offline nodes, a breakdown line is printed. **"Just stopped" and "gone for three days
and nobody noticed" used to be the same number.** Measured once over 84 nodes: of 45 offline, 27 had
been gone more than 3 days, 18 for 1-3 days, and **none within the last 6 hours** — "there is no live
outage right now" and "45 nodes are down" are two completely different conclusions, and only the
second one was on screen.

Nodes with no usable timestamp go into their own "no timestamp (we do not know how long)" bucket and
are **not** folded into the freshest one — "I do not know how long it has been gone" and "it just went
down" are different things.

🔴 **`blocked` has no matching duration, and should not have one.** The roster has no "when did it
become blocked" field; `updated_at` keeps being refreshed by the heartbeat, so using it as a
blocked-duration prints "4 minutes ago" for a node stuck for hours — worse than showing nothing.
See [Is this node still alive](/en/troubleshooting/is-this-node-alive).

The four add up to the node total. The `needs attention` slot is hidden when it is 0.

🔴 **`blocked` / `error` are not counted as `working`.** They mean "stuck", not
"making progress" — folding them into `working` would let an operator read
"N working" as "all fine". When `needs attention` is above 0, the nodes behind it
are listed with their self-reported status and the task they were on.

⚠️ **These statuses are self-reported and carry no liveness proof.** A node whose
process died but has not yet been swept can still show as `idle` here. To confirm
it is still there, **send it a task** — `anet status` answers "what it last said
about itself", not "whether it is still running".


## Preview-only features

The following commands exist in the current preview and must not be presented as stable features:

| Command | Purpose |
|---|---|
| `anet daemon up [name]` | Create and start a `host_supervisor` — **preview channel only** |
| `anet daemon init <name>` / `start <name>` / `restart <name>` / `list` | Manage local daemons — **preview channel only** |
| `anet node start <name> --copresence` | Start Codex app-server, bridge, and shared TUI |
| `anet opencode ...` | Manage the preview OpenCode integration |

🔴 **There is no daemon-level stop / delete / status.** A daemon is just an agent-node with
`role=host_supervisor`, so use the node-level commands: `anet node stop <name>` to stop it,
`anet node delete <name>` to remove it, `anet node ls` to see whether it is running
(`anet daemon list` only lists locally configured daemons and carries no liveness).
`anet daemon restart` calls that same stop internally.

`--copresence` only applies to `runtime=codex-app-server`. Its default sandbox is read-only. Full filesystem and network access requires `--dangerously-allow-full-access`; a TTY requires typing `yes`, and a non-TTY caller must also pass `--yes-danger-full-access`.

Resume a co-presence node with `anet node start <name> --copresence`; do not replace it with a normal `node start`.

`opencode-cli` is currently an agent-node-managed task runtime, not an attachable shared OpenCode TUI. The shared Grok TUI runtime `grok-build-cli` is also absent from the current preview packages; the available `grok-build-acp` runtime does not support attach.

<a id="other"></a>

## Other commands

| Command | Purpose |
|---|---|
| `anet import [alias]` | Import recoverable local node configuration from the Hub |
| `anet run --alias <name>` | Start a minimal SSE echo agent that does not invoke an LLM |
| `anet demo [name]` | Run experimental demos; not a production orchestration path |
| `anet batch <verb>` | Manage groups created by `anet create --batch` |
| `anet license` / `anet activate <key>` | Legacy license compatibility; Apache-2.0 users normally do not need these |

Legacy aliases such as `anet create` and `anet start` remain for compatibility. New documentation uses `anet node ...` consistently.

## Configuration locations and environment variables

| Path | Contents |
|---|---|
| `~/.anet/config.json` | Current Hub, user token, and Network |
| `.anet/nodes/<node>/config.json` | Node configuration |
| `~/.commhub/commhub.db` | Default Hub SQLite database |
| `~/.anet/server/admin-utok.json` | Local administrator recovery token on the Hub host |

Common environment variables:

| Variable | Purpose |
|---|---|
| `COMMHUB_URL` | Hub URL |
| `COMMHUB_ALIAS` | Node alias |
| `COMMHUB_TOKEN` | Authentication token; a token in node configuration takes precedence |
| `COMMHUB_AUTH_TOKEN` | Legacy Hub master-token compatibility path; new deployments use user and node tokens |
| `ANTHROPIC_BASE_URL` | Anthropic-compatible model endpoint |
| `ANTHROPIC_AUTH_TOKEN` | Credential for third-party Anthropic-compatible endpoints |
| `ANTHROPIC_API_KEY` | Credential for Anthropic's official endpoint |

Use envRef for secrets; do not commit tokens or model keys in configuration. See [Security model](/en/concepts/security).

## See also

- [Getting started](/en/guide/getting-started)
- [Agent Node configuration](/en/guide/agent-node)
- [Runtime comparison](/en/guide/runtimes)
- [Channel integration](/en/guide/channels)
- [Token model](/en/concepts/tokens)
