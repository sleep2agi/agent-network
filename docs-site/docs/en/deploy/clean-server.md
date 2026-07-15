# Deploy to a Fresh Server From Scratch

::: tip Who is this page for?
You just got hold of a **brand-new Ubuntu / Debian server** (cloud VM, local VM, internal box — all fine) and want to bring up anet hub + a node or two + Telegram from zero, end-to-end.

This page follows a maintainer-verified fresh-machine setup path: every step has a verify command + a common-error lookup ([troubleshooting table](#troubleshooting-table-8-坑-mapping)).

It is **not** for users who already have anet installed — that's [Getting Started](/en/guide/getting-started) or [Upgrade Guide](/en/guide/upgrade).
:::

## 0. Prerequisites

| Dependency | Recommended | How to install |
|---|---|---|
| **Node.js** | ≥ 22.13.0 | [nvm](https://github.com/nvm-sh/nvm) is the easiest: `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh \| bash` → `nvm install 22 && nvm use 22` |
| **Bun** | ≥ 1.2.0 | `npm i -g bun` or `curl -fsSL https://bun.sh/install \| bash` |

::: warning Bun is non-optional
`commhub-server` is Bun-shebang TypeScript (launched via `bunx --bun`). **Without Bun, `anet hub start` will hard-crash with `spawn bunx ENOENT`** — this is bug #1 from the fresh-server retro.

Verify:
```bash
node --version       # expect v22.x or newer
bun --version        # expect 1.2.x or newer
```

If either says `command not found` → install it before going further.
:::

::: details nvm-installed node disappears in non-interactive shells / other users
nvm only loads in an **interactive shell** (reads `~/.bashrc`). If you plan to launch nodes via systemd / cron / a different user, nvm's PATH is not applied automatically.

Fallback:
1. Symlink the nvm node bins into `/usr/local/bin`: `sudo ln -s "$(which node)" /usr/local/bin/node && sudo ln -s "$(which npm)" /usr/local/bin/npm`
2. Or in your systemd unit / launch script, explicitly `source ~/.nvm/nvm.sh`

Bun is similar — it installs per user (`~/.bun/bin`); confirm PATH before switching users / running as root.
:::

## 1. Install the anet CLI

A single global package:

```bash
npm i -g @sleep2agi/agent-network
```

Verify:

```bash
anet -v
```

Expected output (version numbers track npm `latest`):

```text
anet <current latest>
Components (auto-fetched on first use, you don't need to install them manually):
  ✓ agent-node <current latest>
    └ @anthropic-ai/claude-agent-sdk v0.2.x
    └ @openai/codex-sdk v0.x.x
  ○ commhub-server — not installed yet (will fetch via npx on first use)

Optional runtimes (install only what you'll use):
  ✓ claude CLI v2.1.x        # installed + auth login completed
  ✓ codex CLI v0.x.x         # installed + auth login completed
  ...                        # runtimes you didn't install are simply not listed (see §5)

Nothing is broken — components are fetched the first time you run:
  anet hub start          # bootstraps commhub-server
  anet node start <name>  # bootstraps agent-node

Docs: https://anet.sh/guide/getting-started
```

`anet -v` automatically tells you whether `agent-node` is installed, whether `commhub-server` has been fetched, and whether the optional `claude` / `codex` CLIs are present. This is the **first place to look** whenever anything later breaks.

## 2. Start the Hub (recommended: under tmux)

CommHub is a long-running process — **closing the terminal stops it**. For production you'd configure systemd ([§7 Persistence](#_7-persistence-systemd-tmux)); for a quick verify, use tmux:

```bash
# Install tmux (if not present)
sudo apt install tmux -y    # Ubuntu / Debian

# Start a tmux session named anet-hub
tmux new -s anet-hub
anet hub start --host 0.0.0.0 --port 9200

# Look for output like this — that's success:
# CommHub MCP Server <current latest>
# REST:   http://0.0.0.0:9200/api
# ✅ Admin account created
# username: admin
# password: anethub
```

Press `Ctrl+B` then `D` to **detach the tmux session while keeping it alive**. Come back with `tmux a -t anet-hub`.

Verify the hub is up (from another terminal):

```bash
curl -s http://127.0.0.1:9200/health | head -5
# Expect something like {"ok":true,"version":"<current>",...}
```

::: danger Public-internet deploy: change the password immediately
The default `admin / anethub` is for local quick-start only. **Any `--host 0.0.0.0` public-internet deploy must immediately**:

```bash
anet login --username admin --password anethub --hub http://127.0.0.1:9200
anet passwd          # Interactive password change (≥ 8 chars, not in the weak-password dict)
```

Or set credentials when starting the hub: `anet hub start --host 0.0.0.0 --username <your-admin> --password '<strong-pass>'`.
:::

::: details Port already in use? Change ports or stop the old hub
```bash
# Who's listening on the port
ss -tlnp | grep 9200

# Change to a different port
anet hub start --port 9201

# Or gracefully stop the old hub (preferred)
anet hub stop                  # default port 9200, SIGTERM → 3s grace → SIGKILL fallback
anet hub stop --port 9201      # non-default port
anet hub status                # show current PID / port / commhub-server version

# Fallback if the above somehow doesn't work
HUB_PID=$(ss -tlnp | grep ':9200' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
kill "$HUB_PID"
# Or if your hub runs under tmux, attach and Ctrl+C
tmux a -t anet-hub             # Then Ctrl+C to stop, Ctrl+B D to keep the tmux session
```

::: tip `anet hub --help` doesn't list stop/status yet?
`anet hub --help` now lists the `stop` / `status` subcommands (2.2.12 had a display bug that omitted them, fixed in [#240](https://github.com/sleep2agi/agent-network/issues/240) / [PR #241](https://github.com/sleep2agi/agent-network/pull/241), shipped in current latest); the commands themselves have always worked — running `anet hub status` returns `hub running / vX.Y.Z / pid N`.
:::
:::

## 3. CLI Login

Open a third terminal (leave the hub's tmux alone):

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
```

After login, the token lives at `~/.anet/config.json` and is auto-attached to every subsequent `anet node ...` command.

```bash
anet whoami          # Confirm your identity
```

## 4. Create an Agent Node (chosen by runtime)

```bash
anet node create my-bot
```

The wizard asks the following, in order:

```text
node-name → runtime → (only if claude-agent-sdk) vendor → model → API key / auth
```

**Runtime is the first fork — it's a 5-way pick that decides whether you'll be asked for a vendor and what dependencies you'll need** (npm package / default models / detailed wizard behavior: see [runtimes — canonical table](/en/guide/runtimes#five-runtimes-—-canonical-table)):

| Runtime | Complexity | Best for | Wizard follow-up | Extra dependencies |
|---|---|---|---|---|
| **`claude-code-cli`** (recommended for first-time users) | ⭐ | You already use Claude Code, want to reuse the subscription | Skips vendor + model, uses your local `claude` login | `claude auth login` already done |
| `claude-agent-sdk` | ⭐⭐ | Programmatic access to any Anthropic-compatible API (MiniMax / 书生 / 小米 MiMo / domestic models go here) | **Pops a vendor submenu** → pick vendor → pick model → enter API key | API key |
| `codex-sdk` | ⭐⭐⭐ | Writing code / running commands via OpenAI Codex | Skips vendor, uses codex's own auth | agent-node + codex CLI + `codex login` |
| `grok-build-acp` | ⭐⭐⭐ | Running tasks via xAI Grok Build | Skips vendor, uses grok's own auth + `GROK_CODE_XAI_API_KEY` | grok CLI + `grok login` + `GROK_CODE_XAI_API_KEY` |
| `opencode-cli` **(preview)** | ⭐⭐⭐ | Use the public sst/opencode CLI as a multi-vendor front-end (**preview channel only, not in latest**) | Pick a vendor preset (anthropic / openai), key read from env | `opencode` CLI + Anthropic/OpenAI env key |

::: warning Watch out for the default runtime
The wizard **defaults the first option** (currently `claude-agent-sdk`); a new user pressing Enter all the way lands on the vendor + API-key path. **Manually pick `claude-code-cli`** for the smoothest first-time experience ([#237 坑 3](https://github.com/sleep2agi/agent-network/issues/237), known UX pain — the wizard default will change later).
:::

::: warning The wizard does **not** ask about Telegram
Once the steps above finish, the wizard **ends** — it **never asks for a Telegram bot token / allow-list UID**. Telegram is attached after node creation via a separate command, `anet channel add telegram` (see [§6](#_6-configure-the-telegram-channel-optional)).

If you see the line "optional Telegram channel" at the top of `anet create`'s output, don't be misled into thinking the wizard will configure it for you — it won't ([#237 坑 4](https://github.com/sleep2agi/agent-network/issues/237), known docs/CLI inconsistency).
:::

After completion, the node config is written under cwd:

```text
.anet/nodes/my-bot/config.json
```

Verify:

```bash
anet node ls         # should list my-bot
```

## 5. (codex-sdk only) Install agent-node + codex CLI

If you picked **`codex-sdk`** or **`claude-agent-sdk`** above, the node needs the `@sleep2agi/agent-node` package to run. The design is "lazy fetch via npx on first use", but in practice the lazy fetch can be skipped and not actually pull → the node fails on start with `agent-node is not installed or cannot report a version. Run: anet upgrade` ([#237 坑 5](https://github.com/sleep2agi/agent-network/issues/237)).

The reliable fallback: **install it once manually**:

```bash
npm i -g @sleep2agi/agent-node

# Verify
agent-node --version    # expect current latest or newer
```

The `codex-sdk` runtime additionally needs the codex CLI installed + logged in:

```bash
# Note: this is @openai/codex (the CLI tool), distinct from @openai/codex-sdk (the SDK library that the codex-sdk runtime depends on) — two separate npm packages
npm i -g @openai/codex
codex login        # Browser OAuth

# Verify
codex --version
```

The `claude-agent-sdk` runtime does NOT need either codex / claude CLI — as long as your node config carries the right vendor's API key (or the matching env vars `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`), you're good.

## 6. Configure the Telegram channel (optional)

If you want to dispatch tasks to the agent from Telegram:

### 6.1 Get a bot token + your Telegram user ID

1. In Telegram, search **@BotFather** → `/newbot` → follow the prompts; the last reply contains your `bot-token` (looks like `1234567:ABCDef...`)
2. Get your Telegram user ID (a number): message **@userinfobot** anything; it replies with your UID

### 6.2 Attach the Telegram channel to the node

```bash
anet channel add telegram my-bot \
  --bot-token <bot-token> \
  --allow <uid>
```

Parameters:
- `<bot-token>`: the string BotFather gave you
- `<uid>`: the Telegram user ID(s) allowed to dispatch tasks to this bot (comma-separate multiples: `--allow 11111,22222`)

Verify it landed:

```bash
anet channel ls
# Should list: my-bot (my-bot) telegram     allow: <uid>
```

::: tip Want to add more allowed users?
`anet channel add telegram <node> --allow <new-uid-list>` **overwrites** the allowlist, it doesn't append. To keep existing entries, repeat the full list (`--allow 11111,22222,33333`). Known gap ([guide/channels.md](/en/guide/channels#known-gaps-and-pitfalls)), append behavior will land later.
:::

## 7. Start the Node

```bash
# Recommended: tmux (same as the hub — avoids stopping when the terminal closes)
tmux new -s anet-my-bot
anet node start my-bot
```

::: warning claude-code-cli first launch pops the "dev-channels" confirmation prompt
On its first launch, a `claude-code-cli` node will pop Claude Code's `--dangerously-load-development-channels` confirmation prompt:

```text
❯ 1. I am using this for local development
  2. Exit
```

**Press 1 + Enter**. In scripted / detached launches **nobody's there to answer**, so the node hangs and stays offline ([#237 坑 6](https://github.com/sleep2agi/agent-network/issues/237), known).

Workaround: run it once in a foreground tmux and answer the prompt manually; subsequent launches don't pop it (the answer is session-scoped). You can then layer systemd on top.
:::

When you see `SSE connected`, the node is online — back on the hub side, `anet status` should list `my-bot` as online.

`Ctrl+B D` to detach the tmux session.

## 7. Persistence (systemd / tmux)

anet does not ship an official `--daemon` flag today. Two options below: tmux for quick / dev use, systemd units for production / autostart.

### 7.1 tmux (dev / quick verify)

A machine reboot drops everything — you re-attach by hand:

- hub: `tmux new -s anet-hub` + `anet hub start --host 0.0.0.0`
- each node: `tmux new -s anet-<alias>` + `anet node start <alias>`
- An `@reboot` crontab line can replace the manual step, but you'll need to solve the non-interactive-shell PATH / nvm problem first (see [§0 nvm caveat](#_0-prerequisites))

### 7.2 systemd units (production / autostart)

The unit files below are **not officially tested** — swap in your real `node` binary path (from `which anet`) and the user you run anet under, then `systemctl daemon-reload` + `enable --now`.

**Hub** `/etc/systemd/system/anet-hub.service`:

```ini
[Unit]
Description=Agent Network Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser
# Replace with the absolute path from `which anet` ↓
ExecStart=/home/youruser/.nvm/versions/node/v22.13.0/bin/anet hub start --host 0.0.0.0 --port 9200
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

**Node** (templated — one unit runs N nodes) `/etc/systemd/system/anet-node@.service`:

```ini
[Unit]
Description=Agent Network Node %i
After=anet-hub.service
Requires=anet-hub.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser
ExecStart=/home/youruser/.nvm/versions/node/v22.13.0/bin/anet node start %i
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now anet-hub
sudo systemctl enable --now anet-node@my-bot
sudo systemctl status anet-hub anet-node@my-bot
```

**Gotchas**:

- `ExecStart` must be the **absolute path** to `anet` (`which anet`); systemd does not read nvm's `~/.bashrc`
- `User=` should be the everyday user that owns the anet install; **don't use root**
- The `claude-code-cli` runtime pops a dev-channels confirmation on first run ([see the dev-channels prompt in §7 Start the Node](#_7-start-the-node)); answer it once under a foreground tmux before handing off to systemd
- Want an official unit / improvements to the template above? PRs welcome, or open a thread on [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions)

## Troubleshooting table (8 坑 mapping)

In the order they hit you on a real fresh machine — **symptom → cause → fix**:

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | `anet hub start` → `spawn bunx ENOENT` + node-stack crash | Bun not installed; commhub-server is Bun-shebang TS | `npm i -g bun` or `curl -fsSL https://bun.sh/install \| bash`; afterwards `bun --version` should produce output. **[#235](https://github.com/sleep2agi/agent-network/issues/235)** tracks adding a preflight + friendly message |
| 2 | `anet node create` → after picking runtime → `FATAL: TypeError: fetch failed` | Node creation needs to register with the local hub, but hub isn't up (usually because of bug #1) | Open another terminal, `anet hub start`, then retry. **[#237](https://github.com/sleep2agi/agent-network/issues/237)** main thread tracks classified fetch errors |
| 3 | Pressing Enter through the wizard lands you on the vendor + API-key path | Runtime menu defaults to `claude-agent-sdk`, not the simpler `claude-code-cli` | **Manually pick `claude-code-cli`** when creating the node (with `claude auth login` already done, it reuses the subscription directly). If a Ctrl-C during vendor selection left a half-baked node behind, clean up with `anet node delete <alias>` and retry |
| 4 | Telegram doesn't work after node creation, even though the wizard mentioned "optional Telegram channel" | The wizard never actually asks about Telegram — that line is misleading copy | Use `anet channel add telegram <node> --bot-token <tok> --allow <uid>` separately to attach it (see [§6](#_6-configure-the-telegram-channel-optional)) |
| 5 | `anet node start` (codex-sdk / claude-agent-sdk) → `agent-node is not installed or cannot report a version` | npx lazy-load didn't actually pull `@sleep2agi/agent-node` | `npm i -g @sleep2agi/agent-node`; then `agent-node --version` should produce output |
| 6 | `claude-code-cli` node starts but stays offline / pane is stuck on the confirmation prompt | Claude Code's `--dangerously-load-development-channels` prompt is waiting for an Enter | Run it once in foreground tmux and press `1` + Enter; subsequent launches don't pop it |
| 7 | systemd / cron / a different user launch produces a string of `command not found` errors | nvm + Bun each install per user; non-interactive shells don't load them | Symlink node/npm/bun into `/usr/local/bin/`, or have the launch script explicitly `source ~/.nvm/nvm.sh` |
| 8 | Machine reboot drops everything | Hub + nodes all rely on manual tmux sessions | Configure autostart via systemd — see the template in [§7.2 systemd units](#_7-2-systemd-units-production-autostart) |

---

## Next

- [Getting Started](/en/guide/getting-started) — end-to-end walkthrough for an already-installed laptop setup
- [One-shot install](/en/guide/one-shot-install) — `setup-anet.sh` brings up hub + dashboard + multi-agent in one shot
- [Production / public-internet deployment](/en/deploy/production) — TLS / firewall / backup / public-internet risk surface
- [Channel integration](/en/guide/channels) — full Telegram / WeChat / Feishu integration manual
- [Node runtime](/en/guide/runtimes) — detailed comparison of the five runtimes

If you hit a bug not covered here, please open a [GitHub issue](https://github.com/sleep2agi/agent-network/issues) — include which step failed, the exact error, and the `anet -v` output.
