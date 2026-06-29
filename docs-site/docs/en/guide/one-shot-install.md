# One-Shot Install (Multi-Agent + tmux)

::: warning ⚠️ Experimental — not end-to-end verified, audit before use
**Vincent feedback (2026-06-29)**: `setup-anet.sh` has **not been end-to-end verified by the maintainers**. The script file is reachable at `https://anet.sh/setup-anet.sh` (and syntactically complete), but there is no reproducible smoke report of it running through on a clean Ubuntu/Debian host. The `MINIMAX_KEY=sk-cp-your-key` vendor-key form may also not match MiniMax's current API — use the verified-with-real-call vendors listed in [Multi-Model Config](/en/guide/multi-model).

**Recommended path**: follow the [Getting Started guide](/en/guide/getting-started) (verified 5-terminal manual flow) + [Fresh Server From Scratch](/en/deploy/clean-server) (includes a systemd template).

The contents below are **kept for script-author reference**, but please audit and dry-run in an isolated environment before using.
:::

If you want to spin up a complete Agent Network (hub + dashboard + multiple agents, each in its own tmux session) on a fresh Ubuntu/Debian server with **a single command**, use `setup-anet.sh`.

## When to use this

- ✅ Deploying the full stack to a cloud server (Aliyun / AWS / DigitalOcean)
- ✅ Demoing multi-agent coordination to a team
- ✅ Local LAN testing across multiple machines

## Prerequisites

The script auto-installs anything missing from the list below:

- `nodejs ≥ 22.13.0` (`@sleep2agi/agent-network` `engines.node`)
- `npm`
- `tmux`
- `bun` (required by commhub-server)
- `unzip`, `curl`, `ca-certificates`

If you're currently `root`, the script will **auto-create a non-root user `anet`** (Claude Code refuses to use `--dangerously-skip-permissions` as root, so a non-root user is required).

## Single command

```bash
curl -fsSL https://anet.sh/setup-anet.sh \
  | MINIMAX_KEY=sk-cp-your-key bash
```

Or save locally and run:

```bash
curl -fsSL https://anet.sh/setup-anet.sh \
  -o setup-anet.sh
chmod +x setup-anet.sh
MINIMAX_KEY=sk-cp-your-key ./setup-anet.sh
```

## Customization

| Env var | Default | Purpose |
|---|---|---|
| `MINIMAX_KEY` | (required) | MiniMax API key (`ANTHROPIC_AUTH_TOKEN`) |
| `MINIMAX_MODEL` | `MiniMax-M2.7` | Which MiniMax model ID to use |
| `ANET_HUB_IP` | `0.0.0.0` | Hub + Dashboard bind address (0.0.0.0 = LAN accessible; change to `127.0.0.1` for loopback only) |
| `ANET_USER` | `anet` | Non-root username (auto-created by the script) |
| `WIPE` | `0` | Set to `1` to wipe all state before starting (tmux sessions / `~/.anet` / `~/.commhub` / npx cache). Handy when debugging |

```bash
# Custom node list (default: 5 nodes — publisher / editor-in-chief / scout / editor / reviewer)
MINIMAX_KEY=sk-cp-xxx ./setup-anet.sh nodeA nodeB nodeC

# Pick a MiniMax model
MINIMAX_KEY=sk-cp-xxx MINIMAX_MODEL=MiniMax-M2 ./setup-anet.sh

# Change hub bind address
MINIMAX_KEY=sk-cp-xxx ANET_HUB_IP=127.0.0.1 ./setup-anet.sh

# Change non-root username
MINIMAX_KEY=sk-cp-xxx ANET_USER=worker ./setup-anet.sh

# Full wipe and reinstall (kills tmux + clears ~/.anet / ~/.commhub + npx cache, then reinstalls)
MINIMAX_KEY=sk-cp-xxx WIPE=1 ./setup-anet.sh
```

## Available MiniMax models

| Model ID | Notes |
|---|---|
| `MiniMax-M2.7` | `setup-anet.sh` default fallback (check MiniMax docs for the current latest model id) |
| `MiniMax-M2.7-highspeed` | High-speed variant |
| `MiniMax-M2.5` | |
| `MiniMax-M2.5-highspeed` | |
| `MiniMax-M2.1` | |
| `MiniMax-M2.1-highspeed` | |
| `MiniMax-M2` | Legacy |

See the [MiniMax official docs](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api).

## After it finishes

Each process runs in its own tmux session:

```bash
tmux ls
# anet-hub: 1 windows ...
# anet-dashboard: 1 windows ...
# anet-node-publisher: 1 windows ...
# anet-node-editor-in-chief: 1 windows ...
# ...
```

Operations:

```bash
# Attach to a specific process to view its output
tmux a -t anet-hub
tmux a -t anet-dashboard
tmux a -t anet-node-editor-in-chief

# Detach (leaves it running): Ctrl-b then d

# Stop one node
tmux kill-session -t anet-node-editor

# Stop the whole network
tmux ls | awk -F: '/^anet-/{print $1}' | xargs -I{} tmux kill-session -t {}
```

Default ports:

| Service | Port | tmux session |
|---|---|---|
| CommHub Server | `9200` | `anet-hub` |
| Dashboard | `3000` | `anet-dashboard` |
| Agent Node | in-process `stdio` (no network port) | `anet-node-<alias>` |

Open a browser at:

```
http://your-server-ip:3000
```

Log in with `admin / anethub`. All nodes show up on the Nodes page; click any node to dispatch a task. **Run `anet passwd` to set a strong password right away** (see [troubleshooting → password strength](/en/troubleshooting)).

## Verified

- End-to-end tested in a fresh `ubuntu:22.04` Docker container: full stack up in ~70-90s (dependency install + package download + 5 agents started)
- Hub healthy + Dashboard 200 + all agents registered idle
- With a real MiniMax key, agents can dispatch tasks to each other via the commhub MCP tools and integrate the replies

## Known limitations (unverified)

- Only verified on Ubuntu 22.04 / 24.04; the `apt-get` commands need substitution for CentOS / RHEL.
- Bun is installed via `curl bun.sh/install`, which requires Internet access; pre-install Bun in air-gapped environments.
- If `MINIMAX_KEY` or the model ID is wrong, the script will finish successfully but agents will return failed when handling tasks — check the `[stderr]` lines via `tmux a -t anet-node-<alias>`.
