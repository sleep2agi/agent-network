# Keeping the Hub alive

A production Hub needs a process supervisor. A bare `nohup ... &` will not recover
after a crash, reboot, or accidental kill.

::: tip Which daemon are you after? This page covers two things
"daemon" means two **different** things in this project — the names collide.
Pick yours first:

| What you want | Where |
|---|---|
| **Try `anet daemon`** — start a `host_supervisor` node (RFC-026) that the Dashboard can drive remotely and that can create/manage other nodes for you | ⬇️ next section, [Try `anet daemon` in 5 minutes](#try-anet-daemon) |
| **Make the Hub survive a crash** — supervise the `anet hub start` process with PM2 / systemd | ⬇️ everything from [Prerequisites](#hub-prereqs) down |

They are independent — doing one does not require the other.
:::

## Try `anet daemon` in 5 minutes {#try-anet-daemon}

> 🔴 **Every command below was actually run in a clean `node:22-bookworm-slim`
> container** (2026-08-27); the output shown is real, not illustrative.
> Measured with `anet v2.3.0-preview.47` + `agent-node v2.5.0-preview.34` +
> `commhub-server v0.9.0-preview.30`.

### 0. Install (`bun` is not optional)

```bash
npm i -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

🔴 **`bun` is a hard prerequisite.** Without it the very first command stops at:

```
❌ anet hub start requires the Bun runtime
   (commhub-server is bun-only — uses Bun.serve + bun:sqlite, no Node fallback)
```

🔴 **Versions: a plain install is enough — do not hand-copy a version number.**
`latest` now ships `anet daemon` (measured: `2.3.0-preview.47`). Check yours with
`anet -v`; if `anet daemon` prints `Unknown command`, your build predates the
command — see [which versions have it](#which-versions).

### 1. Start the Hub

```bash
anet hub start
```

It prints a banner containing a **randomly generated admin password, shown only once**:

```
  ✅ Server running on http://127.0.0.1:9200 (commhub-server v0.9.0-preview.30)
  ✅ Admin account created
     username: admin
     password: anet-90ddcdbe2b3f4f81a66ff5      ← yours will differ; copy it now
     Store this password now; it will not be shown again.
```

🔴 That password is **different on every machine** (random bootstrap password, since
`2.2.22-preview.4`). Use the one from your own run, not the one above.

### 2. Log in

The banner hands you the assembled command — copy it:

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password <from your banner>
```

```
✅ Logged in as admin
⚠ Your password is the BOOTSTRAP DEFAULT and must be changed.
   Change it now:  anet passwd
   network: admin
   token saved to ~/.anet/config.json
```

🔴 **Order matters.** Running `anet daemon up` before logging in stops at
`未登录或缺少 network_id。请运行: anet login` (exit code 1).

### 3. Start the daemon — one command

```bash
anet daemon up
```

Real output:

```
[anet daemon] ✓ created host_supervisor daemon "daemon"
              config:     .anet/nodes/daemon/config.json
              node_id:    node_daemon_8d94ac332abb

[anet daemon] ⚠ Permission posture:
              flags.dangerouslySkipPermissions = true  (no per-call confirmation)
              flags.teammateMode = true
              role = host_supervisor                   (can fork child agent-nodes via hub)
              → Run daemons only on machines you trust to act on your behalf.

[anet] Starting new session for "daemon" [claude-agent-sdk]...
[daemon] 已注册到 CommHub
[daemon] SSE connected
```

🔴 **`anet daemon up` holds the terminal** — a daemon is a long-running process.
To background it, see [Keeping a daemon alive](#keep-daemon-alive) below.

⚠️ Note the **Permission posture** block: a daemon runs with
`dangerouslySkipPermissions` + `teammateMode` and can fork child nodes through the hub.
**Only run one on a machine you trust to act on your behalf.** To tighten it, edit
`.anet/nodes/daemon/config.json`.

### 3.5 Keeping a daemon alive {#keep-daemon-alive}

`anet daemon start` runs in the foreground. **If you started it over SSH, it dies with the
session.** The three recipes below were each walked through on a real machine on 2026-08-27
and verified the same way: **disconnect, then check that the hub-side heartbeat is still
advancing** — never by trusting the startup banner.

**Linux / macOS — `nohup`, then verify the heartbeat**

```bash
cd ~                       # daemon config is cwd-relative: start it where you ran init
nohup anet daemon start <name> > ~/daemon-<name>.log 2>&1 &
sleep 25 && tail -5 ~/daemon-<name>.log   # expect "registered to CommHub" + "SSE connected"
```
After disconnecting, wait 3+ minutes and re-read `last_seen_at` on the hub:
**only a still-advancing heartbeat proves it survived.** For crash-restart, use the PM2
setup in the rest of this page with `anet daemon start <name>` as the supervised command.

**Windows — a PowerShell Job will not survive**

```powershell
# ✗ Start-Job: reclaimed together with the SSH session; the daemon vanishes silently
# ✓ WMI process creation: detaches from the session tree
Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = "C:\Users\<you>\start-daemon.bat" }
```
`start-daemon.bat` (**wrap it in a .bat** — passing a long command line with quotes and
redirection straight to WMI returns `ReturnValue=21`, "invalid parameter"):
```bat
@echo off
cd /d C:\Users\<you>
anet daemon start <name> >> C:\Users\<you>\daemon-<name>.log 2>&1
```

🔴 **Two traps hit for real:**

1. **cwd decides whether the daemon can find itself.** `anet daemon init` writes the config
   under the **working directory at that moment** (`.anet/nodes/<name>/`). Start it in the
   background from somewhere else and you get
   `Daemon "<name>" not found. Create it first:` — the config exists, it just isn't there.
   So the background command must `cd` back to the init directory.
   (Easy to hit on Windows: the SSH login cwd may not be `C:\Users\<username>` — the
   account name and the profile directory name need not match.)
2. **Startup output is not a readiness check.** `anet daemon list` only reads local config;
   being listed does not mean the hub knows about it. The criterion is hub-side:
   `last_seen_at` still advancing.

### 3.6 Let the daemon actually create nodes: auto-pin `ANET_BIN` {#anet-bin-pin}

When a daemon receives `create_node`, it must fork the currently installed `anet`. To avoid
`PATH` hijacking, the runtime still accepts only a verified absolute path; but
`anet daemon init` / `start` / `up` now prepares that path automatically. Users no longer need
to manually run `readlink -f`, `chmod`, or export daemon-specific environment variables.

Daemon startup now automatically:

1. Resolves the current `anet` launcher to its real file and injects `ANET_BIN_ABS`.
2. Diagnoses missing, non-absolute, symlink, group/other-writable, and non-executable paths separately.
3. Refuses to start for the common npm `775` / group-writable install produced under `umask 0002`, and prints the exact `chmod go-w` command to run.
4. Allows non-root nvm/homebrew/npm installs by default, because the binary is the user's own file.
5. Rejects daemon mode on Windows up front, instead of waiting for POSIX-only path and mode checks to fail during node creation.

The expected path is simply:

```bash
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node
anet login
anet daemon up
```

If a safety check fails, the CLI prints a one-line repair command that can be copied and run
directly; do not work around it by editing untracked server startup files.

**Criterion**: issue one `create_node` from the hub; the daemon log must show
`[create-node] spawned child '<name>' pid=…` plus `+5000ms capability check OK`, and the new
node must register itself back to the hub. **Without those two lines it is not wired up** —
it will not retry.

### 4. Confirm the **process** came up

```bash
anet daemon list
```

```
Local host_supervisor daemons (1):
  daemon   node_id=node_daemon_8d94ac332abb  runtimes=[claude-agent-sdk,codex-sdk,grok-build-acp]
```

On the Hub side you get a heartbeat every 3 minutes:

```
[08:36:00] SSE ← net_b84e736f347c:daemon connected (1 clients)
[08:39:01] daemon (sdk-node) → report_status: idle [net]
[08:42:01] daemon (sdk-node) → report_status: idle [net]
```

🔴 **`anet daemon list` only reads local config** — being listed there does not mean the
hub knows about it. For that, look at the `SSE ←` / `report_status` lines above, or find
`daemon` in the Dashboard node list.

🔴 **But this section only confirms "the process is alive and the hub can see it" — not
"it can do work for you."** A daemon with a healthy heartbeat can still be **unable to
create any node**. The acceptance check for that is in the next section.

### 5. Drive it remotely from the Dashboard

Once the daemon is up and connected, open the Dashboard:

```bash
anet hub dashboard        # http://localhost:3000 by default
```

`daemon` appears in the node list with `role=host_supervisor`. What separates it from an
ordinary node: **it can create and start other nodes on that machine for you** — which is
the point of remote node creation. You no longer need to ssh in and run `anet node create`
by hand.

::: danger 🔴 Your first node creation: `ok:true` is **not** the success criterion
At this step every signal you can see says it worked: the daemon is online, the heartbeat
is healthy, the Dashboard lists it under "choose a server", and clicking through makes
`create_node` return **`ok:true` plus a request_id**.

**And the node may not have been created at all.** The failure is written only to the
**local log on the daemon's own machine** — the hub never learns about it and the
Dashboard never turns red. **Anyone who does not know to open that log gets stuck here.**

**So verify your first creation from the log, not from the UI:**

```bash
# on the machine running the daemon
tail -f ~/daemon-<name>.log        # or whatever file you redirected to at startup
```

| What you see | Meaning |
|---|---|
| `[create-node] spawned child '<name>' pid=…`<br>`+5000ms capability check OK` | ✅ really created; the new node registers itself with the hub |
| `[create-node] anet_bin_unsafe_path: …` | ❌ `ANET_BIN` is not pinned correctly → [§3.6](#anet-bin-pin). **It does not retry** |
| nothing at all | ❌ the doorbell never arrived — check the daemon is really connected (§4) |

⚠️ **On Windows this step currently always fails**, with the same deceptive symptoms
(registration, heartbeat and `ok:true` all look fine) — see [the end of §3.6](#anet-bin-pin)
and [#1290](https://github.com/sleep2agi/agent-network/issues/1290). Until #1290 is fixed a
Windows machine can run a daemon, but **do not expect it to fork child nodes**.
:::

---


::: warning Use exactly one supervisor
Do not let PM2, systemd, and a cron watchdog manage the same Hub. Competing
supervisors can start two processes against one port and one SQLite database.
:::

## Prerequisites (in order — each one will stop you) {#hub-prereqs}

Measured on a clean machine. All three fail closed with an actionable
message, but the docs never showed them as one chain, so you hit them one at
a time:

| # | What you see if it is missing | Fix |
|---|---|---|
| 1. **Bun ≥ 1.2** | `❌ anet hub start requires the Bun runtime (commhub-server is bun-only — uses Bun.serve + bun:sqlite, no Node fallback)` | `npm i -g bun`, then **restart your shell** so PATH picks it up |
| 2. **Hub running** | `未找到 CommHub Server。请先运行: anet hub start` | `anet hub start` (up in ~3s) |
| 3. **Logged in with a network_id** | `未登录或缺少 network_id。请运行: anet login` | `anet register`, or `anet login` |

::: warning `anet daemon` is not what the rest of this page daemonizes
The **rest of this page** is about keeping the Hub alive with PM2 (`anet hub start`).

`anet daemon init` / `up` is a different thing: it creates and starts a
`host_supervisor` node (RFC-026). Similar names, different jobs — for the walkthrough
see [Try `anet daemon` in 5 minutes](#try-anet-daemon) above.
:::

### Which versions have `anet daemon` {#which-versions}

🔴 **This box used to say the opposite**, because it was pinned to a number that drifts.
It read: "`anet daemon` only exists on `preview`; `latest` prints `Unknown command`."
That was measured on 2026-08-18 against the then-`latest` (`2.2.21`). **Both halves of
that premise are false today.**

So this section does not say *which channel* has it — only how to check for yourself:

```bash
anet -v                 # which build you have
anet daemon             # present: prints  Usage: anet daemon <subcommand> …
                        # absent:  Unknown command "daemon". Did you mean: anet demo? (exit 1)
```

| Version | `anet daemon` | Evidence |
|---|---|---|
| `2.2.21` | ❌ `Unknown command "daemon"` | measured 2026-08-18 (`latest` at the time) |
| `2.3.0-preview.39` | ✅ `Usage: anet daemon <subcommand> …` | measured 2026-08-18 (`preview` at the time) |
| `2.3.0-preview.47` | ✅ `Usage: anet daemon <subcommand> …` | measured 2026-08-27 — **and it was that day's `latest`** |

⇒ **State a lower bound, not a channel**: `2.3.0-preview.39` and later have it; `2.2.21`
does not. The table lists **measured points, not the exact boundary** — the individual
release between `2.2.21` and `.39` was not bisected.
**Do not write "whether `latest` has it" into docs**: what `latest` points at changes (on
2026-08-27 it was already `2.3.0-preview.47`), so a conclusion pinned to a channel needs
rewriting again within days.

## Recommended entry point

Supervise `anet hub start`; do not pin an old `commhub-server` preview in the
configuration. `anet` selects the Server version paired with the installed CLI.

Resolve the real executable paths first:

```bash
command -v anet
command -v bun
```

::: warning Do not use `bunx` / `npx` as the daemon entrypoint
`bunx` / `npx` unpack the package into a cache directory under `/tmp` and **execute it from there**.
After a reboot `/tmp` is cleared and the daemon can no longer start — PM2 will only show repeated
restarts, with no hint of the cause. Always use the **absolute path** from `command -v`.
:::

This PM2 example uses the absolute path returned by `command -v anet`:

```js
// hub.ecosystem.config.js
module.exports = {
  apps: [{
    name: 'commhub-hub',
    script: '/absolute/path/to/anet',
    args: 'hub start',
    interpreter: 'none',
    env: { HOST: '127.0.0.1', PORT: '9200' },
    autorestart: true,
    // min_uptime must exceed how long a failing start takes to exit. If it is
    // smaller, PM2 counts the start as successful, never trips backoff, and a
    // crash loop looks like ordinary restarts.
    min_uptime: 45000,
    // backoff without max_restarts = a failing process retries forever. That is
    // deliberate here: the Hub should keep self-healing. The cost is that a truly
    // broken process retries indefinitely and floods the logs. Add max_restarts
    // if you want it to give up after N attempts.
    exp_backoff_restart_delay: 200,
    kill_timeout: 10000,
    max_memory_restart: '2G',
  }],
};
```

The filename has to let PM2 recognise the file as a **config** rather than a
**script**: `*.config.js`, `*.config.cjs`, `*.json`, and `*.yaml` all work (the
files under `deploy/` in this repo are named `ecosystem.config.cjs`). A name that
matches none of those shapes is executed as a plain script — PM2 may show it as
`online` and never start the Hub.

Start and verify it:

```bash
pm2 start hub.ecosystem.config.js --only commhub-hub
pm2 status commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

Do not treat PM2's green status as proof; `/health` proves that the service responds.

## This repo's authoritative config lives in `deploy/`

The example above is a generic starting point. The configuration this project
actually runs in production is already committed — there is no need to retype it:

- [`deploy/hub/ecosystem.config.cjs`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/ecosystem.config.cjs) — the Hub's PM2 process definition (no secrets)
- [`deploy/hub/hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh) — the guarded launcher, with four fail-closed prechecks (bun / pinned install / vault key / port already listening)
- [`deploy/fleet/`](https://github.com/sleep2agi/agent-network/blob/main/deploy/fleet) — the systemd **user** units and the fleet boot chain
- [`deploy/hub/README.md`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/README.md) — the Hub version-switch procedure (rehearsed)

What sits in `~/.local/bin/` on the production host is a **deployed copy**; the Git
authority is `deploy/`. Change both together, and check for drift with
[`deploy/check-deployed-copies.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/check-deployed-copies.sh).

## Derive `min_uptime` from how long a failing start takes to exit

The rule: `min_uptime` must be **greater** than the time a failing start needs to
reach its exit. Set it lower and PM2 records the failure as a successful start —
`max_restarts` never accumulates, `exp_backoff_restart_delay` never engages, and a
crash loop looks like ordinary restarts.

**How to obtain that number**: read the fixed delays on the guarded script's failure
path. `hub-daemon.sh` routes every failed precheck through `fail_slow()`, which
sleeps 30 seconds and then exits 1 — so a failing start takes about 30 seconds, and
anything guarding it needs `min_uptime` above `30000`. A bare `anet hub start`
usually fails much faster, so the `45000` used in the example above clears both
entry points.

Measured (PM2 inside a `node:22-bookworm-slim` container, the same "exit 1 after 30
seconds" script, observed for 100 seconds — roughly three cycles):

| `min_uptime` | `restarts` | `unstable restarts` |
|---|---|---|
| `20000` | 3 | **0** — backoff never engages |
| `45000` | 3 | 3 |

An `unstable restarts` stuck at 0 is the reading that says this protection is
already inert: PM2 believes every start succeeded. Check that field when reviewing a
supervisor config — `restarts` alone will not tell you. (The review of this repo's
current value is tracked in [#1223](https://github.com/sleep2agi/agent-network/issues/1223).)

## Security boundaries

- Keep `HOST=127.0.0.1` by default. Complete the [production security setup](/en/deploy/production) before allowing remote access.
- Never use `--dev-open` in production.
- Do not put tokens or vault keys in the ecosystem file; PM2 persists environment variables.
- Never clean up with `pkill -f` or `killall`. Resolve and stop the exact PID.
- Keep restart backoff enabled so missing dependencies or registry failures do not create a tight restart loop.

If a secret environment variable is unavoidable, keep it in a separate mode-`600`
file and load it from a minimal wrapper. Verify that the value is absent from logs,
the PM2 dump, and configuration. Avoid `export $(grep ...)`: an empty match can
degrade into a command that prints the whole environment.

## Verify automatic recovery

Test once during a maintenance window:

1. Record the exact PID from `pm2 pid commhub-hub`.
2. Send `SIGTERM` to that PID; do not use a process-name pattern.
3. Confirm that `/health` returns 200 again.
4. Confirm that the PID changed.

All four checks matter. An unchanged PID only shows that the process never stopped;
a new PID with a failing health check only shows that PM2 restarted a broken process.

## Start on boot

```bash
pm2 startup
```

This prints, but does not execute, the systemd command that must run as root. Run
the printed command, verify the Hub, and only then save the process list:

```bash
pm2 save
ls /etc/systemd/system/pm2-*.service
```

`loginctl enable-linger` alone does not create PM2's systemd unit.

## Change configuration safely

Validate the replacement before removing anything. Do not `pm2 delete` the old
entry and then gamble on untested flags.

```bash
pm2 startOrReload hub.ecosystem.config.js --only commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

Disable an existing cron watchdog before handing ownership to PM2. If ownership is
unclear, stop and identify which supervisor controls the Hub first.

## Related

- [Production and public-internet security](/en/deploy/production)
- [Upgrade guide](/en/guide/upgrade)
- [Troubleshooting](/en/troubleshooting)
- [`deploy/` — the Git authority for this repo's deployment assets](https://github.com/sleep2agi/agent-network/blob/main/deploy)
