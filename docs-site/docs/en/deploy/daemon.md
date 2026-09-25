# `anet daemon`: create nodes on a remote machine

`anet daemon` starts a `host_supervisor` node on a machine. Once it is connected to the Hub, you can
create, start, and stop nodes on that machine from the Dashboard or the desktop app, without SSHing in
to run `anet node create`.

::: tip Looking for "restart the Hub automatically when it crashes"?
That is a different job: supervising the `anet hub start` process with PM2 / systemd. See
[Keeping the Hub running (pm2 / systemd)](/en/deploy/keep-alive). The two are independent; you can do
either one on its own.
:::

## What a daemon is {#what-it-is}

A daemon is an agent-node with `role=host_supervisor`. It only performs deterministic node lifecycle
operations: create, stop, restart, delete, and probe other nodes, all driven by structured requests from
the Hub.

- It is not a chat agent and does not use a model to interpret free text. A natural-language task sent
  to it gets a short reply saying it is a program node and to use structured commands. To get AI work
  done, send the task to an ordinary agent node.
- By default it runs with `dangerouslySkipPermissions` + `teammateMode` and can fork child nodes through
  the Hub. **Only run a daemon on a machine you trust to act on your behalf.** To tighten it, edit
  `.anet/nodes/<daemon-name>/config.json`.
- Only Linux and macOS are supported (on Windows, run it inside WSL). Since `2.3.0-preview.52`,
  `anet daemon init` / `start` / `up` / `restart` exit with an error on native Windows.

## Prerequisites {#hub-prereqs}

Check these in order. Each one blocks you if it is missing, and each fails with an actionable message:

| # | What you see if it is missing | Fix |
|---|---|---|
| 1. Bun ≥ 1.2 | `❌ anet hub start requires the Bun runtime (commhub-server is bun-only — uses Bun.serve + bun:sqlite, no Node fallback)` | `npm i -g bun`, then restart your shell so PATH picks it up |
| 2. Hub running | `未找到 CommHub Server。请先运行: anet hub start` ("CommHub Server not found") | `anet hub start`, or `anet init --hub <hub-url>` to point at an existing Hub |
| 3. Logged in with a network_id | `未登录或缺少 network_id。请运行: anet login` ("not logged in") | `anet register` to create an account, or `anet login` |

### Which versions have `anet daemon` {#which-versions}

`anet daemon` is available in `@sleep2agi/agent-network` `2.3.0-preview.39` and later; `2.2.21` and
earlier do not have it. Do not reason from the channel name; check the build you have:

```bash
anet -v                 # which build you have
anet daemon             # present: prints  Usage: anet daemon <subcommand> …
                        # absent:  Unknown command "daemon" (exit 1)
```

Other features on this page have their own lower bounds:

| Feature | Requires |
|---|---|
| The `anet daemon` command | agent-network ≥ `2.3.0-preview.39` |
| "Create capability" line in `anet daemon list` | agent-network ≥ `2.3.0-preview.70` |
| `anet daemon restart` | agent-network ≥ `2.3.0-preview.73` |
| `ANET_BIN` auto-pin also when a daemon is started by `anet node start` / `node restart` / `project up` | agent-network ≥ `2.3.0-preview.110` |
| Daemon re-measures create capability and reports when it measured | agent-node ≥ `2.5.0-preview.55` |

## Try `anet daemon` in 5 minutes {#try-anet-daemon}

### 1. Install

```bash
npm i -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

`bun` is required; the Hub only runs on Bun. A plain install is enough, with no version number to copy.
Afterwards check `anet -v` against [the version requirements above](#which-versions).

### 2. Start the Hub and log in

```bash
anet hub start
```

The banner contains a randomly generated admin password that is **shown only once**. Copy it now:

```text
  ✅ Server running on http://127.0.0.1:9200 (commhub-server v<version>)
  ✅ Admin account created
     username: admin
     password: anet-<random>
     Store this password now; it will not be shown again.
```

The banner also prints the assembled login command:

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password <password from your banner>
```

The first login asks you to change this bootstrap password with `anet passwd`. Log in before starting
the daemon; otherwise `anet daemon up` stops at `未登录或缺少 network_id` ("not logged in").

### 3. Start the daemon

```bash
anet daemon up
```

The output looks like this:

```text
[anet daemon] ✓ created host_supervisor daemon "daemon"
              config:     .anet/nodes/daemon/config.json
              node_id:    node_daemon_<id>

[anet daemon] ⚠ Permission posture:
              flags.dangerouslySkipPermissions = true  (no per-call confirmation)
              flags.teammateMode = true
              role = host_supervisor                   (can fork child agent-nodes via hub)
              → Run daemons only on machines you trust to act on your behalf.

[daemon] 已注册到 CommHub
[daemon] SSE connected
```

`anet daemon up` is `init` + `start`; with no name, the daemon is called `daemon`. It is a long-running
process and holds the terminal. To run it in the background, see
[Keeping a daemon running](#keep-daemon-alive).

Startup also prints `workdir:`. That is the daemon's workspace, and it decides which nodes the daemon can
reach; see [Which nodes a daemon can reach](#workspace).

### 4. Confirm the daemon is online {#confirm-running}

`anet daemon list` lists the daemons configured in the current directory and asks the Hub whether each
one can create nodes right now:

```bash
anet daemon list
```

```text
Local host_supervisor daemons (1):
  scanned: <workdir>/.anet/nodes
  daemon                   node_id=node_daemon_<id>  runtimes=[…]
    创建能力:可用(5s 前测)
```

Being listed only means the config exists on this machine. To see whether the daemon is really connected
to the Hub, check that `anet node ls` shows it as `idle` / `working` with `●` in the SSE column, or look
at the Dashboard node list.

The "create capability" line (currently printed in Chinese as `创建能力`) has several outcomes. They
mean different things and need different actions:

| The line starts with | Meaning | What to do |
|---|---|---|
| `创建能力:可用(…前测)` (available, measured … ago) | It could create nodes when last measured | Nothing |
| `创建能力:**不可用**(<reason code>,…前测)` (unavailable) | The daemon reports it cannot create nodes | The following lines give the cause and a one-line fix you can paste; the common one is `chmod go-w` |
| `创建能力:可用` plus a line saying it does not know when it was measured | An older agent-node measures only once at boot | Restart the daemon, or upgrade agent-node to ≥ `2.5.0-preview.55` |
| `创建能力:未知` (unknown) | This daemon never reported the field; its agent-node is too old | Upgrade agent-node, then restart the daemon. This is not "unavailable"; do not repair a healthy machine |
| `创建能力:查不到` (not found) | This machine could not read the field from the Hub | Read the rest of the line: no Hub address configured, the Hub rejected this machine's credentials (run `anet login`), the Hub has no such node_id, or the Hub is unreachable |

The measurement age matters: an "unavailable" measured weeks ago may have been fixed long since, and the
daemon simply never re-measured. If the Hub is unreachable the command still succeeds and shows the local
list.

If startup prints an "installed but not on PATH" warning, fix it first. Child nodes created by the daemon
inherit the daemon's PATH; otherwise they fail with "xxx CLI not found" for a program that is in fact
installed.

### 5. Create your first node from the Dashboard {#first-node}

Open the Dashboard:

```bash
anet hub dashboard        # port 3000 by default
```

The bind address is taken from `--ip`, then `--host`, then the `HOSTNAME` environment variable, falling
back to `127.0.0.1`. Inside containers `HOSTNAME` is usually set, so pass `--ip` explicitly if needed.

`daemon` appears in the node list with `role=host_supervisor`, and you can pick it under "choose a
server" when creating a node.

::: warning For your first node, trust the daemon log
`create_node` returning `ok:true` with a `request_id` only means the request was accepted, not that the
node was created. Some failures are written only to the log on the daemon's machine, and the Dashboard
does not turn red. Check the log for your first creation:

```bash
# on the machine running the daemon
tail -f ~/daemon-<daemon-name>.log     # or whatever file you redirected to at startup
```

| What you see | Meaning |
|---|---|
| `[create-node] spawned child '<name>' pid=…` and `+5000ms capability check OK` | Created; the new node registers itself with the Hub |
| `[create-node] anet_bin_unsafe_path: …` | The `anet` path check failed; see [`ANET_BIN` auto-pin](#anet-bin-pin). It does not retry |
| nothing at all | The request never reached the daemon; go back to [step 4](#confirm-running) and confirm it is connected |
:::

## Keeping a daemon running {#keep-daemon-alive}

`anet daemon start` runs in the foreground. If you started it over SSH, it exits when the session ends.

Run it in the background with `nohup`:

```bash
cd <directory where you ran init>     # daemon config is stored per directory
nohup anet daemon start <daemon-name> > ~/daemon-<daemon-name>.log 2>&1 &
sleep 25 && tail -5 ~/daemon-<daemon-name>.log   # expect "已注册到 CommHub" and "SSE connected"
```

Disconnect, wait a few minutes, and confirm from another session that it is still online (`anet node ls`
or the Dashboard). The startup banner does not prove it survives the session; only being online after you
disconnect does.

For automatic restart after a crash, supervise the `anet daemon start <daemon-name>` command with PM2 or
systemd, the same way as the Hub (see [Keeping the Hub running](/en/deploy/keep-alive#pm2)). Two things
to get right:

- The working directory (PM2 `cwd`, systemd `WorkingDirectory=`) must be the directory where you ran
  `anet daemon init`. Otherwise you get `Daemon "<daemon-name>" not found. Create it first:` even though
  the config exists; it is just not where the command looks.
- Supervise `anet daemon start`, not `agent-node` directly. A daemon started without going through `anet`
  never receives the `ANET_BIN` pin: it registers and heartbeats, but cannot create nodes (see the next
  section).

## `ANET_BIN` auto-pin {#anet-bin-pin}

When a daemon receives `create_node`, it forks the locally installed `anet` to create the child node. To
prevent `PATH` hijacking it accepts only a verified absolute path. `anet daemon init` / `start` / `up` /
`restart` prepare that path automatically:

1. Resolve the current `anet` launcher to its real file, inject `ANET_BIN_ABS`, and declare
   `ANET_DAEMON_ALLOW_ENV_BIN=1`.
2. Diagnose unresolved, non-absolute, symlink, group/other-writable, and non-executable paths separately.
3. Refuse to start on the group-writable (`775`) install npm produces under `umask 0002`, and print the
   exact `chmod go-w` command to run.
4. Accept non-root nvm / Homebrew / npm installs by default.

So normally all you need is:

```bash
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node
anet login
anet daemon up
```

The pin is not stored on disk; every start re-resolves it from the running `anet`. After upgrading
`anet`, `anet daemon restart <daemon-name>` re-pins it.

On agent-network ≥ `2.3.0-preview.110`, `anet node start <daemon-name>`, `anet node restart <daemon-name>`,
and `anet project up` apply the same rules when the node they start is a daemon. If verification fails,
the daemon still starts and prints the fix, and it reports "cannot create nodes" to the Hub, which greys
it out in the Dashboard.

### A running daemon that cannot create nodes {#anet-bin-fix}

Try the no-root fix first: restart it through `anet`:

```bash
anet daemon restart <daemon-name>
# older builds without restart:
anet node stop <daemon-name> && anet daemon start <daemon-name>
```

If the binary is writable by group/other, not executable, or not an anet package bin,
`anet daemon start` refuses and tells you why; follow its instructions. Do not work around the check by
editing startup files on the server.

### The two sources of the pinned `anet` path {#anet-bin-sources}

| Source | Used for |
|---|---|
| A `path.conf` file | Trust root; wins over the environment when present |
| `ANET_BIN_ABS` environment variable | Convenience for Docker, development machines, or manual operations; accepted only when `ANET_DAEMON_ALLOW_ENV_BIN=1` |

The location of `path.conf` comes from `ANET_DAEMON_PATH_CONF`, defaulting to
`/etc/anet-daemon/path.conf`. Point it at a file you own to get a pin that needs no root and survives a
restart:

```bash
ANET_BIN_REAL="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(command -v anet)")" \
  && mkdir -p "$HOME/.anet" \
  && printf 'ANET_BIN_ABS=%s\n' "$ANET_BIN_REAL" > "$HOME/.anet/path.conf" \
  && export ANET_DAEMON_PATH_CONF="$HOME/.anet/path.conf"
```

Put `ANET_DAEMON_PATH_CONF` in the daemon's own environment (systemd `Environment=`, PM2 `env`, or the
profile of the shell that starts it); otherwise a restart falls back to `/etc`. You only need to set these
variables by hand when you bypass `anet daemon` and assemble the startup command yourself.

## Which nodes a daemon can reach {#workspace}

A daemon's workspace is the directory it was started from. Every node it creates or starts lives under
`<workdir>/.anet/nodes/`. Nodes you created by hand in another directory are out of reach; this is not a
permission problem, they are simply not where the daemon looks.

To find a daemon's workspace (`<pid>` from `anet node ls` or `ps`):

```bash
ls -l /proc/<pid>/cwd            # Linux
lsof -a -p <pid> -d cwd          # macOS
ls <workdir>/.anet/nodes/        # the nodes it can reach are exactly these
```

Two daemons started from two directories on the same machine manage two node sets that cannot see each
other. To have a daemon manage a set of nodes, start it from the directory those nodes live in.
`anet daemon list` likewise lists only the daemons in the current directory.

Whether the workspace should become a fixed directory is tracked in
[#1722](https://github.com/sleep2agi/agent-network/issues/1722).

## Upgrading and restarting {#restart}

A daemon is a long-running process; upgrading the npm packages has no effect on a process that is already
running. Restart it after upgrading:

```bash
anet daemon restart <daemon-name>
```

`restart` requires agent-network ≥ `2.3.0-preview.73`. Earlier builds print
`Unknown daemon subcommand "restart"`; use two steps instead:

```bash
anet node stop <daemon-name>
anet daemon start <daemon-name>
```

There are no daemon-specific stop / delete / status subcommands; use the node commands directly:
`anet node stop`, `anet node delete`, `anet node ls`.

If `anet daemon list` says the daemon is missing some runtimes, run
`anet daemon init <daemon-name> --force` to backfill them. It keeps the `node_id` but issues a new token,
so restart the daemon afterwards.

## Related {#related}

- [Keeping the Hub running (pm2 / systemd)](/en/deploy/keep-alive)
- [Production and public-internet security](/en/deploy/production)
- [CLI reference](/en/guide/cli)
- [Troubleshooting](/en/troubleshooting)
- [Lifecycle-request reliability model (daemon ↔ hub)](https://github.com/sleep2agi/agent-network/blob/main/docs/daemon-lifecycle-reliability.md) (developer-facing)
