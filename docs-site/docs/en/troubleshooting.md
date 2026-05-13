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

### 401 `auth required` / `invalid token` / `token required`

The server actually returns one of three 401 errors (**not** `{"error": "unauthorized"}`; verify `grep error.*401 server/src/index.ts`):

```json
{ "ok": false, "error": "auth required" }     // most REST endpoints when Authorization header is missing
{ "ok": false, "error": "token required" }    // some auth endpoints (e.g. /api/auth/me) when token is absent
{ "ok": false, "error": "invalid token" }     // token is syntactically present but resolveToken failed (revoked / expired / hub DB wiped)
```

**Cause**: Token is invalid or missing. `invalid token` is also common right after a hub DB wipe (reset of commhub.db) — every existing utok\_ / ntok\_ is now stale.

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
# Have the owner (not admin — admin can't change roles, see R149 PUT members owner-only gate)
# call REST to promote you (no CLI promote subcommand yet — queued for v0.9+):
NET=$(jq -r .network_id ~/.anet/config.json)
UTOK=$(jq -r .token ~/.anet/config.json)        # owner's own utok_
curl -X PUT "$HUB/api/networks/$NET/members/<your_user_id>" \
  -H "Authorization: Bearer $UTOK" \
  -H "Content-Type: application/json" \
  -d '{"role": "member"}'
# See [API — PUT members](/en/api/rest#put-api-networks-id-members-user-id)
# Alternative: the owner issues a new invite code with the target role and you re-join.
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

### `password must be at least 8 characters` / `password is too common` -- Password strength (v0.8)

```json
{ "ok": false, "error": "password must be at least 8 characters" }
{ "ok": false, "error": "password is too common" }
{ "ok": false, "error": "new password must be at least 8 characters" }   // changePassword
{ "ok": false, "error": "new password is too common" }                   // changePassword
```

Verify [`auth.ts:24-28 validatePasswordStrength()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L24). The `label` parameter is why `changePassword` returns the `new password` variant.

**Cause**: From v0.8, `register` / `anet passwd` / `anet hub admin reset-user` all run the same `validatePasswordStrength()`:
- Length ≥ 8 characters
- Not in the weak-password dictionary ([`password-dict.ts WEAK_PASSWORDS`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts) covers `"password"` / `"12345678"` / `"qwerty123"` and other top entries)

**Exception (first registered user only)**: [`auth.ts:43-44`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L43) detects the "first user" case and only enforces `length >= 4` (so the bootstrap `admin / anethub` flow works). `anet passwd` / `reset-user` have **no such exemption** — they always require ≥ 8 + non-weak (same as the R193 chain).

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

### `anet hub start` keeps re-bootstrapping the admin?

The first `anet hub start` created admin, but a second start still prints `Admin account created`?

::: tip Bootstrap is **non-interactive** — there is no "Set up admin account" prompt
Verified at [`agent-network/bin/cli.ts:2027-2078`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2027): `anet hub start` simply POSTs `/api/auth/register` with username=`admin` and password=`anethub` (unless overridden by `--username` / `--password`). **No interactive prompt is involved**, so the older "repeating prompt" framing in this doc is stale and has been removed.

Idempotency is driven by `~/.anet/server/admin-utok.json` as a marker — if it exists, the register flow is skipped (output: `✅ Admin already exists`). If it's missing, the register call re-runs; if the user row already exists, the hub returns `username already taken` and the CLI prints `ℹ Admin account "admin" already exists` (no duplicate is created).
:::

**Cause**: `~/.anet/server/admin-utok.json` was deleted, or the hub's `~/.commhub/commhub.db` was wiped, or you're running with a different `HOME` (e.g. a Docker container without a mounted volume).

**Inspect state**:

```bash
# 1. Where is the marker?
ls -la ~/.anet/server/admin-utok.json   # exists → next start skips register

# 2. Is the admin user row present on the hub?
sqlite3 ~/.commhub/commhub.db "SELECT username, role FROM users WHERE role='admin'"
```

**Two-file state vs. `anet hub start` output**:

| `admin-utok.json` | `users` table admin row | `anet hub start` output |
|---|---|---|
| Present | Present | `✅ Admin already exists (admin-utok.json found, user=...)` |
| Missing | Present | `ℹ  Admin account "admin" already exists` (hub returns `username already taken`) |
| Missing | Missing | `✅ Admin account created` + `Admin token saved to ~/.anet/server/admin-utok.json` |
| Present | Missing (db wiped) | `✅ Admin already exists`, but `anet login` will fail — the marker and the db are out of sync; remove the marker and re-run start |

**Fix**:

```bash
# Symptom: admin-utok.json exists, but `anet login` fails
# → marker and db are out of sync. Remove the marker so the next start re-bootstraps.
rm ~/.anet/server/admin-utok.json
anet hub start                  # re-runs the register flow
anet login --username admin --password anethub
```

---

### 429 Rate limited (`too many requests` / `too many attempts`)

```
HTTP 429
{ "ok": false, "error": "too many requests, try again later" }    # register hit
{ "ok": false, "error": "too many attempts, try again later" }    # login hit
```

**Cause**: Too many requests from the same IP within the window.

| Endpoint | Limit | Hit message |
|------|------|---|
| `POST /api/auth/register` | 30/minute | `too many requests, try again later` |
| `POST /api/auth/login` | 10/minute | `too many attempts, try again later` (also writes audit `login_rate_limited`) |

::: info Only these two endpoints have IP rate limiting in v0.8
No other endpoint is currently IP-rate-limited. The `checkRateLimit` function's `default = 60` is a function-signature default, not actual behavior — the only call sites are register/login ([`server/src/index.ts:55`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L55); see R169 fix and [Security — Rate limiting](/en/concepts/security#rate-limiting)). If you're worried about write abuse on other endpoints, layer rate limiting at a reverse proxy (nginx / Cloudflare).
:::

**Solution**: Wait 60 seconds before retrying. Localhost / `::1` / `unknown` IPs are exempt ([`index.ts:57`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L57)). The response has **no** `retry_after_seconds` field and **no** `Retry-After` header; the window is a fixed 60 seconds.

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
The `cancel_task` / `retry_task` below are server-side MCP tools called via REST `POST /mcp` (or via an SDK) — **not** the Claude Code agent's stdio channel wrapper. The channel wrapper ([`channel/commhub-channel.ts`](https://github.com/sleep2agi/agent-network/blob/main/channel/commhub-channel.ts)) exposes only 5 `commhub_*` tools (`commhub_reply` / `commhub_report_status` / `commhub_send_task` / `commhub_send_message` / `commhub_get_all_status`). `cancel_task` / `retry_task` / `reassign_task` / `get_inbox` are admin / Dashboard ops, not part of the Claude Code chat-agent toolset ([`commhub-channel.ts:136-203`](https://github.com/sleep2agi/agent-network/blob/main/channel/commhub-channel.ts#L136)).
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
`get_inbox` is a server-side MCP tool called via REST `POST /mcp` (or via an SDK) — **not** the Claude Code agent's stdio channel wrapper. The channel wrapper exposes only 5 `commhub_*` tools (`commhub_reply` / `commhub_report_status` / `commhub_send_task` / `commhub_send_message` / `commhub_get_all_status`); `get_inbox` is intentionally left out because agents auto-poll the inbox via SSE — see [`channel/commhub-channel.ts:136-203`](https://github.com/sleep2agi/agent-network/blob/main/channel/commhub-channel.ts#L136).
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

### `quota exceeded: max N networks for free plan`

```json
{"ok": false, "error": "quota exceeded: max 2 networks for free plan"}
```

::: warning Still enforced in v0.8 (POST /api/networks for non-admin callers)
The older "plan quotas not enforced from v0.8 onward" claim is inaccurate. Verify [`auth.ts:184-190 createNetwork()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L184): it still looks up `users.plan || 'free'` in the `QUOTAS` table and gates `network create`. **Only `users.role = 'admin'` (the first registered user) is exempt** — that path sets `plan = "admin"` and uses `QUOTAS.admin`. Other users get `plan = 'free'` with `max_networks_owned = 2` by default (v0.8 did not change this default). The [Networks — Quota Limits](/en/concepts/networks#quota-limits-v0-6-design--currently-not-enforced) note about "plan tiers not enforced" actually refers to **no Dashboard plan-upgrade UI + no SaaS billing**, not "server no longer runs quota checks".
:::

**Trigger**: a non-admin user already owns the maximum number of networks (free = 2).

**Solution**:

```bash
# Option A (recommended): promote the user to admin (a system-admin op on the hub host)
# There's no public endpoint for this — edit SQLite directly:
sqlite3 ~/.commhub/commhub.db "UPDATE users SET role = 'admin' WHERE user_id = 'u_xxx';"
# After this, users.role='admin' → createNetwork uses plan='admin' → QUOTAS.admin (essentially unlimited)

# Option B: delete one of the extra networks
anet network ls           # find one to drop
anet network delete <old-net>
```

::: tip Why setting `users.plan = 'admin'` is not enough
[`auth.ts:185`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L185) actually checks `users.role === 'admin'`, not `users.plan`. A bare `UPDATE users SET plan = 'admin'` won't take effect — you must update the `role` column (the same system-admin gate that R195 documents for audit-log actions like `password_reset_by_admin`).
:::

---

## Agent Node Errors

### `Node "coder-1" already exists` -- local alias collision (`anet node create`)

```
Node "coder-1" already exists: .anet/nodes/coder-1/config.json
```

Verified at [`agent-network/bin/cli.ts:1067-1071`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1067) + [`agent-network/bin/cli.ts:1189-1193`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1189): both the interactive and non-interactive paths of `anet node create` call `resolveNodeRef(id)` to check whether `.anet/nodes/<alias>/config.json` already exists; if so, they `process.exit(1)` without ever contacting the hub.

**Cause**: a subdirectory with the same alias already exists under `.anet/nodes/` in the current project directory. This is a **local filesystem collision** — it has nothing to do with the hub-side session state.

**Solution**:

```bash
# List locally registered nodes (scans .anet/nodes/)
anet node ls

# Option A: pick a different name
anet node create coder-1-v2

# Option B: delete the old one and reuse the name
anet node delete coder-1
anet node create coder-1
```

::: warning Hub-side alias collisions are silently overwritten — there is no error
Contrary to common intuition, the hub server has **no** `alias is already taken` error. If you run two agents with the same alias from different machines or project dirs (i.e. with two distinct `resume_id`s), the later agent's `report_status` triggers [`server/src/tools.ts:127 DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2 AND network_id = ?3`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L127), which **silently evicts the previous session**. The older agent's SSE connection is still open but it no longer receives task dispatches, and the row disappears from the dashboard.

**So**: don't diagnose "my agent isn't showing up in the dashboard" as an "alias-taken error" — that error doesn't exist. First check for duplicate same-alias starts across machines (use `anet status` to inspect `resume_id` / version / hostname).
:::

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
