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

### Creating a Codex co-presence node through the daemon {#codex-copresence-via-daemon}

`runtime: "codex-app-server"` on its own creates a headless node. For a Codex TUI shared by a human and
the agent, put `"copresence": true` in `create_node`'s `node_spec.flags`:

```json
{"name": "codex-human", "runtime": "codex-app-server", "flags": {"copresence": true}}
```

The daemon writes `codexCopresence: true` into the child's config, so every `anet node start <name>`
(including the one the daemon runs itself) takes the co-presence path: app-server, bridge and TUI in
three tmux sessions. The daemon's machine therefore needs `tmux` and a logged-in `codex`; anything
missing is reported at start (the request ends as `runtime_capability_check_failed`). Once it is up,
`tmux attach -t =<name>` on that machine opens the TUI.

- Only valid for `codex-app-server`; the Hub rejects the key on any other runtime (`flag_not_applicable_to_runtime`).
- An older Hub or daemon that does not know the key rejects the request (`flag_key_unknown`) instead of quietly creating a headless node.

### Task timeout: `flags.timeout` is in milliseconds {#create-node-timeout-ms}

`create_node`'s `node_spec.flags.timeout` is in **milliseconds**: the daemon writes it into the child's config
as is, and the node reads it as milliseconds (default when absent: 300000 = 5 minutes). The range is the same
one `update_node_config` uses for timeout changes:

- `0`: no limit;
- `1000`–`3600000`: 1 second to 1 hour, e.g. `600000` for 10 minutes;
- `1`–`999`, anything above `3600000`, fractions and strings: rejected by the Hub (`flag_value_invalid`, with a `reason` that says the unit is milliseconds).

```json
{"name": "long-runner", "runtime": "claude-agent-sdk", "flags": {"timeout": 600000}}
```

Older Hubs and daemons accepted only `1`–`86400`, as if in seconds: a node created with `600` really got a
0.6-second timeout, and `600000` was rejected. Newer ones do not multiply small values by 1000 (the intent
cannot be told apart); they reject them, so nobody silently ends up with a sub-second timeout. Configs of
existing nodes are not migrated, and the number in them always takes effect as milliseconds; change it with
`update_node_config` or by editing the config.

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

### Giving a new node its own working directory {#child-workdir}

Newer daemons (with a matching Hub) accept a per-node directory at create time. The desktop app's
"New node" confirm page shows a "Working directory" row, defaulting to `<default root>/<node name>`;
"Change" lets you enter another absolute path or `~/…`. The node's `.anet` and its process working
directory are there, so file tools do not see other projects or secrets in your home directory.

- The default root is the daemon user's `$HOME`, so the default is `$HOME/<node name>`. Override it with
  `default_workdir_root` in the daemon's `config.json` (`~/…` is allowed).
- Default directory names are always ASCII: the desktop app turns the node name into `[a-z0-9-]` (pinyin
  for Chinese, e.g. "吉他大师" → `jitadashi`; `node-<6 hex>` when nothing usable is left) and sends the full
  computed path to the daemon explicitly.
- A directory whose path below `$HOME` contains non-ASCII characters is rejected (`workdir_not_ascii`).
  The home directory itself is not counted.
- A missing directory is created with mode `0700`; an existing directory keeps its mode.
- Rejected: `$HOME` itself or any parent of it, `/`, system directories (`/etc`, `/usr`, `/var`, …), and a
  directory that already hosts another node (it has `.anet/nodes/<other name>/config.json`).
- A request without a working directory still lands in the daemon's workspace, exactly as before.
- Older daemons do not understand the field. The desktop app hides the row for them, and the Hub
  rejects a request with a working directory aimed at one (`workdir_not_supported_by_daemon`) instead of
  letting it be silently ignored.

Nodes created this way are not under the daemon's `<workdir>/.anet/nodes/`; the daemon records where they
are in `<workdir>/.anet/child-workdirs.json`, so stop, start and delete keep working. Delete moves the
config into that node directory's `.anet/deleted/` and leaves the directory itself in place.

::: warning Before changing the default root
If nodes are brought back at boot by scanning `$HOME/*/.anet` (for example this repo's
`deploy/fleet/anet-nodes-boot.sh`), the default `$HOME/<node name>` is inside that scan and a deeper
directory such as `$HOME/work/<node name>` is not. Before moving `default_workdir_root`, make sure your
boot mechanism covers the new location.
:::

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

## Adopted-node lifecycle {#adopted-lifecycle}

### Recovery after a machine reboot

Old boot IDs, PIDs and markers never authorize signals to current processes. The daemon may acknowledge
an already-absent node only after a no-signal check finds no matching sessions and no same-UID process
carrying the old marker or the node's CODEX_HOME. Any remaining/new-generation process requires fresh
adoption (`adopt_codex_readopt_required`); unreadable evidence fails closed. Delete remains unsupported
and preserves `adopted_node_delete_unsupported`, without removing directories or stopping processes.

A successful manual CLI start of either Codex co-presence layout writes `.hub-resumed`, superseding only
the exact `.hub-stopped` receipt captured before startup. It never unlinks a concurrently written stop.
Both `anet project up` and the repository `deploy/fleet/anet-nodes-boot.sh` understand this certificate;
a new stop automatically invalidates it. Failed starts and malformed/foreign evidence keep the node down.
Deploy the updated CLI and boot script together. Older scanners conservatively retain the stop. These
files are local state: restoring a backup with changed file identity keeps the stop until an explicit start.
Rollback does not automatically restart stopped nodes. Services, ports, secret sources and orchestration
are unchanged; this does not implement board #659 B remote three-stage startup.

Deployment is an operator action, not performed by this PR. Record the current CLI version and the
boot service's actual ExecStart path; back up its installed script and review drift against the repository.
Install the CLI released from an exact merged main commit, then install that commit's
`deploy/fleet/anet-nodes-boot.sh` at the service's actual entrypoint, preserving executable permissions.
Verify the CLI version and installed script SHA-256 against the release sources. In an isolated directory,
check retained stops, successful manual-resume certificates and subsequent new stops before scheduling
a real boot sweep; do not restart real nodes just to validate this change. Roll back the CLI and saved
script together without clearing stop receipts. Local state is restored only from node-data backups.
Fingerprints contain inode, ctime and content hash, not boot-dependent device numbers. Old-format
certificates conservatively retain the stop; an explicit successful start creates a new certificate.
Only probe exit 42 permits startup; exceptions and every other exit code keep the node stopped.

Stop / Start for adopted nodes is available from agent-node ≥ `2.5.0-preview.118` and agent-network (`anet`) ≥ `2.3.0-preview.151`.
From commhub-server ≥ `0.9.0-preview.109`, the Hub answers a restart of an adopted node with `adopted_restart_requires_daemon`, asking you to Stop and then Start (`.108` and earlier have no such refusal).
From the original workspace, run `anet daemon adopt <alias> --daemon <daemon-id>` to inspect the plan.
`--yes` only requests adoption; wait for independent daemon verification and an active Hub binding.
The daemon's `adopt_roots` defaults to empty (deny). Co-presence nodes are not supported.

- Stop rechecks configuration, UID and `/proc` birth identity and signals only the verified process tree.
- Successful stop writes `<nodeDir>/.hub-stopped`. `anet project up` and the repository boot sweep keep the node down without clearing its PID file.
- Start removes the marker and uses the trusted anet entrypoint with evidence captured before stop.
  Inferred launch modes, changed configuration or missing evidence fail closed.
- tmux requires an explicit private socket and verified original session/process ownership.
  Default sockets, unavailable private servers and still-occupied original sessions are refused.
- A binding does not prove an exit-75 supervisor exists. If Hub returns
  `adopted_restart_requires_daemon`, use Stop followed by Start. Ordinary and daemon-created nodes keep their previous restart behavior.

Recovery requires matching Hub database bindings and the daemon workspace's `.anet/child-workdirs.json`.
Registries, node configuration, credentials and stop markers require secure state backups; cloning the repository does not restore them.
With missing evidence, revoke and adopt again rather than inventing PIDs or launch evidence.
The CLI/daemon remains the launcher and `deploy/fleet/anet-nodes-boot.sh` remains the authoritative boot script.
Ports, proxies and credential sources are unchanged. Follow the upgrade/rollback and production deployment procedures;
before rollback, verify the target daemon retains adopted-node refusal guards rather than assuming every older version is safe.
Do not delete stop markers to bypass refusal.

## Client adoption reads (planned for Hub .110) {#adoption-read-api}

The daemon-only MCP tool `list_my_children` additionally returns `binding_request_id` on active
adopted items. This is the opaque binding generation. The caller must use the bound daemon's valid
node token, scoped to both daemon and network. Even the owner's utok cannot read it; this does not
prevent the owner from reading with the target daemon's valid node token. Hub .111 resolves identity
using token ownership or exact node binding (including its existing legacy-token compatibility rules),
not the token name alone. Tokens resolving to another daemon, the child's own node token, and
cross-network tokens cannot read this target daemon's binding. A child with no children of its own
receives a successful empty list using its valid node token.
`get_adopt_request` remains pending-only. Re-adoption after revocation creates a new
request ID; the old generation never revives. Old Hubs omit the field and the daemon preflight still
refuses: never fill missing authority from local state. **The projection is a read-time snapshot, not
a lease.** Executors must recheck the generation at action boundaries and honor in-flight lifecycle
revocation protection. This interface does not start processes. Old clients receive only an additional
field; existing fields and created items are unchanged. Old daemons may ignore it. This is not a claim
that released-client compatibility replay has already passed.

These additive fields and endpoint require a header user token (not a URL token) and the existing node
visibility/network permissions. Daemon/network tokens gain no new read access;
existing fields remain unchanged. This is not candidate discovery.

- `GET /api/nodes` adds `managed: "created" | "adopted" | "none"`, based on real
  creation records (precedence), active bindings, or neither—not ID prefixes or
  hostnames. `adoption` is the latest binding's
  `{request_id,daemon_node_id,status,error}` or null. States remain
  `pending / active / refused / revoked`; pending is not success.
  Creation records prefer `child_node_id`; only legacy null values fall back to `cr_X → node_X`.
- `GET /api/host-supervisors` adds `adopt_capable` for visible daemons only when
  they reported an actual boolean. Absence means unknown, not supported.
- `GET /api/node-lifecycle-requests?kind=adopt&request_id=...` requires kind
  `adopt / start / stop` and exactly one of `request_id` or `node_id`. Optional
  `network_id` follows existing scope rules. Node lookup returns the latest
  request (created_at descending, request_id descending as tie-breaker), or
  `{ok:true,request:null}` if none exists. Missing/invisible nodes or requests
  return 404; an explicitly forbidden network or non-user credential returns
  403; invalid selectors return 400.

Response: `{ok:true,request:{kind,request_id,node_id,network_id,daemon_node_id,status,error,created_at,...}}`.
Adoption also returns updated_at; start/stop return delivered_at and acked_at.
Times are UTC milliseconds or null. Start states are
`pending / delivered / started / start_failed / timeout`; stop states are
`pending / delivered / stopped / stop_failed / noop_not_my_child`.
HTTP 200 and pending are not operation success. Error codes include
`adopt_explicit_private_socket_required`, `adopt_start_evidence_missing`, and
`adopt_active_binding_required`; present actionable guidance rather than hiding
the refusal. A newer start request may supersede a stale one as `timeout`; this is not success.
Delete requests are excluded. Result fields omit tokens, workdirs, PIDs and snapshots;
error values are separately sanitized as follows.
Every new read projection only exposes exact allowlisted error codes. Unknown codes,
diagnostic text and empty strings become `lifecycle_error`; null remains null.
Raw errors stay in the database, without leaking paths or host details to node readers.

No new service, port, configuration or database migration. Use the existing
upgrade/rollback procedures. Binding/request history comes from Hub database
backups, not Git. No production deployment or new recovery drill is claimed.

## Related {#related}

- [Keeping the Hub running (pm2 / systemd)](/en/deploy/keep-alive)
- [Production and public-internet security](/en/deploy/production)
- [CLI reference](/en/guide/cli)
- [Troubleshooting](/en/troubleshooting)
- [Lifecycle-request reliability model (daemon ↔ hub)](https://github.com/sleep2agi/agent-network/blob/main/docs/daemon-lifecycle-reliability.md) (developer-facing)
