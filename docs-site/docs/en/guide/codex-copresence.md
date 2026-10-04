# Codex TUI Co-presence (`codex-app-server`, preview)

The `codex-app-server` runtime lets a **human and an Agent share one Codex session**: the human types, reads output, and handles approvals in the native Codex TUI while Agent Network tasks arrive through CommHub in the **same Codex thread**. Both sides see the same history and live events. ([RFC-030](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md), Phase 0A.)

> Unlike the headless `codex-sdk`, which is a background worker without a shareable live TUI, `codex-app-server` provides Codex TUI co-presence.

::: warning Preview
This is a **preview** feature. The `codex-app-server` runtime and `anet node start <name> --copresence` ship in the published packages on both the npm `latest` and `preview` channels (`anet --help` lists a "Co-presence" section); newer fixes land on `preview` first, so the steps below recommend the preview channel. The current implementation is still a trusted single-machine shape, not the production Policy Gateway. Connect only to a trusted Hub and accept only trusted tasks.
:::

## Prerequisites

- Install and authenticate the Codex CLI (protocol verification baseline: `codex-cli 0.144.x`):

```bash
npm install -g @openai/codex
codex login
```

- Install or switch to the preview channel (recommended; fixes land here first):

```bash
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
# If anet is already installed, switch the whole component set:
anet upgrade --channel preview

# Verify: help must include Co-presence / --copresence
anet -v
anet --help
```

- On Linux, macOS, and WSL, the one-command path also needs `bash` and **tmux 3.2+**. Native Windows uses managed background processes plus the current PowerShell/Windows Terminal and does not need tmux.
- The node must have a network-scoped `ntok_`. Run `anet doctor --fix` for an old node with no token, or recreate it.

## Recommended: choose co-presence at creation, then start or resume with one command

```bash
# 0. From an external clean shell, enter the project the node should operate on
cd /path/to/project

# Remove every inherited COMMHUB_* identity; do not enumerate only known names
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

# 1. Interactive creation: enter a node name, then choose “codex-cli — Codex co-presence TUI”
anet node create

# 2. Start the app-server, bridge, and attachable Codex TUI
anet node start codex-human

# 3. Linux/macOS/WSL: enter the shared human/agent TUI
tmux attach -t =codex-human
```

On native Windows, step 2 opens the Codex TUI directly in the current PowerShell/Windows Terminal. There is no step 3. To stop the complete topology, keep the TUI open and run `anet node stop codex-human` from another terminal.

A Codex thread inherits its working directory from the **app-server process cwd**, not the bridge cwd. `cd` into the target project **before** `--copresence`. On Linux, verify with `readlink /proc/<app-server-pid>/cwd`; checking only the bridge is insufficient.

`create --copresence` records the choice in the node profile. After that, plain `node start` rebuilds the same co-presence topology after a stop or interruption; the flag does not need to be repeated. For an existing node, run `anet node start codex-human --copresence` once and later starts can use the plain command.

`codex-cli` in the interactive runtime menu means co-presence mode: selecting it writes `codexCopresence: true` immediately, with no second question. `codex-sdk` is the headless Codex worker. Scripts can use the equivalent `anet node create codex-human --runtime codex-cli`; the older `--runtime codex-app-server --copresence` form remains compatible.

::: warning Release channel
The interactive choice ships from **preview.42**; native Windows one-command orchestration ships from **preview.43**. The Windows path passed a real `windows-latest` ConPTY test covering interactive creation, first start, stop, restart, and a second stop, with the restart proven to resume the same thread.
:::

Linux/macOS/WSL startup creates three tmux sessions carrying one shared identity marker. Windows creates two managed background processes and keeps the TUI in the current console:

| Session | Role |
|---|---|
| `codex-human-appsrv` | loopback-only `codex app-server` with CommHub MCP injected |
| `codex-human-桥` | the `agent-node` bridge that receives network tasks and submits them to the thread |
| `codex-human` | the native Codex TUI that a human can attach to |

On Windows, anet records each app-server/bridge PID, process creation time, and log path in private node state. `stop` calls `taskkill /T` only when both PID and creation time still match, preventing PID reuse from killing an unrelated process. Native Windows ACLs restrict credential state to the current user, SYSTEM, and Administrators.

### First start, not logged in, bridge that will not come up (#535)

- **⓪ agent-node**: before any tmux session exists, the launcher resolves the `@sleep2agi/agent-node` paired with this anet (the first run on a machine downloads it through npx, which can take a minute; it prints `⓪ agent-node: resolving …` meanwhile). The bridge then uses that validated entrypoint instead of running npx itself, so the download no longer eats the bridge's 25-second wait.
- **Not logged in = `needs-login`**: when the node's CODEX_HOME has no usable login (`auth.json` holds neither a ChatGPT token nor an API key), start no longer prints "✅ 就绪". It prints `needs-login` and the exact login command for that node (`CODEX_HOME=<node>/codex-home codex login --device-auth`), **starts nothing**, and exits 3. Log in, then `anet node start <node>`. It does not block when credentials live in the OS keyring (`cli_auth_credentials_store = "keyring"/"auto"`) or when `OPENAI_API_KEY`/`CODEX_API_KEY` is set in the environment.
- **Bridge failures stay readable**: the bridge's output also goes to `<node dir>/codex-bridge.log` (0600, truncated at each start, capped at about 2 MB). If the bridge does not attach, start prints its last 20 lines and the log path, and no longer offers a `tmux attach` to a bridge session that has already exited.

### Use exact tmux targets

`codex-human` is also a prefix of the other two session names. A normal
`-t codex-human` selector can silently match `codex-human-appsrv` or the bridge after
the TUI session exits. List the sessions and panes before operating:

```bash
tmux list-sessions -F '#{session_name}'
tmux list-panes -t =codex-human -F '#{pane_id} #{pane_current_command}'
tmux attach -t =codex-human
```

Use `-t =codex-human` for exact matching—or a pane ID such as `%42`—with
`capture-pane`, `send-keys`, and similar commands. Prefix matching is especially risky
after one of the three sessions dies.

Pressing `Ctrl-B D` in the TUI only detaches; it does not stop the node. Detach first, then stop it from a terminal **outside the co-presence process tree**:

```bash
anet node stop codex-human
```

The stop path uses a persistent identity marker to reap all three sessions and their children. Calling `stop` from inside the co-presence session fails closed so it cannot kill the caller's own shell.

::: info macOS stop guarantee
macOS uses the same startup, attachment, and TUI co-presence path as Linux, but P3 process-identity teardown depends on Linux `/proc`, so stopping on macOS degrades to the legacy sweep. The feature remains usable, but cleanup is less strongly guaranteed than on Linux. Run `anet node stop` outside the co-presence process tree and confirm that all three tmux sessions have exited.
:::

::: danger Stop the old process tree before recovery
The node profile remembers co-presence, so plain `anet node start codex-human` re-enters co-presence orchestration rather than downgrading to a headless node. Do not start again while an old bridge survives. From an external shell, stop the old tree, clear every `COMMHUB_*` variable, and restart with:

```bash
anet node stop codex-human
cd /path/to/project
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
anet node start codex-human
```

This is not theoretical: the production node `外部团队节点` ran a silent duplicate for about two days, and another production node, `另一团队节点`, did so for about nine days after operators followed the generic hint ([#535](https://github.com/sleep2agi/agent-network/issues/535)).
:::

### Which model the node runs {#model}

At start the model is resolved in this order, and **one value feeds the app-server (`-c model=`), the thread recovery (`thread/resume`'s `model`) and the TUI (`-m`)**:

1. `--model <id>` on this command (this start only; not written back)
2. `model` in the node config `.anet/nodes/<id>/config.json` (written by `anet node create --model` / `anet node edit --model`)
3. the built-in default

The start output names the value and its source, e.g. `[anet] model: o3 (source: node config …)`; when an existing session is resumed it also prints the model the thread is actually on. `anet node codex start|restart|resume` call this same path internally.

When the thread was recorded on a different model, **the configured model wins**: measured on codex 0.155, a `thread/resume` without `model` puts the thread back on the model in the rollout's last `turn_context` and ignores the app-server's `-c model=`, and once the first client has loaded the thread a later TUI `resume -m` does not change it. So anet sends the configured model on that first `thread/resume` (#512).

### Check the TUI for a pending approval before the first dispatch

::: danger The node can look completely healthy while doing nothing
Once a TUI attaches, MCP tool calls become interactive. With nobody watching the pane, the node stalls forever on:

```
Allow the commhub MCP server to run tool "get_task"?
› 1. Allow   2. Allow for this session   3. Always allow   4. Cancel
```

**Every signal the hub exposes still reads healthy**: `status=idle`, SSE connected, `last_seen_at` ticking. A dispatcher sees nothing wrong and assumes the node is simply free.

**The only way to detect it** (no hub field reveals this):

```bash
tmux capture-pane -t =<alias> -p | grep "Allow the commhub MCP"
```

**Fix**: choose `3. Always allow` — the commhub tools are what the node needs to function — or start the app-server with `-c approval_policy=never` so the prompt never appears.

Measured 2026-07-31: reproduced on a freshly created TUI; pre-existing co-presence nodes on the same host were unaffected because their app-servers were started with `approval_policy=never`. **This is a new-TUI hazard, not a latent fleet problem.**
:::

## Layered health, degraded refusal and self-healing {#health}

"Online" only means the bridge process is alive. From agent-node `2.5.0-preview.94`, nodes on the `codex-app-server` runtime (co-presence and ordinary alike) report the other layers to the Hub separately. The report travels with `report_status` as `health`:

| Layer | Content | Counts as down when |
|---|---|---|
| `bridge` | always `ok` (if the report arrives, the bridge is alive) | — |
| `app_server` | `{ ok, rtt_ms, last_error }`: one WebSocket handshake to the local app-server, every 30 s by default, waiting at most 5 s | `ok=false` |
| `tui` | `{ ok, reason }`, **co-presence nodes only**; `reason` is `running` / `session-missing` / `pane-dead` / `sleep-placeholder` / `tmux-unavailable` | `ok=false` |
| `model_auth` | `ok` / `revoked` / `expired` / `unknown`, classified from the last model call | `revoked` or `expired` |

- When a layer goes down or comes back, the node reports **at once** instead of waiting for the next heartbeat. The probe interval is `ANET_CODEX_HEALTH_INTERVAL_MS` (milliseconds, minimum 1000, mainly for tests).
- The Hub keeps only the latest report per node, in memory, for **10 minutes**. No report, a stale report, or a missing layer all mean "unknown", never "healthy". From Hub `0.9.0-preview.84`, `GET /api/status` includes the report (see [REST data endpoints](/en/api/rest-data)).

### Degraded nodes don't take new tasks

From Hub `0.9.0-preview.86`, if a node's health report is fresh and says `app_server.ok=false`, `tui.ok=false`, or `model_auth` is `revoked` / `expired`, **new tasks** to it are refused instead of queueing silently:

- REST `POST /api/task` returns **409** `node_degraded`; MCP `send_task` / `retry_task` / `reassign_task` return the same error. It lists each failing layer (`layers[].label` / `reason` / `hint`) and the report's age.
- A scheduled run is recorded as failed with `error_code=node_degraded`; no task is created.
- **Escape hatch**: a user token may pass `force: true` to dispatch anyway (for example the TUI is gone but the bridge can still work). `force` from a node token is ignored.
- Replies, `send_message` and acks are not affected. Old nodes that send no health report can be dispatched to as before.
- From desktop/mobile app `0.2.192`, a degraded node shows an amber 「降级 · reason」 (degraded) badge in the agent list and node detail; tap or hover for the fix.

### App Server watchdog: relaunch a dead app-server on the original session

From agent-node `2.5.0-preview.95`, every `app_server` probe result goes through a watchdog:

- **Process gone**: two failed probes in a row, or one failure right after a known process exit or WebSocket close, trigger a restart.
  - Co-presence nodes (Linux only, it reads `/proc`): the app-server is relaunched in the original tmux session with the original argv (same `--listen` address), this node's own `CODEX_HOME` and identity marker. The new process's `CODEX_HOME` is verified; a mismatch kills it and counts as a failed restart. The bridge then re-attaches to the original thread (`thread/resume`, never a new thread).
  - Ordinary `codex-app-server` nodes (the app-server is the bridge's child): a new one is spawned and the original thread resumed.
- While restarting, the health reason is `restarting app-server (attempt k/N): …`, so the Hub still treats the node as degraded. As soon as a probe answers, health flips back to ok and dispatch reopens by itself.
- **Budget**: at most `ANET_CODEX_APPSERVER_RESTART_MAX` restarts (default 3) per window of `ANET_CODEX_APPSERVER_RESTART_WINDOW_MS` (default 600000, i.e. 10 minutes). After that it gives up: the reason becomes `app-server auto-restart gave up: … — restart the node by hand (anet node restart)` and the node stays degraded until a probe sees the app-server answering again (someone fixed it by hand).

### Hung: the process is alive, the port is open, handshakes still fail

From agent-node `2.5.0-preview.96`, the watchdog treats "alive but hung" separately from "dead". Hung means the process is still there and the port still listens, but every handshake fails: the connection is dropped at once (ws 1006) or never answered.

- While hung, the health reason carries `app-server is alive but not answering (k/M failed probes before restarting it)`, and the Hub sees it straight away.
- After M failed probes in a row, the watchdog first **strictly verifies** that this is the process this node started. All four must hold:
  1. the tmux session id is unchanged and the process is still that session's live pane;
  2. `/proc/<pid>/cmdline` is `app-server … --listen <this node's address>`;
  3. `ANET_NODE_MARKER` in `/proc/<pid>/environ` is this node's (a node without a marker is never killed);
  4. `CODEX_HOME` in `/proc/<pid>/environ` is this node's own.

  **If any check fails, it only reports degraded (the reason says `not killing it: …`) and never sends a signal.**
- If the checks pass: SIGTERM (to the whole process group when the pane process leads it, so its children go too), then a grace period, then SIGKILL only if it is still alive and still ours. It then relaunches through the same path as above and shares the same restart budget.
- Knobs:

  | Environment variable | Default | Meaning |
  |---|---|---|
  | `ANET_CODEX_APPSERVER_HUNG_PROBES` | `4` | failed probes in a row before a live-but-hung app-server is restarted; about 2 minutes of failed handshakes at the default 30 s interval |
  | `ANET_CODEX_APPSERVER_KILL_GRACE_MS` | `10000` | wait between SIGTERM and SIGKILL, so codex can flush the session history that `thread/resume` reads back |

- **macOS / Windows** (no `/proc`): as before, report degraded only; the co-presence app-server is not restarted automatically and a hung process is not killed.

The watchdog never switches accounts, never copies credentials between nodes, and never touches another node's processes.

### Why every codex node has its own CODEX_HOME {#why-own-codex-home}

Every codex node (`codex-sdk` or co-presence `codex-app-server`) uses a `CODEX_HOME` **of its own**, for three reasons:

1. **Refresh tokens are single-use.** A ChatGPT login rotates its refresh token on every refresh and voids the old one; put one login into two `CODEX_HOME`s and whichever refreshes first wins, the other is logged out (#1918, #514 — see the next section).
2. **Sessions are stored per home.** codex keeps its sessions (rollouts) under `CODEX_HOME/sessions/`; two nodes on one home mix their histories.
3. **Stop / delete find processes by CODEX_HOME.** `anet node stop` / `delete` tell which processes belong to a node by its own `CODEX_HOME` (plus the co-presence marker); two nodes on one home cannot be told apart.

The cost is **one `codex login` per node**. anet makes that step visible:

- **The next step at create time.** When `anet node create` / `anet node clone` makes a codex node that will not have a usable login (none in its own `codex-home`, and its first start may not legitimately borrow this host's `~/.codex` login), the command ends with the exact command that logs **this** node in. It is printed, never run, and nothing is copied from another node:

  ```text
  [anet] Next step — my-node has no codex login yet. Each codex node logs in on its own, in its own CODEX_HOME
      mkdir -p -m 700 <node-dir>/codex-home && CODEX_HOME=<node-dir>/codex-home codex login
  [anet]   On a headless machine / over SSH use device auth instead:
      mkdir -p -m 700 <node-dir>/codex-home && CODEX_HOME=<node-dir>/codex-home codex login --device-auth
  [anet]   Then: anet node start my-node
  ```

  The `mkdir` appears only while the directory does not exist (codex refuses a `CODEX_HOME` that does not exist). `--device-auth` is the codex CLI's own device-code login, for machines without a browser. A `codex-sdk` node without a `codex-home` of its own uses codex's default `~/.codex`, and the step names that directory. `anet node codex fork --no-codex-login` already prints the same login command in its result.

- **Login status at a glance: `anet node codex login-status [--json]`.** One row per codex node in the current directory:

  ```text
  ALIAS  RUNTIME                         LOGGED IN  ACCOUNT            SHARED WITH  CODEX_HOME
  one    codex-app-server (co-presence)  yes        you@example.com    ⚠ two        <ws>/.anet/nodes/one/codex-home
  two    codex-app-server (co-presence)  yes        you@example.com    ⚠ one        <ws>/.anet/nodes/two/codex-home
  three  codex-app-server (co-presence)  no         -                  -            <ws>/.anet/nodes/three/codex-home
  ```

  - `ACCOUNT`: the e-mail in the `id_token` (decoded locally, no network); without one, the account fingerprint `acct:<16 hex>`.
  - `SHARED WITH`: other nodes holding the **same login** (the same refresh-token chain, same 8-hex fingerprint) — they will log each other out. Nodes in other workspaces are matched only by the fingerprint files they publish; their `auth.json` is never read.
  - Nodes on the same account that each logged in on their own are **not** sharing (that is the recommended setup); `--json` lists them under `same_account_as`.
  - Read-only; no token ever appears in the output.

  Why a separate command instead of `anet node codex account list`: that one lists the host's registered login **profiles** (keyed by profile id; its `--json` shape is already consumed). This one lists the **nodes** in this directory and the login each holds.

### One login per node {#one-login-per-node}

ChatGPT refresh tokens are **single-use**: every refresh issues a new one and invalidates the old. When one `auth.json` (one login) sits in two nodes' `CODEX_HOME`, whichever node refreshes first keeps working and the others fail days later with:

```text
Your access token could not be refreshed because you have since logged out or signed in to another account   (401 token_revoked)
```

So anet stops the sharing **at the moment a node is handed a login** (#514) — refused by default, exit code `1`:

| Path | Refused when |
|---|---|
| `anet node start <name> --copresence` staging this host's `~/.codex/auth.json` | the node's `codex-home` has **no** `auth.json` yet (a new node, a clone's first start) and **another node** on this host already uses that login |
| `anet node codex fork` | always copies the login the source is using → refused by default; `--no-codex-login` forks without one |
| `anet node codex account install` | another node already uses that profile's login |
| `anet node clone` | never copies `auth.json`; its first start is the first row |

The refusal names the other node(s) by **alias** only, with the fix and the override. The fix: log each node in on its own (device auth works over SSH):

```bash
CODEX_HOME=<node-dir>/codex-home codex login --device-auth
```

`--allow-shared-codex-login` shares anyway and is **unsafe**: those nodes will log each other out. Use it only when you mean it.

Rules:

- **Only new sharing is refused.** A node whose `codex-home` already has an `auth.json` (an existing node) still starts; if it shares, start prints a warning (#1918), and `anet doctor` lists every group of nodes on one login.
- **The host login**: the first node to borrow `~/.codex` is allowed, with a note not to give that login to another node or run `codex` directly on this host at the same time; the second node is refused. anet cannot see whether you run `codex` on the host by hand — that part is on you.
- Identity is an 8-hex sha256 fingerprint of the refresh token, not the account id: two separate logins on one account do not affect each other and are not sharing. anet reads only the fingerprint files nodes publish under `~/.anet/codex-auth-fingerprints/` and in their node dirs — **never another node's `auth.json`** — and prints no token.
- A handed-over login also records its origin fingerprint (`.codex-auth-origin.json`): after the first node refreshes, its copy moves on while `~/.codex` still holds the spent token, and the next node is still stopped.
- API-key logins (no refresh token in `auth.json`) do not rotate and are not affected.

### Model login failure {#model-login}

When `model_auth` becomes `revoked` (refresh token revoked) or `expired` (login expired and could not refresh):

- The node stops taking work: when idle it reports `status=error` with a re-login note in `task`, and the Hub treats it as degraded (previous section).
- From Hub `0.9.0-preview.87`, the **node's owner** gets **one** notice titled 「节点登录失效」 (node login failed). It appears in the app in that node's conversation, with an unread badge. One notice per entry into the bad state; it re-arms only after the node reports `ok` again. After a Hub restart it is not repeated while the owner still has an unread notice of the same kind.
- Fix: on that machine, log in again **for this node's own** `CODEX_HOME`:

  ```bash
  CODEX_HOME=<node-dir>/codex-home codex login
  ```

  Do not copy another node's `auth.json`.
- Once logged in, the node notices that `auth.json` was rewritten after the failure, falls back to `unknown` and takes work again; the next successful model call reports `ok`. No node restart is needed.

## Lifecycle commands: `anet node codex …` (read-only checks land first)

> Don't want to remember the commands below? Run `anet node codex` with no arguments in the node's directory: it lists the nodes, lets you pick an action, prints the equivalent command and asks before running it. One-page version: [Codex node cheat sheet](/en/guide/codex-cheatsheet).

Restarting or resuming a co-presence node used to be a manual runbook (see [Manual safe restart](#safe-restart) below). Every check in it is becoming a deterministic CLI step: no LLM on the happy path, machine-readable receipts only. The first two commands are read-only:

```bash
anet node codex preflight <alias>          # read-only checks, exit 0 = PASS / exit 2 = FAIL
anet node codex verify    <alias> --json   # preflight + child-process environment + cross-node identity attestation; JSON for automation
```

### restart / start / resume: a deterministic state machine, zero LLM calls

```bash
anet node codex restart <alias> --probe-from <another local node>   # stop Bridge→TUI→App Server, relaunch, re-verify
anet node codex start   <alias> --probe-from <peer>                  # only when none of the three is alive; otherwise use restart
anet node codex resume  <alias> --thread <36-char thread id> --probe-from <peer>
```

Every step of `restart` runs in a fixed order with no reasoning: **preflight (before)** — any fail means no process is touched → read the **goal state** (unreadable or unknown schema = unknown → STOP) → stop in reverse dependency order **Bridge → TUI → App Server** (cut the task inlet first, let the TUI flush its rollout, release the port last) → wait for the rollout byte count to settle (large sessions flush slowly) → wait for the port to free (a holder is only sent a targeted TERM when it is verified to be this node's own leftover app-server; a foreign pid is a FAIL and is never touched) → hand over to the launcher, `anet node start --copresence --tui-first` (**App Server → port ready → exact-session TUI fully restored → Bridge**, so no task can land on a session the human cannot see yet) → **verify (after)**: every preflight item + child-process environment + rollout before/after comparison (same file, bytes may only grow) + goal file unchanged + hub back online + cross-node nonce attestation. A failed launch is rolled back once (relaunch with the original config); if that fails too the node stays stopped and the receipt records the step.

`--probe-from <peer>` (add `--probe-root <dir>` when the peer lives under another `.anet` root) makes another local node send the target a task carrying a random nonce through the hub; `identity_attested` passes only when the reply reaches the peer's inbox with the hub-attributed sender equal to the target alias. Without a peer (a single node) the item is `n/a`: it is shown as `-` in the summary, the verdict line says `(not applicable: identity_attested)`, and it does not block — a healthy single node gets PASS (exit 0). A peer that answers wrongly is still **FAIL**. When a run fails, `blocking:` lists only the checks that failed. `resume --thread` takes a full 36-character id only, and only writes it to the config when exactly one rollout for that id exists under this node's CODEX_HOME: no prefixes, no "latest" guessing.

`--json` prints the whole receipt (with `stoppedAt` / `rolledBack`) for the Dashboard health-check button.

### fork: inherit the history, renew everything else

If you want the settings without the history, use `anet node clone`; the two are compared, with how to delete a copy, in [Copying a node (clone / fork) and cleaning up](/en/guide/copy-node).

```bash
anet node codex fork <source> --name <target> --workdir <dir> --no-codex-login [--inherit-full-access] [--model <id>]   # <dir> is created when missing
CODEX_HOME=<dir>/.anet/nodes/<target>/codex-home codex login --device-auth   # the new node logs in on its own (#514)
cd <dir> && anet node codex start <target> --probe-from <source>      # first start = verify + nonce attestation
```

`fork` only reads the source node (its auth.json / config.toml and **that one** rollout) and builds a brand-new node under `<dir>/.anet/nodes/<target>/`: a new `node_id` and CommHub identity, a new `CODEX_HOME` (0700, auth.json 0600), a new thread id (UUIDv7), a new workdir and new tmux names; the port is assigned at first start. The rollout is **streamed and copied with every thread id rewritten** (fixed 36 characters, so the byte count is unchanged), never shared; the first line must be the source thread's `session_meta`, otherwise not a single byte is written. The source's `.anet-copresence.env` (its CommHub token), history, sqlite files and caches are never copied; full access is not inherited unless you pass `--inherit-full-access` and the source already has it.

**The login does not travel with a fork (#514).** The source is using its `auth.json`; copying it puts two nodes on one single-use refresh chain (see [One login per node](#one-login-per-node)). A fork without `--no-codex-login` is therefore refused (exit 1, before any Hub registration, leaving nothing behind); `--no-codex-login` copies no `auth.json` and the receipt's `home_isolated` says the node must log in before its first start; `--allow-shared-codex-login` copies it as before and is unsafe.

The receipt's `fork_isolation` requires identity / HOME / thread / rollout file / tmux names to all differ, a byte-equal rollout copy and no token file in the target HOME; `identity_attested` stays unknown at fork time (non-blocking) and is closed by the first `start --probe-from`. `start` / `restart` / `resume` must be run from the directory recorded in `config.codexProjectDir`, otherwise they refuse (the three tmux sessions' cwd and `.anet/nodes` are both relative to the current directory).

`fork` also does the chores operators used to do by hand (#1951), all recorded in the receipt's `fork_options` check: a missing `--workdir` is created; the copied `config.toml`'s `[projects."<source workspace>"]` table header is rewritten to `<dir>` (header only, every other line stays byte-identical; if a target table already exists the source table is dropped rather than duplicated); `--model <id>` goes into the target config, with a warning when the source rollout's last `turn_context` ran a different model (provider blocks are kept — app-server refuses to load if one is missing); a free loopback port is probed at fork time and written to the config, first `start` prefers it and re-probes if taken; `CODEX_HOME/AGENTS.md` rides along.

### Account migration: `account install` and `rollback`

```bash
CODEX_HOME=/some/home codex login                                   # a human logs in once (ChatGPT) in any HOME
anet node codex account register team-a --from-codex-home /some/home  # register it in the host-bound local registry
anet node codex account list
anet node codex account install <alias> --source codex-login:team-a --probe-from <peer>
anet node codex rollback <alias> --receipt <install-receipt-id> --probe-from <peer>
```

The login source is an **opaque reference** only, `codex-login:<profile-id>`: the CLI accepts no paths, stdin or environment variables. Profiles resolve through the local `~/.anet/codex-login/registry.json` (0600); the credential itself lives in `profiles/<id>/auth.json` (0600); each entry is bound to a `host_id` (a digest of machine-id + hostname), so a copied registry is refused elsewhere. PR-D handles ChatGPT logins only (`auth_mode=chatgpt`). Receipts, the registry and logs carry only the `profile_id`, an irreversible `account_fingerprint` (first 16 hex of sha256(account_id)) and the `backup_ref` — never tokens, auth contents or real paths.

`install` is a deterministic state machine: target preflight (any fail stops) → a **fresh model request** from an isolated temporary HOME with that profile (`codex exec`, fixed reply; 401 / invalid credentials → auth, quota / 429 → quota, incompatible model → model, anything unclassifiable → unknown — all four STOP with the target untouched, and the probe result is written back to the registry) → back up the target's auth.json under `receipt:<id>` (0600) → atomic 0600 install → **full restart** (the PR-B machine, including verify and nonce attestation) → the target's fingerprint must equal the source's. Any failure after the install restores the backup and restarts once more; the receipt records both halves.

`rollback` accepts only the `backup_ref` recorded in the original install receipt, never a caller-supplied file: restore → full restart → fingerprint back to the receipt's `targetPreviousFingerprint`.

### Canary before any batch

```bash
anet node codex canary nodeA nodeB nodeC --probe-from <peer>     # verify one by one, stop at the first FAIL
```

Before restarting or re-logging a batch of co-presence nodes, run `canary`: the list is validated as a whole first (a typo or a non-codex node refuses the whole run before anything happens), then each node is **verified in order** (with nonce attestation when `--probe-from` is given); the first FAIL stops the run, the remaining nodes are never touched and are listed as "not run". Every node keeps its own verify receipt; `--json` prints the summary (`ran` / `skipped` / `stoppedAt`). Exit 0 means every node passed.

What `preflight` checks (each pass / fail / unknown; **anything but pass fails the whole receipt** — no partial success): the alias maps exactly to the `node_id` the hub roster holds; the node's own `CODEX_HOME` is 0700, `auth.json` 0600, and the CommHub token fingerprint matches; the working directory agrees across the config, the TUI process cwd, the TUI `-C` argument and the Bridge process; `codexThreadId` is a full 36-character id with exactly one rollout in that `CODEX_HOME` (absolute path, inode, bytes and mtime are recorded; prefixes or "the newest file" are refused); the app-server port is held by this node's own process (anything else is a foreign PID and is never touched); all three tmux segments (app-server / TUI / bridge) are running and their child processes carry this node's identity marker.

Receipts are written to `.anet/nodes/<id>/receipts/<id>.json` (0600): credentials appear only as irreversible short fingerprints, never in receipts, logs or arguments. Until the cross-node nonce probe lands, `verify` reports `identity_attested` as unknown and therefore always FAILs — by design. start / restart / resume / fork / account / rollback follow in batches; the contract lives in repository issue #1856.

## Permissions: read-only by default, explicit double opt-in for full access

Co-presence defaults to `sandbox_mode=read-only` with on-request approvals. If Codex must write files or use unrestricted command/network tools, opt in explicitly:

```bash
anet node start codex-human --copresence --dangerously-allow-full-access
```

- An interactive terminal requires you to type `yes`.
- A non-TTY script, CI job, or Docker caller must also pass `--yes-danger-full-access`:

```bash
anet node start codex-human --copresence \
  --dangerously-allow-full-access \
  --yes-danger-full-access
```

The second flag is only for non-interactive callers and cannot be omitted; it prevents piped input from bypassing confirmation. Full access disables the filesystem/network sandbox, so use it only in a trusted workspace with trusted tasks.

## A normal `codex-app-server` node is not co-presence

Without `--copresence`:

```bash
anet node create codex-worker --runtime codex-app-server
anet node start codex-worker
```

The node spawns a private app-server and a fresh thread. This is useful as a codex-backed background Agent, but there is no human-attachable TUI, so this path **is not co-presence**.

## Advanced adoption: manual shared WebSocket

For everyday native Windows use, run the one-command flow above. This section is only for adopting an existing app-server or debugging. Give **each node its own app-server and port; never share one across nodes**: the CommHub bearer token is app-server process state, so sharing mixes thread identities and creates a single point of failure.

```powershell
# Check that the chosen port is free; this is a placeholder
# Windows PowerShell:
Get-NetTCPConnection -LocalPort <free-port> -ErrorAction SilentlyContinue

# Terminal 1: enter the target project before starting the dedicated app-server
cd C:\path\to\project
$env:CODEX_HOME = "C:\path\to\project\.anet\nodes\codex-human\codex-home"
codex app-server --listen ws://127.0.0.1:<free-port>

# Terminal 2: start the bridge first so it creates/captures a thread
# and writes codexThreadId to the node config
Get-ChildItem Env:COMMHUB_* | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$env:CODEX_HOME = "C:\path\to\project\.anet\nodes\codex-human\codex-home"
anet node create codex-human --runtime codex-app-server --codex-app-server-url ws://127.0.0.1:<free-port>
anet node start codex-human

# Read codexThreadId/model from config.json, then attach Terminal 3 to that
# exact thread while using this node's CODEX_HOME
$env:CODEX_HOME = "C:\path\to\project\.anet\nodes\codex-human\codex-home"
codex resume --remote ws://127.0.0.1:<free-port> <codexThreadId> -m <model>
```

`codex resume --remote` must align all four values: the node-isolated `CODEX_HOME`, `codexAppServerUrl`, `codexThreadId`, and `model`. Omitting the thread id opens a historical-session picker. Omitting `CODEX_HOME` is more deceptive: Codex can use the default `~/.codex` and silently connect to external port 443, leaving an empty pane that looks successfully attached while it is actually an independent cloud session. When the bridge first writes `codexThreadId`, it prints copyable POSIX and PowerShell resume commands. You may also pass `--codex-thread-id <id>` when creating the node to adopt a specific thread; otherwise the runtime captures one and writes it back.

Do not treat an empty pane as proof. After manual startup, inspect the TUI process socket and verify it connects to the configured loopback `codexAppServerUrl` rather than external `:443`, then verify the same thread id from both the TUI and bridge sides. Linux/macOS also must run `export CODEX_HOME='<node-directory>/codex-home'` before `codex resume` with `--remote`, the thread id, and `-m`.

All three terminals in a manual topology must also set the **same node-specific `CODEX_HOME`** explicitly. If any terminal omits it, Codex can silently fall back to the user's default `~/.codex`: the TUI appears to start but belongs to a different cloud session instead of this loopback app-server. Do not share a persistent node's `CODEX_HOME` with the primary Codex session.

Advanced Linux/macOS users can also use this topology with an existing app-server, but prefer `--copresence` for everyday use because it manages loopback binding, isolated `CODEX_HOME`, MCP injection, tmux lifecycle, and stop identity together. If common ports such as 24700–24720 are occupied by other co-presence nodes, choose another free loopback port and check it before starting.

Concretely, "inspect the TUI process socket" means this, and the criterion is the **number of connection pairs**:

```bash
ss -tnp | grep '127.0.0.1:<app-server-port>'
```

A healthy attach shows **two** ESTAB pairs — one for the bridge, one for the TUI. **Only one pair means the TUI did not attach**, and the pane looks identical either way. Measured 2026-08-26 on Linux: a TUI started without `CODEX_HOME` had exactly one TCP connection from its codex child, and it went to public `:443`.

The app-server **accepts multiple clients**, so the TUI can join the same thread while the bridge is connected. **There is no need to stop the bridge first** (measured on the same host: the bridge kept its 6-second round trip after a new TUI attached).

A manually started app-server does not automatically get the CommHub MCP injection supplied by `--copresence`. If the human TUI needs direct `commhub_*` tools, configure the RFC-030 MCP URL and bearer-token environment variable **before the app-server creates the thread**. Existing threads snapshot their tool set, so adding MCP later does not work. Never put the token in argv or chat.

::: warning Codex CLI update prompt
The TUI may show `Update available` with upgrade-now selected by default. On a shared host, choose skip/later and schedule Codex CLI upgrades for a maintenance window; replacing the global binary may affect every co-presence node on that machine.
:::

## Manual safe restart (without `anet node codex restart`) {#safe-restart}

Prefer `anet node codex restart` above: it checks every item below automatically. Use this checklist only when you cannot (older versions, hand-built topologies). The goal is not "the processes came back" but that **the same node identity, the same thread, the same working directory and the same main rollout** are restored. If any item disagrees, stop, fix it, and redo the whole acceptance check.

### 1. Record the current state per node

| Item | Why |
|---|---|
| alias, node_id, the node's own `CODEX_HOME` | to verify identity afterwards |
| expected working directory (absolute path) | TUI `-C`, bridge cwd and CommHub `project_dir` must all match it |
| full 36-character thread ID | recovery must be exact; no prefixes |
| main rollout absolute path + byte size | must not shrink or be replaced after the restart |
| goal state (active / paused) | must be kept as it was |
| real child-process command lines of app-server / TUI / bridge | restart them as they were; look at the children, not the launcher or tmux name |

Back up the node's `auth.json` first and `chmod 0600` it. Credentials, `ntok_` and `atok_` never go into argv, logs, receipts or screenshots.

### 2. Stop in order, start in reverse

- Stop: **bridge → TUI → app-server** (preferably `anet node stop <alias>` run from outside the co-presence process tree). Then check there are no orphan processes or listening ports and the old bridge is no longer connected to the Hub.
- Start: **app-server → TUI → bridge**. Both app-server and TUI use the node's own `CODEX_HOME`; the TUI resumes with the full thread ID and an explicit working directory:

```bash
codex resume --remote <app-server-url> <full-thread-id> -C <node-cwd> -m <model>
```

`cd` into the node's working directory before starting the bridge. Never use a short prefix, "the most recent session" or the interactive picker.

### 3. Acceptance: everything must pass

- [ ] **Identity**: `from_name` / `from_node_id` on the Hub match the target node (verify with a side-effect-free fixed-phrase probe, not a real task)
- [ ] **Session**: the full thread ID matches the record
- [ ] **Rollout**: same absolute path, byte size ≥ before, content not replaced by a new thread
- [ ] **Working directory**: TUI `-C` == bridge cwd == CommHub `project_dir` == node config
- [ ] **Goal**: active goals continue, paused goals stay paused, nothing resumed by accident
- [ ] **Processes**: all three are up, the Hub shows online / idle, no duplicate old instance
- [ ] **Credentials**: `auth.json` is `0600`; no secret in argv, logs or receipts

"All three processes are up" is one item, not the verdict. For a batch, canary one node first, then continue one by one.

## Long tasks and the 600-second message

Only one turn can be active in a thread; later network tasks queue FIFO. The current network-task wait for a final answer **defaults** to 600 seconds (runtime options can override it; it is not an immutable hard cap):

- “No final reply within 600s” **does not prove the node is dead** and does not cancel the Codex turn already running.
- Do not immediately dispatch the same task again. First inspect `tmux capture-pane -t =codex-human -p | tail -30` and whether the workspace is still changing.
- Break code-heavy or tool-heavy work into steps that can report within ten minutes. If the turn is genuinely stuck, follow the [codex-app-server jam diagnosis and restart SOP](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/codex-app-server-jam-restart.md): preserve work before restarting.

## Security and known limits

- The app-server binds to `127.0.0.1`; tokens and secrets must not enter argv, git, or chat.
- A thread has one active turn at a time. “Concurrent communication” means multiple producers can enqueue work, not that turns execute in parallel.
- In the default mode the bridge never answers approvals; approval-requiring turns wait for the human TUI. Full access is the explicit high-risk exception.
- Phase 0A still connects the TUI and bridge as direct clients. The production single-upstream Policy Gateway, mandatory arbitration, and minimal control plane are not implemented yet.

## References

- [RFC-030 Codex TUI Bridge](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)
- [Node runtimes](/en/guide/runtimes)
- [CLI: `anet node start`](/en/guide/cli#anet-node-start)
- [Grok nodes](/en/guide/grok)
