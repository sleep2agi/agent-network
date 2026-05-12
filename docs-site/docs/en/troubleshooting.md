# Troubleshooting

Quickly identify problems and solutions based on error messages.

## Connection Errors

### `ECONNREFUSED` -- Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:9200
```

**Cause**: CommHub Server is not running.

**Solution**:

```bash
# Check if the server is running
curl http://localhost:9200/health

# If not running, start the server
anet hub start --port 9200

# If the port is wrong, check config
cat ~/.anet/config.json
```

---

### `ETIMEDOUT` -- Connection Timeout

```
Error: connect ETIMEDOUT 203.0.113.10:9200
```

**Cause**: Network unreachable or blocked by firewall.

**Solution**:

```bash
# Check network connectivity
ping 203.0.113.10
telnet 203.0.113.10 9200

# Check firewall
sudo ufw status
sudo ufw allow 9200

# Check cloud server security groups
# Ensure inbound rules allow TCP 9200
```

---

### `SSE connection failed` -- SSE Connection Failure

```
[agent-node] SSE connection failed, reconnecting in 3s...
```

**Cause**: SSE long connection dropped, usually due to network fluctuation.

**Solution**: The agent will auto-reconnect (exponential backoff 3s -> 60s); no manual intervention usually needed.

If it persists:

```bash
# Check if the server is running
curl http://localhost:9200/health

# Check if the token is valid
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status

# Check reverse proxy config (if applicable)
# Nginx needs:
# proxy_read_timeout 86400;
# proxy_buffering off;
```

---

## Auth Errors

### `401 unauthorized`

```json
{"error": "unauthorized"}
```

**Cause**: Token is invalid or missing.

**Solution**:

```bash
# Check current token / identity (v0.8 recommended entrypoint)
anet whoami

# If token expired, log in again
anet login

# Check token in config file
cat ~/.anet/config.json

# (Legacy path, not recommended) `COMMHUB_AUTH_TOKEN` is soft-deprecated since v0.8;
# v1.0 removes it. For identity checks use `anet whoami`. If your env still has this
# variable set, unset it to avoid the deprecation warning on every request.
```

---

### `permission_denied` -- Insufficient Permissions

```json
{"ok": false, "error": "permission_denied"}
```

**Cause**:

1. **utok_ used for MCP write operations**: utok_ has no network binding and cannot call MCP write operations
2. **viewer role attempting write operations**: viewers are read-only

**Solution**:

```bash
# Case 1: Use ntok_ instead of utok_
# Agent Nodes must connect using ntok_. The token lives in
# .anet/nodes/<name>/config.json — agent-node CLI does NOT accept a --token flag.
# If your current node config still has utok_/atok_, doctor migrates it:
anet doctor --fix

# Case 2: Upgrade your role
# Have the owner/admin change your role
anet network use <network>
anet network invite --role member
```

---

### `license_expired` -- License Expired (legacy behavior)

```json
{"ok": false, "error": "license_expired", "message": "Trial expired. Activate a license: anet activate <key>"}
```

::: info anet is Apache-2.0 OSS since v0.8 — there is no real license to buy
This gate is a V3-era leftover still firing in the `send_task` path (`server/src/tools.ts:484`). It triggers when your local SQLite has a `licenses` row with `expires_at` in the past. **v0.9+ plans to drop the whole license check.**
:::

**Cause**: Your local SQLite `licenses` table has a row with `expires_at < now()`.

**Solution**:

```bash
# Option A (recommended): just delete the expired license row
sqlite3 ~/.commhub/commhub.db "DELETE FROM licenses WHERE expires_at < datetime('now');"

# Option B (legacy commands, no-op placeholders):
anet license          # inspect
anet activate <key>   # v0.6 legacy command, writes a new license row (the key is not validated — placeholder only)

# Option C (offline tutorial): start the hub with --dev-open to skip auth
anet hub start --dev-open
```

---

### `password too weak` / `password too short` -- Password strength (v0.8)

```
Error: password too short (min 8 chars)
Error: password is in the weak-password dictionary
```

**Cause**: From v0.8, `anet passwd` / `register` / `anet hub admin reset-user` all enforce:
- length ≥ 8 characters
- not in the top-1000 weak-password dictionary ("password", "12345678", "qwerty123", etc.)

**Exception**: first `anet hub start` prompt for admin allows ≥ 4 chars (so default `admin / anethub` works).

**Fix**:

```bash
# Generate a strong 16-char password
openssl rand -base64 16

# Or with pwgen
pwgen -s 16 1
```

::: warning Production deployments
For any `--host 0.0.0.0` / public deployment, change the default `anethub` **immediately** after first admin bootstrap:
```bash
anet login --username admin --password anethub
anet passwd                    # rotate to a strong password
```
:::

---

### `set up admin account` repeating prompt (v0.8)

The first `anet hub start` set admin, but the second start still prompts to set it up again?

**Cause**: An early v0.8.0 had this bug; fixed in v0.8.0 stable. If you still hit it, the SQLite db has no admin user row.

**Fix**:

```bash
# Accept the defaults
anet hub start
# Prompt: 'Set up admin account (default: admin / anethub):' → press Enter

# Or inspect the db
sqlite3 ~/.commhub/commhub.db "SELECT username, role FROM users"
```

If there's no admin row at all, re-bootstrap:

```bash
anet hub start                  # auto-creates admin / anethub
anet login --username admin --password anethub
```

---

### `rate_limit_exceeded` -- Rate Limited

```
HTTP 429: rate_limit_exceeded
```

**Cause**: Too many requests from the same IP.

| Endpoint | Limit |
|------|------|
| register | 30/minute |
| login | 10/minute |
| other | 60/minute |

**Solution**: Wait 60 seconds before retrying. Localhost is exempt from rate limits.

---

## Task Errors

### `task not found`

```json
{"ok": false, "error": "task not found"}
```

**Cause**:

1. Incorrect task_id
2. The task is in a different network (ntok_ is bound to a different network)

**Solution**:

```bash
# Confirm the task exists
anet tasks

# Confirm the current network
anet whoami

# Check task details
curl "http://localhost:9200/api/tasks?limit=10" -H "Authorization: Bearer ntok_xxx"
```

---

### `task status is X, not retryable`

```json
{"ok": false, "error": "task status is running, not retryable"}
```

**Cause**: Only tasks with status `failed` / `expired` / `cancelled` can be retried.

**Solution**:

::: tip
The following calls go via REST `POST /mcp` rather than the agent's stdio wrapper. The agent's stdio wrapper exposes 5 tools (reply / report_status / send_task / send_message / get_all_status); cancel/retry/reassign/get_inbox are admin/dashboard ops, not agent self-service.
:::

```bash
# Cancel the running task first (POST /mcp, tool=cancel_task)
cancel_task(task_id="t_xxx", reason="Need to retry")

# Then retry (POST /mcp, tool=retry_task)
retry_task(task_id="t_xxx")
```

---

### `task is terminal`

```json
{"ok": false, "error": "task is terminal (replied)"}
```

**Cause**: The task is already in a terminal state (replied / failed / cancelled / expired) and cannot be modified.

**Solution**: If you need to re-execute, create a new task:

```bash
commhub_send_task(alias="coder-1", task="Re-execute: ...")
```

---

### `message not found or not yours`

```json
{"ok": false, "error": "message not found or not yours"}
```

**Cause**:

1. Incorrect message_id
2. The message doesn't belong to the current agent (alias mismatch)
3. The message is in a different network

**Solution**:

::: tip
`get_inbox` is an admin/dashboard op exposed via REST `POST /mcp`, not the agent's stdio wrapper. The agent's stdio wrapper exposes 5 tools: reply / report_status / send_task / send_message / get_all_status.
:::

```bash
# Check messages in the inbox (POST /mcp, tool=get_inbox)
get_inbox(alias="coder-1")
```

---

## Network Errors

### `network name already exists`

```json
{"ok": false, "error": "network name already exists"}
```

**Cause**: You already have a network with the same name.

**Solution**:

```bash
# Check existing networks
anet network ls

# Use a different name
anet network create my-other-network
```

---

### `network has N active session(s)`

```json
{"ok": false, "error": "network has 3 active session(s) — stop them first"}
```

**Cause**: All agents must be stopped before deleting a network.

**Solution**:

```bash
# Check agents in the network
anet status

# Stop all agents
anet node stop coder-1
anet node stop coder-2
anet node stop coder-3

# Then delete
anet network delete my-network
```

---

### `quota exceeded`

```json
{"ok": false, "error": "quota exceeded: max 2 networks for free plan"}
```

**Cause**: Free plan quota exhausted.

**Solution**:

```bash
# Check current plan
anet license

# Delete unneeded networks
anet network delete old-network

# Or upgrade to Pro
anet activate <license-key>
```

---

## Agent Node Errors

### `alias is already taken`

```
Error: alias "coder-1" is already taken
```

**Cause**: An agent with the same name is already running in the same network.

**Solution**:

```bash
# Check online agents
anet status

# Use a different name
anet node create coder-1-v2
anet node start coder-1-v2

# Or stop the existing agent
anet node stop coder-1
```

---

### `settingSources` related errors

```
TypeError: Cannot read properties of undefined (reading 'settingSources')
```

**Cause**: Claude Agent SDK version incompatibility.

**Solution**:

```bash
# Upgrade agent-node
npm install -g @sleep2agi/agent-node@latest
```

---

### `ANTHROPIC_BASE_URL` connection failure

```
Error: Failed to connect to api.minimaxi.com
```

**Cause**: MiniMax / other compatible API URL is incorrect or unreachable.

**Solution**:

```bash
# Check the API URL
echo $ANTHROPIC_BASE_URL

# Test connectivity
curl -I $ANTHROPIC_BASE_URL

# Verify the API key works
curl -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  $ANTHROPIC_BASE_URL/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"<minimax-model-id>","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
# Replace <minimax-model-id> with the current model id supported by your MiniMax account (check https://platform.minimaxi.com)
```

---

## Docker Errors

### `service "seed" is not running`

The seed container is one-shot -- it exits after completion (exit code 0). This is normal.

```bash
# Check if it succeeded
docker compose logs seed
# You should see: seed: wrote ntok_ to /shared/ntok
```

---

### Worker containers keep restarting

```bash
# Check logs for the cause
docker compose logs worker-1

# Common causes:
# 1. Server not started yet (health check not passed)
# 2. ntok_ doesn't exist (seed failed)
# 3. Codex auth missing (~/.codex not mounted)
```

---

### `permission denied` in Docker

```
Error: EACCES: permission denied, mkdir '/root/.claude'
```

**Solution**: Ensure the `.claude` directory is mounted as tmpfs:

```yaml
tmpfs:
  - /root/.claude
  - /tmp
```

---

## Diagnostic Tools

### anet doctor

Comprehensive system health check:

```bash
anet doctor
```

### Manual Checklist

```bash
# 1. Server health
curl http://localhost:9200/health

# 2. Valid auth
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status

# 3. Agents online
curl -H "Authorization: Bearer ntok_xxx" "http://localhost:9200/api/status?status=idle"

# 4. Database size
ls -lh ~/.commhub/commhub.db

# 5. SSE connection count
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/stats
```

### Log Levels

Agent Node supports adjustable log levels:

```json
// config.json
{
  "flags": {
    "logLevel": "debug"  // debug / info / warn / error
  }
}
```

## Still Having Issues?

**Try these v0.8 auto-repair tools first**:

- `anet doctor` — probes current hub / token / network state, prioritized output
- `anet doctor --fix` — auto-probes expired ntok_ and reissues; agent-node SSE 401 auto-reloads
- `anet hub admin reset-user <username>` — local owner on the Hub machine force-resets a user password (forgot-password recovery)
- `anet passwd` — interactive password change

**Still stuck**:

- **GitHub Issues**: [github.com/sleep2agi/agent-network/issues](https://github.com/sleep2agi/agent-network/issues) — report bugs or search known issues
- **GitHub Discussions**: [discussions](https://github.com/sleep2agi/agent-network/discussions) — usage questions / design discussion
- **Source code**: All error messages can be found in `server/src/tools.ts` and `server/src/auth.ts`
- **FAQ**: [Frequently asked questions](/en/faq) — model choice / cost / upgrade caveats

## Next steps

- [Upgrade to v0.8](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest) — upgrade path and behavior changes for older installs
- [Security design](/en/concepts/security) — read before chasing an auth issue
- [Architecture](/en/guide/architecture) — locate which layer is failing
- [Community](/en/community) — chat groups and discussion
