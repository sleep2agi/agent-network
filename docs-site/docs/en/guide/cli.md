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
anet <command> <subcommand> --help   # e.g. anet node delete --help
anet -v
```

Node.js 22.13+ and Bun 1.2+ are required. `--help` (or `-h`) only prints help; it does not mint a token, start a service, or perform another business action. Every command and subcommand has its own usage text and exits 0.

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
| `--version <v>` | `commhub-server` version to launch (an exact version, or `latest` / `preview`) |
| `--channel <c>` | `latest` or `preview`; overrides the channel picked from anet's own version |

**Which Hub version starts**: without `--version`, `anet hub start` first decides the channel by comparing the installed anet version with the `@sleep2agi/agent-network` dist-tags (equal to or behind `latest` means latest; a prerelease newer than `latest` means preview; the `-preview.N` suffix alone says nothing, since `latest` carries it too). It then takes that channel's `@sleep2agi/commhub-server` dist-tag and launches that exact version through `bunx`. If that tag is older than the minimum this anet supports, it uses the minimum instead. Start prints one line, `Hub version: @sleep2agi/commhub-server@<version>  [source: registry | cache | explicit | pinned minimum]`, naming the version and where it came from. When the npm registry can't be reached, it uses the newest version in the local bun cache that meets the minimum, with a warning. If the cache only has older versions, it does **not** start one silently: it prints a warning naming both versions and tells you to pass `--version <cached version>` if you want it anyway.

Do not use `--dev-open` or expose `0.0.0.0:9200` directly in production. See [Production deployment](/en/deploy/production).

<a id="anet-hub-stop"></a>
**Stopping the Hub (`anet hub stop`)**: it only stops a process that **listens on that port and whose command line reads as `commhub-server`**; it never matches processes by name. Finding the listener does not need `lsof`: on Linux it tries `/proc/net/tcp(6)` socket inodes against `/proc/<pid>/fd`, then `ss -ltnp`, `lsof`, `netstat`; on macOS `lsof`, then `netstat -anv`; on Windows `netstat -ano`. The first one that can run decides. When none can run, it uses `~/.anet/server/hub-<port>.pid.json`, written by `anet hub start` (ignored if that PID has exited or now belongs to another program). The output lists every probe's result, the PID and command line it found, and which PID it actually stopped. It sends SIGTERM, and after 3 seconds SIGKILL to a survivor whose command line still reads as `commhub-server`.

| Case | Action | Exit code |
|---|---|---|
| `commhub-server` found and stopped | stopped | 0 |
| nothing listening on the port and `/health` does not answer | nothing | 0 |
| the port belongs to another program, or its command line / owner cannot be read | **refused**; prints the PID and command line | 1 |
| `/health` answers but its PID cannot be found on this machine (no probe works and no pid file) | nothing; tells you to stop it from the process manager that started it (pm2, systemd, …) | 1 |
| still running after SIGKILL, or `/health` still answers | — | 1 |
| `--port` is not a valid port | — | 2 |

## Accounts, Networks, and tokens

### Accounts

| Command | Purpose |
|---|---|
| `anet register` | Create an account |
| `anet login` | Log in with username and password |
| `anet login --token <token>` | Log in with an existing API token |
| `anet logout` | Revoke this login session on the Hub, then delete the locally saved login token (see [Logging out](#anet-logout) below) |
| `anet whoami` | Show the current user and accessible Networks |
| `anet passwd` | Change the password and rotate the current login token |

<a id="anet-logout"></a>
**Logging out (`anet logout`)**: with the saved token, calls `GET /api/auth/sessions` to get `current_token_id`, then `DELETE /api/auth/sessions/<token_id>` to revoke that login session (the same pair of endpoints the app's Settings → Account → Signed-in devices → sign out uses; see [Signed-in devices API](/en/api/rest#sessions)), then removes `token` / `user` / `network_id` / `network_name` from `~/.anet/config.json` (`hub` is kept). Output shows only the token id, never the token.

| Case | Local | Server | Exit code |
|---|---|---|---|
| Revoked, or the token was already invalid on the Hub (401) | Removed | Invalid | 0 |
| Hub unreachable, or Hub older than v0.9.0-preview.70 (`/api/auth/sessions` 404) | Removed | **Still valid**; prints a ⚠ warning and how to revoke it | 0 |
| The saved token is an explicit API token (`anet login --token`) or a node token | Removed | **Not revoked** (it may be in use elsewhere); prints a ⚠ warning — revoke with `anet token revoke <token-id>` | 0 |
| The local config file cannot be written | Not removed | — | 1 |

If the token is still valid on the server: sign that device out in the app under Settings → Account → Signed-in devices, or `anet login` again and run `anet passwd` (changing the password signs out every other login session). The `COMMHUB_TOKEN` that `anet init project` writes into each project's `.anet/.env` is a copy of the same token and stops working once it is revoked.

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

See [Token model](/en/guide/account-system#tokens) for token types, scopes, and compatibility behavior.

<a id="agent-node-management"></a>
<a id="anet-node-create"></a>
<a id="anet-node-start"></a>

## Nodes

### Interactive menu: `anet node`

No commands to memorise: run `anet node` with no arguments in the node's directory. It lists every node in this directory — name, runtime (claude-agent-sdk / claude-code-cli / codex-* / grok-* / opencode-cli), state (running / stopped), model, plus a login column for codex nodes — then you pick a node and an action: start, stop, restart, attach (enter the TUI), show the recent log, change model, delete.

- Before anything runs it prints the **exact equivalent `anet …` command** and runs it only after `y`; delete asks you to type the node name. What runs is the printed command; the menu does no lifecycle work itself.
- A codex node goes to the codex actions (log in, continue, copy, …), the same as `anet node codex` — see the [Codex node cheat sheet](/en/guide/codex-cheatsheet).
- Not a terminal (piped, a script, an agent): it prints the node table, a short cheat sheet and the usual usage line, exit 0. No token appears in the output.
- `anet node --help` / `anet node help` print help exactly as before.

Codex nodes without memorising commands: run `anet node codex` in the node's directory, pick a node and an action; it prints the equivalent command and asks before running it. Cheat sheet: [Codex node cheat sheet](/en/guide/codex-cheatsheet).

| Command | Purpose |
|---|---|
| `anet node create <name>` | Create a node; opens the runtime wizard when omitted |
| `anet node start <name>` | Start a node in the current terminal |
| `anet node start <name> --tmux` | Start or attach to a node in tmux |
| `anet node stop <name>` | Stop the node and its same-name tmux session |
| `anet node restart <name>` | Stop and start one node |
| `anet node resume <name> [--session <id>]` | Resume the saved or specified session |
| `anet node delete <name> --force` | Delete the local node configuration and the node's row on the Hub |
| `anet node rename <ref> <new>` | Rename a node already registered with the Hub |
| `anet node clone <src> <new>` | Copy a node's settings into a node with a **new identity** (see "Clone a node" below) |
| `anet node edit <ref> [--runtime <id>] [--model <id>]` | Change an existing node's runtime / model; **takes effect on restart** |
| `anet node ls` | List local nodes and network state |
| `anet node ls --all [--network <id\|name>] [--json]` | List **every** node the Hub shows you in the current Network, grouped by machine (hostname); read-only, see below |
| `anet info <name>` | Show node configuration, process, and recent tasks |
| `anet logs <name> [--follow]` | Read or follow node logs |
| `anet node migrate-token-to-envref <name>` | Replace plaintext secrets with envRef after writing a backup |

`anet node ls --all` ignores the current directory. It reads the Hub as you (your `anet login`) via
`/api/status` + `/api/host-supervisors` and lists the nodes of the current Network (or the one named by
`--network <id|name>`, matched by id, name, or a unique id prefix) grouped by machine: alias, runtime,
status with last heartbeat, model, and whether that machine has a live daemon (`anet daemon`; only a
machine with an online daemon can be managed remotely later).

```text
Network: team (net_0123456) — 3 node(s) on 2 machine(s)

  host-alpha   daemon: alpha-daemon online — remote-manageable
    ALIAS     RUNTIME           STATUS   LAST SEEN  MODEL
    a-coder   claude-agent-sdk  idle     12s ago    claude-sonnet-4-5
    a-writer  codex-app-server  working  1m ago     gpt-5

  host-beta   daemon: none visible
    ALIAS     RUNTIME           STATUS   LAST SEEN  MODEL
    b-runner  grok-build-cli    offline  3d ago     -
```

- Permissions are exactly what the Hub returns: a member with restricted agent access sees only the
  nodes granted to them. The Hub returns no daemons to such members, so the line reads
  `daemon: none visible` ("not visible to you", not "there is none").
- Only your login token (`token` in `~/.anet/config.json`) is used, never `COMMHUB_TOKEN` or a node token.
- `--json` prints `{ network, daemons_readable, machines: [{ hostname, daemon, daemons, nodes }] }`.
- Without `--all`, `anet node ls` is unchanged.

`anet node delete <name> --force` first runs the same stop as `anet node stop` (co-presence tmux
sessions included: codex co-presence by marker + `CODEX_HOME`, others by exact session name, never a prefix), then deletes the local
files (`.anet/nodes/<id>/`), then the node's row on the Hub, so it does not keep showing as "offline"
in the app or dashboard. If the stop cannot be proven, it exits with an error and deletes nothing.

- When the node is not in the current directory (a clone / codex fork made with `--workdir`), anet finds
  it through the source directory's `.anet/child-workdirs.json` and the codex login index, **does not
  delete it for you**, and prints `cd <dir> && anet node delete <name>`, exit code `1`.
- When several nodes match the name, it refuses and lists a delete-by-`node_id` command for each.

- The Hub row is matched **only by the `node_id` in the local config**, never by name. A node on
  another machine that reuses the same name is not deleted; anet prints
  `Left untouched: … belong to other node_id(s)`.
- If the Hub is unreachable or refuses, the local files are still deleted, anet prints a warning with
  the **exact retry command**, and exits `1`:
  ```bash
  anet node delete <node_id> --hub-only            # remove only the Hub row
  anet node delete <node_id> --hub-only --hub <url> # when the node used a different Hub than your login
  ```
- With no Hub configured, only the local files are removed and the exit code is `0`. Very old node
  configs have no `node_id`; their Hub row cannot be matched safely, so anet leaves it and tells you to
  remove it in the app or dashboard.

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

### Clone a node

Full guide (clone vs fork, what is copied, the codex login, deleting the copy): [Copying a node (clone / fork) and cleaning up](/en/guide/copy-node).

To get "another node just like this one":

```bash
anet node clone <source> <new-name>
# same thing
anet node create <new-name> --from <source>
```

The new node is **registered with the Hub as its own node** (the same endpoint `anet node create` uses) and gets
its own `node_id` and `ntok_`. It is not started unless you pass `--start`. A table at the end lists every item as
**copied / regenerated / skipped**.

| Category | What |
|---|---|
| Copied | runtime, model, tools, permission flags, system prompt, non-secret env, the commhub channel; with `--workdir` also the rules file (`CLAUDE.md` / `AGENTS.md`), skills directories and `.mcp.json` (env / header values blanked); for codex nodes `codex-home/config.toml`, `AGENTS.md`, `skills/` |
| Regenerated | `node_id`, alias, `ntok_`, the claude-code-cli session id, grok co-presence sockets, `codexProjectDir` |
| Not copied | the token, every session / thread id, logs, pid / lock files, goals, inbox, channel bot credentials, codex `auth.json`, co-presence identity files, and the **values** of secret env entries (the key names are kept as an envRef pointing at the new node; fill them in before starting) |

| Option | Purpose |
|---|---|
| `--workdir <dir>` | Put the clone in another project directory (created if missing). **The path must be ASCII** (a node name may be Chinese, a directory may not). Without it the clone shares the source's project directory, rules file and skills |
| `--model <id>` | Use a different model |
| `--start` | Start right after cloning (skipped, with a hint, while secrets are still unset) |

Refused: an existing destination, a new name equal to the source's, a destination inside the source node's own
directory, a non-ASCII `--workdir`, opencode-cli nodes (their runtime binding and login live outside the node
config — create one with `anet node create --runtime opencode-cli`), and host daemons (`role=host_supervisor`).

A codex node's login is not copied. One login per node (refresh tokens are single-use; sharing knocks the others
out): log the new node in before starting it, `CODEX_HOME=<new-node-dir>/codex-home codex login --device-auth`.
Started without a login, anet stages this host's `~/.codex` login — but refuses (exit 1) if another node on this
host already uses it (`--allow-shared-codex-login` shares anyway, unsafely; see
[One login per node](/en/guide/codex-copresence#one-login-per-node)). For a registered account use
`anet node codex account install <new-name> --source codex-login:<profile-id>`. To carry the codex
conversation history too, use `anet node codex fork` (see [Codex co-presence](/en/guide/codex-copresence)).
A conversation you started with `codex` outside anet becomes a node with
`anet node codex adopt <new-name> --thread <id>` (see [Copying a node](/en/guide/copy-node)).

::: danger Never `cp -r` a node directory
`.anet/nodes/<name>/config.json` holds the node's `node_id` and `ntok_`. A verbatim copy is **the same Hub
identity** as the source: both processes subscribe to the same inbox, every task runs twice and is answered twice,
and the Dashboard cannot tell which one replied. Logs, sessions and the codex login are shared too. Always use
`anet node clone` to copy a node.
:::

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
| `anet config` / `anet config path` / `anet config json` | Show global config summary, path, or JSON (tokens masked) |
| `anet init` | Configure the Hub URL. When switching to a **different** Hub, the saved login session is first revoked on the old Hub (best effort — a failure only warns), then the old Hub's token and login info are removed from the config; the old token is never sent to the new Hub. Run `anet login` again afterwards. `anet login --hub <another hub>` does the same |
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
| `anet daemon up [name]` | Create and start a `host_supervisor` (version requirements: [which versions have `anet daemon`](/en/deploy/daemon#which-versions)) |
| `anet daemon init <name>` / `start <name>` / `restart <name>` / `list` | Manage local daemons (same version requirements; for `restart` see the [daemon page](/en/deploy/daemon)) |
| `anet node start <name> --copresence` | Start Codex app-server, bridge, and shared TUI |
| `anet opencode ...` | Manage the preview OpenCode integration |

🔴 **There is no daemon-level stop / delete / status.** A daemon is just an agent-node with
`role=host_supervisor`, so use the node-level commands: `anet node stop <name>` to stop it,
`anet node delete <name>` to remove it, `anet node ls` to see whether it is running
(`anet daemon list` only lists locally configured daemons and carries no liveness).
`anet daemon restart` calls that same stop internally.

::: warning Two counter-intuitive things about daemons
**1. On an existing daemon, `anet daemon init <name>` changes nothing.** It prints
`✓ "<name>" already a host_supervisor daemon` and returns — a green check mark with
not one byte written. Changing the config requires `--force` (keeps `node_id`, but
**re-mints the token**, and the daemon must be restarted for it to take effect).

**2. The runtime list in the config is a write-time snapshot; it does not self-heal.**
Runtimes added later are not back-filled into existing daemon configs, which shows up
as that machine offering fewer runtimes in the client's server picker. `anet daemon list`
now prints which ones are missing and the command to back-fill.
:::

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

<a id="exit-codes"></a>

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, or only help was printed (for example `anet node` or `anet network` with no subcommand, or any command / subcommand with `--help` or `-h`) |
| `1` | Failure: not initialized / not logged in / session expired, Hub unreachable or returned an error, object not found, local write failed, refused to act |
| `2` | Usage error: missing required argument, unknown subcommand, invalid value |

Scripts and CI can rely on `anet … || exit 1`. Before #515 the following printed an error but exited 0; they now exit non-zero:

| Command | Case | Before → now |
|---|---|---|
| `anet whoami` | not logged in / session expired / Hub unreachable | 0 → 1 |
| `anet network <ls\|use\|info\|create\|delete\|rename\|invite\|join\|members>` | not initialized / not logged in, Hub error, Network not found, unreachable | 0 → 1 |
| `anet network create\|use\|delete\|rename\|join` (missing argument), `anet network <unknown>` | usage error | 0 → 2 |
| `anet token ls\|create\|revoke` | not logged in, Hub error, unreachable | 0 → 1 |
| `anet token revoke` (no token id) | usage error | 0 → 2 |
| `anet passwd` | not logged in, passwords differ, Hub refused, unreachable | 0 → 1 |
| `anet activate` | not initialized, activation failed, unreachable / no license key | 0 → 1 / 0 → 2 |
| `anet status`, `anet tasks` | no Hub configured; `anet tasks` unreachable | 0 → 1 |
| `anet hub start` | Hub did not come up within 15 s (including Bun missing) | 0 → 1 |
| `anet hub stop` | see [Stopping the Hub](#anet-hub-stop) above | 0 → 1 / 2 |
| `anet hub admin reset-user` | no `--username` / DB not found, reset failed | 0 → 2 / 0 → 1 |
| `anet hub <unknown>`, `anet node <unknown>`, `anet session <unknown>`, `anet batch <unknown verb>` | usage error | 0 → 2 |
| `anet node resume` (no node), `anet logs` (no node), `anet batch <verb>` (no prefix) | usage error | 0 → 2 |
| `anet project down` (a node failed to stop), `anet node delete` (node process refused to exit) | already set exit code 1, but the CLI's final `process.exit(0)` overrode it | 0 → 1 |
| `anet upgrade` | a package failed to upgrade or its registry lookup failed | 0 → 1 |
| `anet node delete --force` | local files deleted, but the Hub row was not removed (unreachable / refused); prints a `--hub-only` retry command | new: 1 |
| `anet create --batch`, `anet batch cleanup` | no Hub, invalid preset/option, auto-login failed, no node created | 0 → 1 / 2 |
| `anet demo …` | no Hub / token / key, creating the Network or nodes failed | 0 → 1 |

Some older usage-error paths still exit `1` (also non-zero, so scripts still catch them); they were not changed just to make them `2`. `anet hub status` is a status query and still exits `0` when the Hub is not running.

## Errors and secrets

- On an error anet prints one sentence and the next command to run, without a stack trace. To see the stack: `ANET_DEBUG=1 anet …`.
- A fatal error whose message is an error code still prints `[anet] FATAL: Error: <CODE>`, so scripts can pull the code from logs.
- anet never prints a full secret: `anet config`, `anet config json`, `anet node start` and `anet doctor` show tokens as `utok_…ab12` (prefix…last 4). Tokens, `Bearer` headers and `token=` URL parameters inside error messages are masked the same way.
- `anet node create --env KEY=…` and `anet node migrate-token-to-envref` write the secret to `.anet/nodes/<node>/.env` (mode 600, gitignored) and print only the masked value plus an `export` command that reads it from that file.
- Exceptions: `anet token create` and `anet hub admin reset-user` exist to hand out a new credential and show it once.

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
- [Token model](/en/guide/account-system#tokens)
