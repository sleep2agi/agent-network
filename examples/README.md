# Agent Network Examples

> For the full walkthrough, see [anet.sh/guide/getting-started](https://anet.sh/guide/getting-started).

## Quick Start (3 commands)

```bash
# Install
npm i -g @sleep2agi/agent-network

# Start the Hub (Terminal 1)
anet hub start

# Create + start an agent (Terminal 2)
anet node create my-agent
anet node start my-agent
```

## CLI cheat sheet

```bash
anet hub start                  # Start Hub + bootstrap admin (admin / anethub on first run)
anet hub status                 # Hub PID + port + /health version (v0.10.11+)
anet hub stop                   # Stop Hub: SIGTERM → 3s grace → SIGKILL (v0.10.11+, no more lsof+kill)
anet hub dashboard              # Web UI on localhost:3000
anet login                      # Login (saves utok_ to ~/.anet/config.json)
anet whoami                     # Current user
anet passwd                     # Change password
anet node ls                    # List nodes
anet node create <name>         # Interactive runtime + provider picker (Claude Code CLI / Claude Agent SDK / Codex / Grok Build ACP)
anet node start <name>          # Start agent
anet node resume <name>         # Resume previous session
anet status                     # Network overview
anet tasks                      # Task history
anet doctor                     # System diagnostic
anet doctor --fix               # Auto-probe expired ntok_ and reissue
anet info <name>                # Node details
anet logs <name>                # Node logs
anet upgrade                    # Upgrade anet + agent-node + commhub-server to latest
```

## Where to go next

- **Full install + onboarding**: [anet.sh/guide/getting-started](https://anet.sh/guide/getting-started)
- **CLI reference**: [anet.sh/guide/cli](https://anet.sh/guide/cli)
- **Multi-model setup** (MiniMax / Xiaomi MiMo / DeepSeek / GLM / Kimi / InternLM / OpenRouter / Grok Build): [anet.sh/guide/multi-model](https://anet.sh/guide/multi-model)
- **Architecture overview**: [anet.sh/guide/architecture](https://anet.sh/guide/architecture)
- **Changelog**: [anet.sh/changelog](https://anet.sh/changelog)
