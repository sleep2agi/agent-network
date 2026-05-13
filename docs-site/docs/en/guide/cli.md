# CLI Command Reference

`anet` is the Agent Network command-line management tool for Hub, account, Network, Agent Node, monitoring, and Demo operations.

## Installation

```bash
npm install -g @sleep2agi/agent-network
```

After installation, the `anet` command is available globally.

## Command Overview

### Quick Start

| Command | Description | Status |
|------|------|------|
| `anet init` | Configure hub address | verified |
| `anet init project` | Configure Claude Code project (.mcp.json + CLAUDE.md) | verified |
| `anet quickstart` | One-shot interactive bootstrap: hub + dashboard + node | Experimental (no E2E; [getting-started](/en/guide/getting-started) recommends the 1–7 step-by-step path for better control) |

### Server Management

| Command | Description |
|------|------|
| `anet hub start` | Start CommHub Server |
| `anet hub dashboard` | Start Dashboard UI |
| `anet hub config` | View/change Hub config |
| `anet hub admin reset-user --username <u>` | Locally reset a user's password |

### Account Management

| Command | Description |
|------|------|
| `anet register` | Register an account |
| `anet login` | Log in |
| `anet whoami` | View current user |
| `anet passwd` | Change password |

### Network Management

| Command | Description |
|------|------|
| `anet network ls` | List networks |
| `anet network create <name>` | Create a network |
| `anet network use <name>` | Switch active network |
| `anet network info` | View current network details |
| `anet network rename <old> <new>` | Rename a network |
| `anet network delete <name> --force` | Delete a network (owner-only; `--force` skips the confirm prompt) |
| `anet network invite` | Create an invite code for the current network |
| `anet network join <invite_code>` | Join a network with an invite code |
| `anet network members` | List members of the current network (role / joined_at) |

### Token Management

| Command | Description |
|------|------|
| `anet token create <name>` | Create an API token |
| `anet token ls` | List all tokens |
| `anet token revoke <id>` | Revoke a token |

### Agent Node Management

| Command | Description |
|------|------|
| `anet node create <name>` | Create an agent node |
| `anet node start <name>` | Start an agent |
| `anet node stop <name>` | Stop an agent |
| `anet node resume <name>` | Resume previous session |
| `anet node ls` | List all nodes |
| `anet info <name>` | View agent details |
| `anet logs <name>` | View agent logs (add `--follow` to tail in real time) |
| `anet node rename <old> <new>` | Rename an agent |
| `anet node delete <name>` | Delete an agent (interactive confirm by default; add `--force` or `--yes` to skip) |

### Monitoring

| Command | Description |
|------|------|
| `anet status` | Network overview (online agents + task stats) |
| `anet tasks [status]` | View task list |
| `anet demo ls` | List available demos |
| `anet demo debate [opts]` | **Debate demo**: 6 roles and a 9-step debate flow |
| `anet doctor` | System diagnostics |

### Demo (multi-agent showcase)

| Command | Description |
|------|------|
| `anet demo ls` | List available demos |
| `anet demo debate [opts]` | **Debate**: 6-role (host / pro × 2 / con × 2 / judge) one-command 9-step debate |

See [Debate Demo case](/en/cases/debate).

### Channel Management

| Command | Description |
|------|------|
| `anet channel add <type>` | Add a channel (telegram/wechat/feishu) |
| `anet channel ls` | List channels |

### Other

| Command | Description |
|------|------|
| `anet config` | View/modify configuration |
| `anet license` | v0.6 legacy: view trial / license status. **No longer needed after Apache 2.0 OSS**; Hub keeps the `licenses` table + `send_task` 14-day trial check for backward-compat |
| `anet activate <key>` | v0.6 legacy: write a pro license key. **No longer needed after Apache 2.0 OSS**; last-resort fix for `license_expired` — see [troubleshooting](/en/troubleshooting) |

---

## Detailed Usage

### anet hub start

Start the CommHub communication server.

```bash
anet hub start [options]
```

What it does:

1. Starts CommHub without requiring `COMMHUB_AUTH_TOKEN` in v0.8+
2. Starts CommHub on `127.0.0.1:9200` by default
3. Creates the SQLite database at `~/.commhub/commhub.db`
4. **First run only**: bootstraps admin with default credentials **`admin / anethub`** (quick-start), saves the admin `utok_` to `~/.anet/server/admin-utok.json` (chmod 600). Change this password immediately via `anet passwd`.
5. Saves the local Hub URL to `~/.anet/config.json`
6. Reuses a valid saved `utok_` if one exists; otherwise `anet login --username admin --password anethub`

::: info Expected output
```
anet hub start
Starting CommHub Server on port 9200 (bind 127.0.0.1)...
✅ Server running on http://127.0.0.1:9200 (commhub-server v0.8.0)
🔒 secured
✅ Admin account created
   username: admin
   password: anethub
   Admin token saved to ~/.anet/server/admin-utok.json
```
:::

::: tip Custom credentials (recommended for public deployment)
Default `admin / anethub` is fine only for local quick-start. For public deployment, set a strong password at bootstrap:
```bash
anet hub start --username alice --password 'your-strong-pass!'
```
Custom passwords must be ≥ 8 chars and not in the top-1000 weak-password dictionary. The default credentials bypass this strength check — change via `anet passwd` ASAP.
:::

::: tip Subsequent starts
Once admin is bootstrapped (`~/.anet/server/admin-utok.json` exists), `anet hub start` is idempotent:
```
✅ Admin already exists (admin-utok.json found, user=admin)
```
:::

| Parameter | Default | Description |
|------|--------|------|
| `--port` | 9200 | Listen port |
| `--host` / `--ip` | 127.0.0.1 | Bind address; use `0.0.0.0` for LAN access |
| `--username` | `admin` | Custom admin username |
| `--password` | `anethub` (quick-start default) | Custom admin password (≥8 chars + not in weak-password dict; default bypasses check) |
| `--dev-open` | false | **Dangerous**: runs with no auth, only for offline tutorials |

**Environment variables**:

| Variable | Description |
|------|------|
| `PORT` | Listen port |
| `COMMHUB_AUTH_TOKEN` | Legacy master token env; deprecated in v0.8 |
| `DATABASE_URL` | PostgreSQL connection (v0.8+ product direction has pivoted to SQLite only — see [v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md); adapter kept only as a community extension point / no E2E coverage, **not recommended for mainline production**; default SQLite) |
| `COMMHUB_CORS_ORIGINS` | CORS whitelist |

### anet passwd

Change the current logged-in user's password. By default it prompts for old password, new password, and confirmation. Scripts may pass `--old` / `--new`.

```bash
anet passwd
anet passwd --old old-password --new new-password
```

On success the hub returns a fresh `utok_`; CLI saves it back to `~/.anet/config.json`. Other devices' `utok_` are revoked. Agent `ntok_` credentials are not affected.

### anet hub admin reset-user

Local hub-host recovery command. It bypasses HTTP and reads SQLite directly.

```bash
anet hub admin reset-user --username alice
```

It generates a random password, revokes all user `utok_`, issues a fresh `utok_`, and writes `password_reset_by_admin` to `audit_log`. The password is printed once.

### anet node create

Create a new agent node.

```bash
anet node create <name> [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--runtime` | (interactive) | `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` |
| `--model` | (per runtime default) | Model name |

**Examples**:

```bash
# Interactive creation
anet node create my-agent

# Direct specification
anet node create code-assistant --runtime codex-sdk --model <codex-model-id>

# MiniMax Agent
anet node create translator --runtime claude-agent-sdk --model <minimax-model-id>
```

After creation, a config file is generated at `.anet/nodes/<node-name>/config.json` (directory name is the alias, not the internal `node_id`):

```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "code-assistant",
  "runtime": "codex-sdk",
  "model": "<codex-model-id>",
  "session": "",
  "channels": ["server:commhub"],
  "tools": [],
  "env": {},
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process",
    "maxTurns": 20,
    "logLevel": "info"
  }
}
```

### anet node start

Start an agent node.

```bash
anet node start <name> [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--new-session` | false | Ignore previous session, create a new one |

**Flow**:

1. Read `.anet/nodes/<name>/config.json`
2. Auto-populate `node_id` (if missing)
3. Start tmux session
4. Spawn agent process (based on runtime)
5. Connect to CommHub (`report_status(idle)`)
6. Establish SSE long connection
7. Wait for tasks

### anet status

View network status overview.

```bash
anet status
```

Example output:

```
Agent Network Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Network: default (net_a1b2c3d4)
Server:  http://localhost:9200

Nodes (5 online, 2 offline):
  🟢 commander    idle     Claude      3s ago
  🟢 coder-1     working  Codex (codex-sdk)     Writing sorting algorithm
  🟢 coder-2     idle     Codex (codex-sdk)     15s ago
  🟢 writer-1    idle     MiniMax     1m ago
  🟢 writer-2    idle     MiniMax     2m ago
  ⚪ tester-1    offline              2h ago
  ⚪ tester-2    offline              3h ago

Tasks: 42 replied, 3 running, 0 failed
```

### anet tasks

View task list.

```bash
anet tasks [status] [--limit <n>]
```

| Parameter | Description |
|------|------|
| `status` | Filter by status: `delivered` / `running` / `replied` / `failed` / `cancelled` |
| `--limit` | Number of items (default 20) |

**Examples**:

```bash
# View all tasks
anet tasks

# Show only failed tasks
anet tasks failed

# Limit item count
anet tasks --limit 5
```

### anet doctor

System diagnostics.

```bash
anet doctor              # Diagnose only; prints ✅ / ❌ per check with fix hints
anet doctor --fix        # Auto-repair: probes expired ntok_ and re-issues them via the hub, writing back to .anet/nodes/<name>/config.json
```

Checks:

1. Global config (`~/.anet/config.json`)
2. Auth token presence
3. Hub reachability (GET `/health`)
4. Local node config and process status
5. Claude / Codex / Bun dependencies
6. Current project `.mcp.json` commhub config

::: tip `--fix` is new in v0.8
Pre-v0.7, an expired `ntok_` required a manual `anet node delete` + recreate. Since v0.8, `--fix` probes + re-issues in place, and agent-node SSE 401 auto-reloads the token instead of going offline ([RFC-001 Phase 2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) implementation detail).
:::

### anet network invite

Create a network invite code.

```bash
anet network invite [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--role` | member | Invited role: `admin` / `member` / `viewer` |
| `--uses` | 1 | Maximum uses, -1 for unlimited |
| `--expires` | (none) | Expiration in days |

**Examples**:

```bash
# Switch to the target network first
anet network use dev

# Create a single-use invite code
anet network invite

# Create a 10-use member invite code
anet network invite --role member --uses 10

# Create a 7-day expiring viewer invite code
anet network invite --role viewer --expires 7
```

### anet token create

Create an API token.

```bash
anet token create <name>
```

**Examples**:

```bash
# Create an API token
anet token create my-agent-token
```

::: warning Security Note
The created token is displayed only once. Store it securely. If lost, you'll need to create a new one.
:::

### anet node resume

Resume a previously interrupted agent session. When an agent crashes, is manually stopped, or exits unexpectedly, use this command to restore context without losing conversation history.

```bash
anet node resume <name> [--session <id>]
```

| Parameter | Description |
|------|------|
| `<name>` | Agent name (alias) |
| `--session` | Specify a session ID to resume (optional) |

If `--session` is not specified, the last session saved in config.json is used.

**Automatic session saving**:

- After each task completion, Agent Node automatically saves the session_id (Claude) or thread_id (Codex) to the `session` field in `config.json`
- On the next `anet node resume`, this is read automatically -- no manual tracking needed

**Use cases**:

- Agent process crashed or was killed, need to restore context and continue working
- After a manual `anet node stop`, want to continue where the previous conversation left off
- Network disconnect caused the agent to go offline, resume after reconnecting

```bash
# Resume last session
anet node resume commander

# Resume a specific session
anet node resume worker --session abc123
```

::: tip Difference from anet node start
`anet node start` creates a new session by default. If you want to restore an old session, use `anet node resume`. If you want to force a new session, use `anet node start <name> --new-session`.
:::

### anet init project

Initialize a Claude Code project with automatic MCP and CLAUDE.md configuration.

```bash
anet init project
```

**Auto-created files**:

```
{project}/
├── .mcp.json            # MCP Server config
├── CLAUDE.md            # Agent behavior rules
└── .anet/
    ├── node-server.ts   # Channel plugin
    └── package.json     # Dependencies
```

`.mcp.json` contents:

```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": [".anet/node-server.ts"]
    }
  }
}
```

## Common Options

Common commands read these options or their saved config equivalents:

| Option | Description |
|------|------|
| `--hub <url>` | CommHub Server address |
| `--help` | Show help |
| `--version` | Show version |

> Since v0.8, authentication goes through `anet login --hub <URL> --username --password` (one-step) or `anet login` to obtain `utok_`; the legacy `--token` master-token flag is no longer the recommended path. See [Tokens](/en/concepts/tokens) + [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md).

## Environment Variables

| Variable | Description | Priority |
|------|------|--------|
| `COMMHUB_URL` | CommHub Server address | Highest |
| `COMMHUB_ALIAS` | Agent alias | Highest |
| `COMMHUB_AUTH_TOKEN` | Auth token (v0.8 soft-deprecated, removed in v1.0) | Highest |
| `COMMHUB_TOKEN` | Auth token (alias; same v0.8 soft-deprecation as `COMMHUB_AUTH_TOKEN`) | Highest |
| `ANTHROPIC_BASE_URL` | Model API URL (MiniMax / DeepSeek / GLM and other third-party Anthropic-compatible endpoints) | - |
| `ANTHROPIC_AUTH_TOKEN` | Model API key — for **third-party Anthropic-compatible endpoints** | - |
| `ANTHROPIC_API_KEY` | Model API key — **only for direct api.anthropic.com** (see [runtimes pitfalls](/en/guide/runtimes#claude-agent-sdk)) | - |

## Next steps

**Hands-on starter**:
- Run end-to-end: [One-shot install](/en/guide/one-shot-install) — install + first agent
- Try demos: [Hello World](/en/cases/hello-world) / [Debate](/en/cases/debate) / [Telegram squad](/en/cases/telegram-squad)

**Behind the commands**:
- Config file structure: [Agent Node](/en/guide/agent-node) (config.json fields)
- Pick a runtime: [Runtimes](/en/guide/runtimes)
- Switch between domestic / overseas models: [Multi-model](/en/guide/multi-model)

**v0.8 new tools**:
- `anet passwd` — change password (see [Security](/en/concepts/security))
- `anet hub admin reset-user <username>` — local owner force-reset
- `anet doctor --fix` — auto-probe + reissue expired ntok_
- `anet hub start` — first run auto-bootstraps admin (default `admin / anethub`)

**Full upgrade guide**: [v0.7 → v0.8 upgrade notes](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest)
