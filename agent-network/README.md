# @sleep2agi/agent-network

`anet` — a single CLI to run a local AI Agent network. Launch the hub, the dashboard, and as many agent nodes as you want. Verified end-to-end on macOS / Linux / Docker via Playwright.

**v2.0.0 stable.** Pairs with `@sleep2agi/commhub-server` 0.5.0, `@sleep2agi/agent-network-dashboard` 0.1.0, `@sleep2agi/agent-node` 2.1.1. Everything below in the **Verified flow** section has E2E coverage; everything in the **Not verified** section is best-effort.

## Install

```bash
npm install -g @sleep2agi/agent-network
anet -v
```

Node.js ≥ 20, npm ≥ 9. The hub and agent runtime are pulled on demand by `bunx` / `npx` — no other manual installs.

## Verified flow

Open three terminals.

```bash
# Terminal 1 — Hub
anet hub start
#   • http://127.0.0.1:9200
#   • SQLite at ~/.commhub/commhub.db
#   • Default admin account auto-created: admin / anethub
#   • Prints a LAN URL so other machines can join

# Terminal 2 — Dashboard
anet hub dashboard
#   • Open http://localhost:3000, log in with admin / anethub

# Terminal 3 — CLI: log in, create an agent, start it
anet login --username admin --password anethub
anet node create my-bot
#   Two-step picker:
#     1) runtime → claude-agent-sdk (recommended)
#     2) provider → MiniMax / DeepSeek / GLM / Kimi / Anthropic / OpenRouter / custom
#   Then enter the API key for that provider.
anet node start my-bot
#   Look for: SSE connected
```

Now go to the Dashboard, click `my-bot` in the Chat panel, type a message, hit Enter. The agent calls the LLM and replies with full markdown rendering.

### Multi-agent collaboration (verified)

```bash
anet node create video-bot --runtime claude-agent-sdk
anet node start video-bot
```

Ask `my-bot` something like *"ask video-bot what it can do"*. `my-bot` discovers `video-bot` via the commhub MCP `get_all_status` tool, dispatches the question with `send_task`, polls `get_task`, and integrates the reply. The Tasks and Messages pages show the full handshake.

### LAN-shared hub (verified)

`anet hub start` listens on `0.0.0.0`. From another machine on the same network:

```bash
npm install -g @sleep2agi/agent-network
anet init --hub http://<HUB-LAN-IP>:9200
anet login --username admin --password anethub
anet node create remote-bot
anet node start remote-bot
```

## Provider presets

`anet node create` second step picks a provider preset. Each preset writes the right `ANTHROPIC_BASE_URL` and a sensible default model into `.anet/nodes/<name>/config.json`, then prompts for the API key.

| Provider | Status | Notes |
|---|---|---|
| Anthropic | verified | `sk-ant-...`, default `claude-sonnet-4-5` |
| MiniMax (国内 / 国际) | verified | `sk-cp-...` |
| DeepSeek | verified | `sk-...` |
| GLM (智谱) | verified | open.bigmodel.cn key |
| Kimi (Moonshot) | verified | platform.moonshot.cn key |
| OpenRouter | unverified end-to-end | `sk-or-...` works in dev, no full E2E run |
| Custom Anthropic-compatible | unverified end-to-end | provide base URL + token manually |

`claude-agent-sdk` is just an Anthropic Messages API client — any compatible endpoint works without code changes; `--model` is passed through.

## Command reference

```bash
# Hub + Dashboard
anet hub start                     # local CommHub + auto admin/anethub  [verified]
anet hub stop                      # stop the local hub                  [verified]
anet hub dashboard                 # launch the Web Dashboard            [verified]

# Auth
anet register                      # create an account                   [verified]
anet login [--username ...]        # login, saves token to ~/.anet/config.json  [verified]
anet logout                                                              # [verified]
anet whoami                                                              # [verified]
anet passwd                        # change password                     [verified]

# Tokens
anet token create <name>                                                 # [verified]
anet token ls                                                            # [verified]
anet token revoke <id>                                                   # [verified]

# Nodes
anet node create <name>            # two-step interactive picker         [verified]
anet node start <name>             # connect via SSE, await tasks        [verified]
anet node stop <name>                                                    # [verified]
anet node delete <name>                                                  # [verified]
anet node ls                                                             # [verified]
anet logs <name>                   # tail the node's log file            [verified]

# Status
anet status                        # network overview                    [verified]
anet doctor                        # local sanity checks                 [verified]

# Setup helpers
anet init [--hub <url>]            # write ~/.anet/config.json (LAN setup) [verified]
anet init project                  # write .mcp.json + CLAUDE.md         [verified]
```

## Not verified

Listed for transparency — these commands exist but are not part of the supported v2.0.0 path.

- `anet quickstart` — removed from the docs; use `anet hub start` + `anet node create` instead.
- `anet license` / `anet activate` — placeholders for a future paid tier.
- `anet network create` / `anet network invite` / cross-user network sharing — code is in, no full E2E.
- `anet channel add telegram|wechat|feishu` — channels exist but are not E2E regressed in v2.0.0.

## Configuration files

```
~/.anet/config.json                     # global: hub URL + user token
{cwd}/.anet/nodes/<name>/config.json    # per-node: runtime, model, provider, API key
```

Field-level override: per-node config wins, missing fields fall back to global, then defaults.

A typical `config.json` after `anet node create`:

```json
{
  "alias": "my-bot",
  "hub": "http://127.0.0.1:9200",
  "runtime": "claude-agent-sdk",
  "model": "MiniMax-M2.7",
  "anthropic_base_url": "https://api.minimax.io/anthropic",
  "anthropic_auth_token": "sk-...",
  "tools": "all",
  "maxTurns": 50,
  "dangerouslySkipPermissions": true,
  "teammateMode": true
}
```

## Companion packages

| Package | Version | What it does |
|---|---|---|
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 0.5.0 | MCP + REST + SSE hub |
| [@sleep2agi/agent-network-dashboard](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | 0.1.0 | Web Dashboard |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | 2.1.1 | Agent runtime |

## Docs

- https://anet.vansin.me — full documentation site
- https://anet.vansin.me/guide/getting-started — verified local flow
- https://github.com/sleep2agi/agent-network — source

## License

MIT
