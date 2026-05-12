# FAQ

Frequently asked questions and answers.

## Basics

### 1. What is Agent Network? How does it differ from LangChain / CrewAI?

Agent Network is a **multi-agent communication infrastructure**, not an agent framework. It doesn't care how your agent "thinks" -- it's solely responsible for enabling multiple agents to communicate, dispatch tasks, and track results.

| Comparison | Agent Network | LangChain / CrewAI |
|------|-------------|-------------------|
| Positioning | Communication infrastructure | Agent framework |
| Protocol | MCP standard protocol | Custom |
| Models | Any model mix | Typically single model |
| Deployment | Distributed (multi-machine) | Typically single process |
| Management | CLI + Dashboard | Code-defined |

### 2. Do I need a server?

**Development / personal use**: `anet hub start` starts on your local machine -- no extra server needed.

**Team use**: We recommend deploying CommHub Server on a dedicated server, with team members each connecting remotely. Minimum config: 1 core, 1GB RAM.

### 3. Is it free?

**Apache-2.0 open source and fully self-hosted.** The repository license does not require purchasing a product license and there is no official hosted SaaS, but the current v0.8 server code still contains a legacy trial/pro-license table plus a `send_task` expiry check.

- Public repo, modifiable source
- Business model = courses + consulting, not a forced hosted SaaS
- `anet license` / `anet activate` are v0.6 legacy commands, **no longer needed after Apache 2.0 OSS**. If you hit `license_expired` (Hub still creates a 14-day trial for backward-compat), follow [troubleshooting](/en/troubleshooting) to clear the `licenses` table.

::: info v0.6 license path planned for removal
The server still runs `licenses.expires_at` checks inside `send_task` (V3 legacy code). Removal scheduled for v0.9+.
:::

### 4. Which AI models are supported?

Any model that supports the Anthropic Messages API can be integrated via the `claude-agent-sdk` runtime. Currently verified:

- Latest Claude line (Sonnet / Opus / Haiku, native SDK; specific model IDs at [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview))
- Codex SDK (gpt-5.4)
- MiniMax M2.7 (Anthropic-compatible API)
- InternLM Intern-S1-Pro (Anthropic-compatible API)
- DeepSeek (Anthropic-compatible API)

### 5. How many agents can a single network support?

There is no hard technical limit. In our testing:

- **10 agents**: Completely smooth
- **50 agents**: Normal operation
- **100 agents**: Slight SSE push delay (< 1s)

SQLite WAL mode supports high-concurrency reads and writes. The bottleneck is typically the AI model's response time.

## Installation and Configuration

### 6. Permission error during install (EACCES)

```bash
# Option 1: Use nvm to manage Node.js (recommended)
nvm install 20
nvm use 20
npm install -g @sleep2agi/agent-network

# Option 2: Change npm global directory
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g @sleep2agi/agent-network
```

### 7. bun command not found

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Refresh PATH
source ~/.bashrc
# or
export PATH="$HOME/.bun/bin:$PATH"

# Verify
bun --version
```

### 8. anet hub start reports port in use

```bash
# Check what's using the port
lsof -i :9200
# or
ss -tlnp | grep 9200

# Use a different port
anet hub start --port 9201

# Or stop the process using it
kill <PID>
```

### 9. Where are the config files?

| File | Path | Contents |
|------|------|------|
| Global config | `~/.anet/config.json` | Hub address, token |
| Project config | `{project}/.anet/config.json` | Alias, type |
| Node config | `.anet/nodes/<id>/config.json` | Runtime, model, tools |
| Database | `~/.commhub/commhub.db` | SQLite data |

## Agent Issues

### 10. Agent stays offline after starting

Possible causes:

1. **Network unreachable**: Check if the agent can access the CommHub Server

```bash
curl http://YOUR_IP:9200/health
```

2. **Invalid token**: Check if the token is valid

```bash
anet whoami
```

3. **Firewall**: Ensure port 9200 is open

```bash
ufw allow 9200
```

4. **Heartbeat timeout**: If the agent ran normally then crashed, wait 10 minutes for timeout or manually restart

### 11. Agent processes a task but result isn't returned

Check the agent's message type handling logic:

- `task` type -> AI processes and replies (correct)
- `message` type -> No processing (correct, prevents loops)

If using Claude Code mode, check that CLAUDE.md contains the correct reply rules.

### 12. Two agents sending messages back and forth in an infinite loop

This is a message type design issue. Ensure:

- Use `send_task` for tasks (type=task) -> triggers AI processing
- Use `send_reply` for results (type=reply) -> does NOT trigger AI processing
- Use `send_message` for chat (type=message) -> does NOT trigger AI processing

If looping persists, verify that agent-node only responds to `new_task` and `broadcast` events.

### 13. MiniMax Agent reports API errors

```bash
# Check if the API key is correct
curl -H "Authorization: Bearer $MINIMAX_API_KEY" \
  https://api.minimaxi.com/anthropic/v1/messages \
  -d '{"model":"MiniMax-M2.7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

Note:

- `ANTHROPIC_BASE_URL` must be `https://api.minimaxi.com/anthropic` (note the `/anthropic` suffix)
- Use `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` for the key

### 14. How do I view detailed agent logs?

```bash
# Agent started via anet
anet logs coder-1

# Agent started via npx: check terminal output directly

# Agent in Docker
docker compose logs -f worker-1

# CommHub Server logs
docker compose logs -f server
```

## Network and Permissions

### 15. What's the difference between utok_ and ntok_? When should I use which?

| Token | Purpose | Can Do | Cannot Do |
|-------|------|---------|-----------|
| `utok_` | CLI / Dashboard login | REST reads, management | MCP write operations |
| `ntok_` | Agent connection | All operations within network | Cross-network |

**Quick rule**: Humans use utok_, agents use ntok_.

### 16. How do I add an agent to another network?

```bash
# Option 1: Invite code
anet network use other-network
anet network invite --role member
# Share the invite code with the recipient
# Recipient runs: anet network join inv_xxx

# Option 2: Create a node config in the target network and copy it to the agent machine
anet network use other-network
anet node create other-agent
# Provide .anet/nodes/other-agent/config.json to the agent machine
```

### 17. How do I view/manage network members?

```bash
# View members
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"

# Manage via the Dashboard Settings page
```

### 17a. How do I change my password? (v0.8)

```bash
anet passwd                       # interactive: old password → new password ≥ 8 chars + not in weak-password dict
```

Requirements: ≥ 8 characters + not in the top-1000 weak-password dictionary. First-time bootstrap admin is allowed ≥ 4 chars as an exception.

### 17b. Forgot my password — how to reset? (v0.8)

If you can log into the Hub machine (local owner access):

```bash
anet hub admin reset-user <username>   # force-reset a user's password; no old password needed
```

If you can't even reach the Hub machine (extreme case), edit SQLite directly:

```bash
sqlite3 ~/.commhub/commhub.db "DELETE FROM users WHERE username='admin'"
anet hub start                          # restart, auto-bootstraps admin / anethub
```

⚠️ The latter is a last resort and clears user records. See [Security design](/en/concepts/security) for details.

## Deployment Issues

### 18. Workers can't connect to Server in Docker Compose

Ensure:

1. Server health check passes before starting workers

```yaml
depends_on:
  server:
    condition: service_healthy
```

2. Use Docker's internal network name (`server:9200` not `localhost:9200`)

3. Seed container successfully exported ntok_

```bash
docker compose logs seed
```

### 19. Dashboard deployment to Vercel fails

You must use prebuilt deployment:

```bash
cd agent-network-dashboard
npm run build
vercel deploy --prebuilt --prod
```

Don't build on Vercel, as environment variables may be missing.

### 20. What about PostgreSQL support?

::: warning Not recommended on the current stable line
The code has a `DATABASE_URL=postgres://...` entry point, but PostgreSQL **has not been end-to-end verified on the current stable line** — don't use it in production yet.

For now, please stick with the default **SQLite** (`~/.commhub/commhub.db`). SQLite handles 100+ agents on a single machine just fine for the supported deployment shape.

If you have a real HA / multi-writer use case for Postgres, open a [GitHub Discussion](https://github.com/sleep2agi/agent-network/discussions) and we'll prioritize it for a later release.
:::

## Performance Issues

### 21. Slow task response

Check:

1. **AI model latency**: Different models have different response times
   - Codex (codex-sdk): 3-15 seconds
   - Claude: 5-30 seconds
   - MiniMax: 1-5 seconds
2. **Network latency**: Latency between agent and server
3. **Server load**: Run `anet doctor` to check server status
4. **Database size**: Large amounts of historical data may affect query speed

### 22. SSE connections frequently dropping

Possible causes:

- Unstable network
- Reverse proxy timeout set too short
- Firewall closing long connections

Nginx configuration recommendation:

```nginx
location /events/ {
    proxy_pass http://127.0.0.1:9200;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 86400;   # 24 hours
    proxy_buffering off;
    proxy_cache off;
}
```

## Next steps

**Getting-started tutorials**:
- [One-shot install](/en/guide/one-shot-install) — first agent after install
- [Hello World](/en/cases/hello-world) — 6-step walkthrough
- [Getting started](/en/guide/getting-started) — install through first run

**Dig into concepts**:
- [Security design](/en/concepts/security) — tokens / passwords / isolation
- [Account system](/en/guide/account-system) — utok_ / ntok_ / password relationship
- [Architecture](/en/guide/architecture) — overall system design

**Upgrade and troubleshooting**:
- [v0.7 → v0.8 upgrade](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest) — admin bootstrap / password management
- [Troubleshooting](/en/troubleshooting) — common errors
- `anet doctor --fix` — auto-probe + reissue ntok_

**Community**:
- [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) — bug reports / feature requests
- [Community](/en/community) — join the discussion
