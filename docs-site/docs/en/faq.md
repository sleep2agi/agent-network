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

**Apache-2.0 open source and fully self-hosted.** The repository license does not require purchasing a product license and there is no official hosted SaaS, but the current v0.10.2 stable server code still contains a legacy trial/pro-license table plus a `send_task` expiry check.

- Public repo, modifiable source
- Business model = courses + consulting, not a forced hosted SaaS
- `anet license` / `anet activate` are v0.6 legacy commands, **no longer needed after Apache 2.0 OSS**. If you hit `license_expired` (Hub still creates a 14-day trial for backward-compat), follow [troubleshooting — license_expired](/en/troubleshooting#license-expired-legacy-behavior) to clear the `licenses` table.

::: info v0.6 license path planned for removal
The server still runs `licenses.expires_at` checks inside `send_task` (V3 legacy code; verify [`server/src/tools.ts` still emits `license_expired`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts)) — **neither v0.9.x nor v0.10.0 scope touched it** (v0.9.x prioritized Recovery & Observability; v0.10.0 prioritized Direct Runtime + Observability Foundations); planned for v0.11+ removal.
:::

### 4. Which AI models are supported?

Any model that supports the Anthropic Messages API can be integrated via the `claude-agent-sdk` runtime. Providers **built into** the `anet node create` `VENDORS` list (every entry is verified-with-real-call before it lands — see [runtimes — Verified vs not](/en/guide/runtimes#verified-vs-not)):

- **Anthropic** native SDK (Claude Sonnet / Opus / Haiku; see [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview))
- **MiniMax** (Anthropic-compatible; see [MiniMax platform](https://platform.minimaxi.com))
- **InternLM** (Anthropic-compatible; see [InternLM chat](https://chat.intern-ai.org.cn))
- **Xiaomi MiMo** (Anthropic-compatible; see [Xiaomi platform](https://platform.xiaomimimo.com))
- **OpenAI Codex** (`codex-sdk` runtime; see OpenAI Codex docs)

Providers NOT in the `VENDORS` list (DeepSeek / Zhipu GLM / Moonshot Kimi / OpenRouter, etc.) — reach them via the `custom` vendor: any Anthropic-compatible API accepts a base URL + model id there; usable, but verify it yourself first.

Full endpoint table + configuration examples at [Multi-model](/en/guide/multi-model). Any provider that supports the Anthropic Messages API works via `ANTHROPIC_BASE_URL`.

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
| Global config | `~/.anet/config.json` | Hub address, `utok_`, current active network |
| Node config | `{cwd}/.anet/nodes/<alias>/config.json` | Runtime, model, tools, `ntok_`, env, flags (directory name is the alias, not the internal `node_id`; see [architecture R222 calibration](https://github.com/sleep2agi/agent-network/blob/main/docs/architecture.md#2-配置文件--r222-校准v08-实际-schema)) |
| Database | `~/.commhub/commhub.db` | Hub-side SQLite (WAL mode) |

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

- `task` / `broadcast` -> AI processes and replies (correct)
- `reply` / `message` / `ack` -> No processing (correct, prevents think loops; see [Task lifecycle — Message types](/en/concepts/task-lifecycle#message-types))

If using the `claude-code-cli` runtime, check that the project-root `CLAUDE.md` contains the right reply rules (CLAUDE.md is the instruction file Claude Code auto-loads).

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
  -d '{"model":"<minimax-model-id>","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
# Replace <minimax-model-id> with the current model id supported by your MiniMax account (check https://platform.minimaxi.com)
```

Note:

- `ANTHROPIC_BASE_URL` must be `https://api.minimaxi.com/anthropic` (note the `/anthropic` suffix)
- MiniMax uses `ANTHROPIC_AUTH_TOKEN` for the key (**not** `ANTHROPIC_API_KEY` — the latter is only for direct api.anthropic.com calls; see [runtimes — claude-agent-sdk pitfalls](/en/guide/runtimes#claude-agent-sdk))

### 14. How do I view detailed agent logs?

```bash
# Agent started via anet
anet logs coder-1                # recent slice
anet logs coder-1 --follow       # live tail (like `tail -f`)

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
| `utok_` | CLI / Dashboard login | Cross-network reads; MCP writes within a network when role ≥ member (owner / admin / member can write, viewer is read-only — see [tokens — auth decision](/en/concepts/tokens#authorization-decision-how-the-hub-decides)) | viewer writes in that network; writes against networks where the user isn't a member |
| `ntok_` | Agent connection | All member+ operations within the locked single network (hub force-binds network_id) | Cross-network |

**Quick rule**: Humans use utok_, agents use ntok_.

### 16. How do I add an agent to another network?

```bash
# Option 1: Invite code (recommended)
anet network use other-network
anet network invite --role member
# Share the invite code with the recipient
# Recipient runs (on their own machine): anet network join inv_xxx

# Option 2: Register the node locally on the target machine (cross-machine, **do NOT copy config.json**)
# On the target machine:
anet login --hub http://<hub-host>:9200 --username admin --password ...
anet network use other-network
anet node create other-agent                   # CLI registers with the hub and gets its own ntok_
anet node start other-agent
```

::: warning Do not copy `.anet/nodes/<name>/config.json` across machines
The `node_id` inside the config is a unique ID the hub assigns at registration. Copying it makes two machines claim the same node and breaks SSE routing. See [networks — cross-machine deployment](/en/concepts/networks#cross-machine-deployment).
:::

### 17. How do I view/manage network members?

```bash
# View members of the current network (CLI)
anet network members

# View members (direct REST)
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"

# Invite a new member (owner/admin)
anet network invite --role member        # Generate invite code (admin/member/viewer)
```

::: tip Role changes
The current v0.10.2 stable still does not expose `promote` / `demote` CLI subcommands (v0.9.x scope was Recovery & Observability; v0.10.0 scope was Direct Runtime + Observability Foundations; v0.10.1 was the PINNED chain-bump hotfix; v0.10.2 was Hero A disk telemetry + Hero D topology prefix UX — none of them touched member-role management). To change roles, call [REST `/api/networks/:id/members/:user_id`](/en/api/rest) directly or use the Dashboard Admin page (partial; see [Dashboard Admin](/en/guide/dashboard#admin)). Full CLI entry is scheduled for v0.11+ / unscheduled.
:::

### 17a. How do I change my password? (v0.8)

```bash
anet passwd                       # interactive: old password → new password ≥ 8 chars + not in weak-password dict
```

Requirements: ≥ 8 characters + not in [`password-dict.ts WEAK_PASSWORDS`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts). **`anet passwd` and `anet hub admin reset-user` have no length exemption** — only the first-time admin **register** path allows ≥ 4 chars so that the quick-start `admin / anethub` default works (aligned with the R193/R248 chain; verified at [`auth.ts:43-44`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L43)).

### 17b. Forgot my password — how to reset? (v0.8)

**Option A (recommended)**: Reset via admin on the Hub machine:

```bash
anet hub admin reset-user <username>   # force-reset a user's password; no old password needed
# → generates a new random password + revokes all of that user's utok_ + issues a fresh utok_ + writes audit_log password_reset_by_admin
```

**Option B (last resort, if you can't even reach the Hub machine)**: Edit SQLite directly AND remove the admin marker:

```bash
# 1. Delete the user row
sqlite3 ~/.commhub/commhub.db "DELETE FROM users WHERE username='admin'"

# 2. CRITICAL: delete the admin-utok.json marker (otherwise `anet hub start` will skip register and not recreate admin)
rm -f ~/.anet/server/admin-utok.json

# 3. Restart the hub to trigger the non-interactive bootstrap (outputs '✅ Admin account created')
anet hub start
```

::: warning You must delete the marker
R210 chain finding: `anet hub start` bootstrap is **non-interactive and idempotent**, driven by the `~/.anet/server/admin-utok.json` marker file. **Running only `DELETE FROM users` without removing the marker → hub start sees the marker and skips the register flow → admin is NOT recreated** (you'll see `✅ Admin already exists` while the DB has no admin row). See [troubleshooting → second `anet hub start` re-bootstraps admin?](/en/troubleshooting)
:::

⚠️ Option B is a last resort and clears user records; the reset is not recorded in `audit_log`. Production should prefer Option A. See [Security design](/en/concepts/security) for details.

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

You must use prebuilt deployment — two steps, order matters:

```bash
cd agent-network-dashboard
vercel build --prod                  # build locally; output goes to .vercel/output
vercel deploy --prebuilt --prod      # upload .vercel/output
```

Note that **step one must be `vercel build`, not `npm run build`** — `vercel deploy --prebuilt` only uploads the `.vercel/output` directory, which is produced by `vercel build`; running just `npm run build` leaves `.vercel/output` empty or stale. Building locally instead of on Vercel saves build cost and avoids missing environment variables.

### 20. What about PostgreSQL support?

::: warning Not recommended on the current stable line
The code has a `DATABASE_URL=postgres://...` entry point, but PostgreSQL **has not been end-to-end verified on the current stable line** — don't use it in production yet.

For now, please stick with the default **SQLite** (`~/.commhub/commhub.db`). SQLite handles 100+ agents on a single machine just fine for the supported deployment shape.

Note: **v0.8+ product direction is SQLite only** (see [docs/v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md)) — Postgres is no longer on the maintained roadmap. The adapter interface is preserved as a community extension point — if you have a real HA / multi-writer use case, open a [GitHub Discussion](https://github.com/sleep2agi/agent-network/discussions) to coordinate a self-hosted approach.
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
- nginx `proxy_buffering` left at the default `on` (must be `off` for SSE, otherwise events sit in the buffer until it fills)

Nginx configuration recommendation:

```nginx
location /events/ {
    proxy_pass http://127.0.0.1:9200;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # rate limit needs real client IP
    proxy_read_timeout 86400;   # 24 hours
    proxy_buffering off;
    proxy_cache off;
}

# Also pass X-Forwarded-For on /api/* + /mcp so audit_log records the real IP (R169 / R195 chain)
location / {
    proxy_pass http://127.0.0.1:9200;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
}
```

::: tip Rate-limit IP detection
The hub's register / login endpoints take `req.headers["x-forwarded-for"]?.split(",")[0]` as the `clientIP` passed to `checkRateLimit` ([`server/src/index.ts:428`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L428) register / L443 login). If the reverse proxy doesn't set `X-Forwarded-For`, all requests appear to come from the same IP (the proxy itself) — rate limiting then mis-trips on every user.
:::

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
