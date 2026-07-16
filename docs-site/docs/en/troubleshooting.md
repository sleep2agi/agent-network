# Troubleshooting

Quickly identify problems and solutions based on error messages.

For `anet doctor`, Telegram channel setup, MCP tool injection, or codex-sdk active `send_task`, start with the dedicated runbook: [Connectivity / Channels / MCP](/en/troubleshooting/connectivity-channels-mcp).

::: tip Not a failure — just curious about versions?
See [Versioning](/en/guide/versioning) to map the npm-package versions printed by `anet -v` onto `v0.10.x` bundle releases. To upgrade, follow the [Upgrade Guide](/en/guide/upgrade).
:::

## Startup Errors (most common on first run)

### `anet hub start` -- `spawn bunx ENOENT`

```
Error: spawn bunx ENOENT
```

**Cause**: **Bun** is not installed. `commhub-server` is Bun-shebang TypeScript, and `anet hub start` launches it via `bunx --bun` — without Bun it crashes on the very first step.

**Fix**:

```bash
npm i -g bun
# or: curl -fsSL https://bun.sh/install | bash
bun --version        # should print 1.2.x or newer
```

Then run `anet hub start` again. Full prerequisites: [Getting Started · Prerequisites](/en/guide/getting-started). ([#235](https://github.com/sleep2agi/agent-network/issues/235) tracks a friendly pre-start check.)

---

### `anet node start` -- `agent-node is not installed or cannot report a version`

```
agent-node is not installed or cannot report a version. Run: anet upgrade
```

**Cause**: the `claude-agent-sdk` / `codex-sdk` runtimes depend on the `agent-node` package. It's designed to lazy-fetch via npx on the first `node start`, but the current startup check **doesn't wait for the fetch** and exits with this error ([#450](https://github.com/sleep2agi/agent-network/issues/450); #237 is the umbrella).

**Fix**: install it once, then start:

```bash
npm i -g @sleep2agi/agent-node
agent-node --version     # should print the current latest or newer
anet node start <name>
```

> The `claude-code-cli` / `grok-build-acp` runtimes don't hit this (they don't use the `agent-node` SDK-adapter path).

---

## Connection Errors

### `ECONNREFUSED` -- Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:9200
```

**Cause**: CommHub Server is not running.

**Solution**:

```bash
# Check if the server is running (v0.10.11+ recommended; one line shows PID + port + /health version)
anet hub status                # default port 9200
anet hub status --port 9201    # non-default port

# Or fall back to curl /health (works on older versions too)
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

**Solution**: The agent will auto-reconnect (since [#202](https://github.com/sleep2agi/agent-network/issues/202): exponential backoff `1s → 30s` cap + re-register on every successful (re)connect + give up after 1h continuous failure — [see agent-node reconnection](/en/guide/agent-node#reconnection)); no manual intervention usually needed.

If it persists:

```bash
# Check if the server is running (v0.10.11+ recommended; one line shows PID + port + /health version)
anet hub status

# Or fall back to curl /health
curl http://localhost:9200/health

# Check if the token is valid
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status

# Check reverse proxy config (if applicable)
# Nginx needs:
# proxy_read_timeout 86400;
# proxy_buffering off;
```

### Dashboard shows no nodes after a hub restart

**Symptom**: After `anet hub stop` + `anet hub start` (or after the hub process crashes and restarts), the Dashboard shows every node as `offline` or missing from the list entirely — even though the agent processes are still alive.

**Cause (v0.10.10 and earlier)**: The hub restart clears its in-memory sessions table. Older `agent-node` versions only restored the event stream on reconnect; they **did not re-send `register`** — so the hub-side sessions table only rebuilt on the next 3-minute heartbeat, leaving the Dashboard blank in between.

**Solution**: Since [#202](https://github.com/sleep2agi/agent-network/issues/202), every successful SSE reconnect immediately re-fires `register` (idempotent upsert on the hub), and the Dashboard recovers the full node list within ~30s. **No `anet project restart` needed**; pair this with the `anet hub stop` / `hub status` commands for a one-shot maintenance SOP. If you're on an older agent-node, run `anet upgrade` to pick up the fix on npm `latest`.

---

## Auth Errors

### `No hub configured. Pass --hub <url> or run 'anet init' first.`

**Symptom**: on a fresh install, your first `anet login` (or the `anet login --username admin --password anethub` suggested by `anet hub start`) fails with this — you can't log in.

**Cause**: `anet hub start` only launches the hub; it does **not** write the hub URL into your global config. But `anet login` needs to know which hub to reach — the "set the hub URL" step (done by `anet init` or `--hub`) is missing in between.

**Fix**: pass `--hub` directly at login (a local hub defaults to `127.0.0.1:9200`):

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
```

Or run `anet init --hub <url>` first, then `anet login`. For a remote hub, use its IP.

---

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
# Have the owner (not admin — admin can't change roles; PUT members is an owner-only gate)
# call REST to promote you (v0.10.x stable still does not expose a CLI promote subcommand — the v0.9.x and v0.10.x scopes did not touch member-role management; queued for v0.11+ / unscheduled):
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
This gate is a V3-era leftover still firing in the `send_task` path (verify [`server/src/tools.ts:616`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L616) where `license_expired` is emitted; same file L611 has `SELECT type, expires_at FROM licenses`). It triggers when your local SQLite has a `licenses` row with `expires_at` in the past. **The v0.9.x and v0.10.x scopes did not touch this** (Recovery & Observability took priority); full removal is queued for v0.11+ / unscheduled.
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
# When you can't pass a CLI flag (Docker / systemd), the env var is equivalent:
# COMMHUB_DEV_OPEN=1 anet hub start
# (verify [`index.ts` `DEV_OPEN`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts): either the `--dev-open` flag or `COMMHUB_DEV_OPEN=1` works)
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

**Exception (first registered user only)**: [`auth.ts:43-44`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L43) detects the "first user" case and only enforces `length >= 4` (so the bootstrap `admin / anethub` flow works). `anet passwd` / `reset-user` have **no such exemption** — they always require ≥ 8 + non-weak.

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
Verified at [`agent-network/bin/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts): `anet hub start` simply POSTs `/api/auth/register` with username=`admin` and password=`anethub` (unless overridden by `--username` / `--password`). **No interactive prompt is involved**, so the older "repeating prompt" framing in this doc is stale and has been removed.

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
No other endpoint is currently IP-rate-limited. The `checkRateLimit` function's `default = 60` is a function-signature default, not actual behavior — the only call sites are register/login ([`index.ts` `checkRateLimit()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts); see [Security — Rate limiting](/en/concepts/security#rate-limiting)). If you're worried about write abuse on other endpoints, layer rate limiting at a reverse proxy (nginx / Cloudflare).
:::

**Solution**: Wait 60 seconds before retrying. Localhost / `::1` / `unknown` IPs are exempt ([`index.ts` `checkRateLimit()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)). The response has **no** `retry_after_seconds` field and **no** `Retry-After` header; the window is a fixed 60 seconds.

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

# Then delete (--force is required, otherwise it only prints a confirmation prompt)
anet network delete my-network --force
```

---

### `quota exceeded: max N networks for free plan`

```json
{"ok": false, "error": "quota exceeded: max 2 networks for free plan"}
```

::: warning Still enforced in v0.8 (POST /api/networks for non-admin callers)
The older "plan quotas not enforced from v0.8 onward" claim is inaccurate. Verify [`auth.ts` `createNetwork()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts): it still looks up `users.plan || 'free'` in the `QUOTAS` table and gates `network create`. **Only `users.role = 'admin'` (the first registered user) is exempt** — that path sets `plan = "admin"` and uses `QUOTAS.admin`. Other users get `plan = 'free'` with `max_networks_owned = 2` by default (v0.8 did not change this default). The [Networks — Quota Limits](/en/concepts/networks#quota-limits) note about "plan tiers not enforced" actually refers to **no Dashboard plan-upgrade UI + no SaaS billing**, not "server no longer runs quota checks".
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
anet network delete <old-net> --force
```

::: tip Why setting `users.plan = 'admin'` is not enough
[`auth.ts:185`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L185) actually checks `users.role === 'admin'`, not `users.plan`. A bare `UPDATE users SET plan = 'admin'` won't take effect — you must update the `role` column (the same system-admin gate that applies to audit-log actions like `password_reset_by_admin`).
:::

---

## Agent Node Errors

### `Node "coder-1" already exists` -- local alias collision (`anet node create`)

```
Node "coder-1" already exists: .anet/nodes/coder-1/config.json
```

Verified at [`agent-network/bin/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) + [`agent-network/bin/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts): both the interactive and non-interactive paths of `anet node create` call `resolveNodeRef(id)` to check whether `.anet/nodes/<alias>/config.json` already exists; if so, they `process.exit(1)` without ever contacting the hub.

**Cause**: a subdirectory with the same alias already exists under `.anet/nodes/` in the current project directory. This is a **local filesystem collision** — it has nothing to do with the hub-side session state.

**Solution**:

```bash
# List locally registered nodes (scans .anet/nodes/)
anet node ls

# Option A: pick a different name
anet node create coder-1-v2

# Option B: delete the old one and reuse the name (delete needs --force, otherwise it only prints a confirmation prompt)
anet node delete coder-1 --force
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

### Vendor API auth failure (401 / `invalid_api_key` / `expired_token` / intern `A02xx` / `user_token_expired`)

You see this in the agent log:

```
[claude] ✗ FATAL: vendor API auth failed (...)
[anet] FATAL: Vendor API auth failed — ...
[anet]        → Refresh INTERN_S1_API_KEY at https://chat.intern-ai.org.cn and re-export it
```

**Cause**: The upstream vendor LLM API returned an auth-class error (401/403, `invalid_api_key`, `authentication_error`, intern's `A02xx` code family, OpenAI-compat `expired_token` / `unauthorized`, etc.).

**Fast-fail behavior since v0.9.2** ([#129](https://github.com/sleep2agi/agent-network/issues/129); verify [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts)):
- agent-node uses the `isAuthError(msg)` heuristic (regex: `(401|403)\b|invalid[_\s]?api[_\s]?key|authentication[_\s]?error|expired[_\s]?token|unauthor(iz|is)ed|A02\d{2}|user[_\s]?token[_\s]?expired`)
- **Short-circuits the retry loop** (no point retrying with the same bad key, wasting the backoff window) — before v0.9.1 you'd wait 3 attempts × 5min = 15 minutes before getting a useful error; v0.9.2+ returns **FATAL in under 5 seconds**
- Picks a **vendor-specific remediation hint** by `ANTHROPIC_BASE_URL` host match:
  - `intern-ai.org.cn` → `https://chat.intern-ai.org.cn`
  - `minimax` → `https://platform.minimaxi.com`
  - `anthropic` → `https://console.anthropic.com/settings/keys`
  - otherwise → generic "Refresh your vendor API key and re-export the ENV var"

**Solution** (look for the vendor URL in the log, then):

```bash
# 1. Get a fresh API key from the vendor's platform (URL in the log)

# 2. Update the ENV var
export ANTHROPIC_AUTH_TOKEN='<new-key>'

# 3. Restart the agent so the new value takes effect (agent-node reads process.env at startup, no hot reload)
anet node stop <alias>
anet node start <alias>

# 4. If you're on envRef mode (recommended, see /en/concepts/security#vendor-credential-storage-envref-mode-v0-9-0):
#    config.json is unchanged (it stores the env-var NAME), just re-export the new value and restart the agent.
```

### Vendor API timeout (high-concurrency fan-out, #132 retry-with-backoff)

You see this in the agent log:

```
[claude] attempt 1/3 timed out after 300000ms; retry in 4000ms
[claude] attempt 2/3 errored: ...; retry in 8000ms
[claude] ✗ all 3 attempts failed; last: timed out after 300000ms
```

Or finally:

```
执行出错: claude-agent-sdk 调用超时 (300s × 3 attempts) — vendor 长时间未响应, 检查 ANTHROPIC_BASE_URL endpoint 或 vendor 负载
```

**Cause**: under heavy fan-out (e.g. [#132 Tier 1's](https://github.com/sleep2agi/agent-network/issues/132) 30-agent papercope demo), per-request latency on the vendor API stretches from a 1.57s baseline to 17-37s as requests pile up in the vendor's queue.

**Retry-with-backoff since v0.9.2** (verify [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts)):
- Each attempt has its own abort controller + timeout window (default `CLAUDE_TIMEOUT_MS=300000`, i.e. 300s — see [#132 ship](https://github.com/sleep2agi/agent-network/issues/132))
- On transient errors / timeouts, backoff `4s, 8s` + 0-1s jitter (the jitter spreads herd retries so the recovering vendor queue isn't slammed all at once)
- Default `CLAUDE_MAX_RETRIES=2` (so 3 attempts total including the initial one) — set `0` to revert to v0.9.1 behavior (no retry)
- **Auth-class errors do not retry** (fast-fail above)

**Tuning**:

```bash
# config.json field
{
  "flags": {
    "claudeTimeoutMs": 600000,   // raise per-attempt timeout to 600s
    "claudeMaxRetries": 5        // retry up to 5 times (6 attempts total)
  }
}

# Or via ENV
CLAUDE_TIMEOUT_MS=600000 CLAUDE_MAX_RETRIES=5 anet node start <alias>
```

If timeouts persist, the root cause is usually vendor capacity. Shard horizontally across multiple vendors and stagger startup (`--stagger` on `anet project up`, [#117](https://github.com/sleep2agi/agent-network/issues/117)).

### `codex-direct-stdio` opt-in path errors (v0.10.0+, only when `ANET_CODEX_STDIO_DIRECT=1`)

v0.10.0 [#141](https://github.com/sleep2agi/agent-network/issues/141) introduces a direct stdio JSON-RPC client path that bypasses the `@openai/codex-sdk` wrapper — errors surface more directly (no wrapper buffer), but you now face the `codex` binary + `codex app-server` protocol straight on.

**1. `Error: spawn codex ENOENT` (immediate failure after opt-in)**

agent-node can't find the `codex` binary — the opt-in path **spawns directly**, there's no `@openai/codex-sdk` fallback.

```bash
# Check
which codex
# If empty, install:
npm install -g @openai/codex

# Or if the npm global bin isn't on PATH, see runtimes § codex-sdk PATH fix.
```

Fall back to the wrapper path (drop the env var):

```bash
unset ANET_CODEX_STDIO_DIRECT
anet node start <codex-node>
```

**2. `codex app-server` subcommand missing / `unknown subcommand: app-server`**

Older codex CLI versions don't have `codex app-server` ([#141](https://github.com/sleep2agi/agent-network/issues/141) verified against codex `0.130.0+`). Upgrade:

```bash
npm install -g @openai/codex@latest
codex --version  # expect ≥ 0.130.0
codex app-server --help  # should print subcommand help, not "unknown subcommand"
```

If you can't upgrade, fall back to the wrapper: `unset ANET_CODEX_STDIO_DIRECT`.

**3. `JSON-RPC parse error` / `-32600` invalid request**

Stdio protocol mismatch — usually from a codex CLI version that's older or newer than what anet expects (experimental status means the protocol can break). Reproducer + fix:

```bash
# Inspect the protocol handshake
ANET_CODEX_STDIO_DIRECT=1 LOG_LEVEL=debug anet node start <codex-node> 2>&1 | grep -iE "initialize|protocolVersion|error"

# If you see a protocolVersion mismatch
npm install -g @openai/codex@latest

# Temporary fallback to the wrapper:
unset ANET_CODEX_STDIO_DIRECT
```

If the codex CLI is already at latest but it still errors, please file an issue with the debug output above and `codex --version`. [#141](https://github.com/sleep2agi/agent-network/issues/141) is still inside the preview-feedback window (v0.11.0 plans the default flip), so protocol-break is a known risk + mitigation path.

### Dashboard agent hover card shows `process_telemetry` as `null` (shipped since v0.10.0, dashboard 0.5.0+)

The dashboard `≥ 0.5.0` §3.E hover detail card expects agent-node `≥ 2.4.0` ([#142](https://github.com/sleep2agi/agent-network/issues/142) — v0.10.0 ship made the agent emit `process_telemetry` on every heartbeat) plus commhub-server `≥ 0.8.2` (schema align). Three possible causes:

- **agent-node older than 2.4.0**: run `anet upgrade` to pull the current latest (satisfies the ≥ 2.4.0 minimum)
- **commhub-server older than 0.8.2**: upgrade the server (`bunx @sleep2agi/commhub-server@latest`)
- **Agent hasn't reported a heartbeat yet**: `process_telemetry` rides on the same heartbeat as host telemetry — a freshly started node needs ~15s

Verify the real data flow:

```bash
curl http://localhost:9200/api/server/<host>/agents \
  -H "Authorization: Bearer ntok_xxx" | jq '.agents[0].process_telemetry'
# Expect non-null rss_bytes / cpu_pct / uptime_seconds / in_flight_count
```

### `grok-build-acp` node task hangs / `session/prompt timed out after 300000ms` / JSON-RPC error 32603

**Symptom**: A node created with the `grok-build-acp` runtime accepts a task longer than ~5 min via CommHub and then never reports back. No error, no reply — the pane is stuck on a `session/prompt` call. The agent-node log shows either `session/prompt timed out after 300000ms` or a JSON-RPC `code: 32603` returned by the ACP server.

**Root cause**: agent-node 2.4.8 and below hard-coded a 300 s `session/prompt` timeout (inherited from the older codex-sdk wrapper). The grok-build-acp backend, however, is biased toward longer user-level tasks where 5 min is routinely too tight.

**Fix**: Run `anet upgrade` to the current latest (the hotfix landed in `agent-node 2.4.9` / v0.10.13 and is in every later version) — it widens the client-side `session/prompt` timeout to match the grok backend's real working window. Live-tested in-house: tasks of 47 s / 5 min / >10 min all complete normally.

```bash
# 1. Upgrade
anet upgrade            # one-shot
# or: npm install -g @sleep2agi/agent-node@latest

# 2. Restart the grok node
anet node stop grok-marketing && anet node start grok-marketing

# 3. Verify
anet --version          # agent-node ≥ 2.4.9
```

**Genuinely long jobs still hit the cap (video generation / large X searches)**: the 300 s default in the current latest is still too tight for some video or batch workloads. Bump it via `flags.grokAcpTimeoutMs` (config) or `GROK_ACP_TIMEOUT_MS` (env, takes precedence):

```bash
# Per-shell (export before starting the grok node)
GROK_ACP_TIMEOUT_MS=900000 anet node start my-grok
```

```json
// Persistent (in .anet/nodes/<alias>/config.json)
{
  "runtime": "grok-build-acp",
  "flags": { "grokAcpTimeoutMs": 900000 }
}
```

Full detail: [runtimes → Long-task timeout tuning](/en/guide/runtimes#long-task-timeout-tuning-flags-grokacptimeoutms).

::: warning Startup log follows the current latest
Older agent-node versions **do not print** `timeoutMs=<new value>` at startup — the value is read but not surfaced in `anet node start` output. If you set it and tasks still time out, the config is likely in the wrong file or the env-var name has a typo; upgrade to npm `latest` first, then [open an issue](https://github.com/sleep2agi/agent-network/issues/new).
:::

**Still hangs?** Rule out: the grok backend quota is exhausted (grok's own `~/.config/grok-build/` log will hint at it) / the node `cwd` is outside the user-workspace boundary ([#204](https://github.com/sleep2agi/agent-network/issues/204) isolated cwd boundary) / `grok login` credentials expired.

### Hub box load is abnormally high / new claude sessions are slow / piles of zombie `bun` processes

**Symptom**: The machine hosting the hub shows a sustained high load average (>10× the CPU core count). Opening new claude / agent sessions feels slow, and CommHub MCP calls occasionally time out. `top` shows lots of `bun ... server.ts` processes that look like they're doing nothing.

**Root cause**: A plugin directory or agent workdir was renamed or deleted while older `bun` child processes still held its now-`deleted` cwd. Every new session forks another zombie on top, and they accumulate until they saturate the CPU. **Real-world repro**: 86 zombie `bun` processes, load average 92.

**Detect** (one-liner):

```bash
for pid in $(pgrep -f "bun.*server.ts"); do readlink /proc/$pid/cwd; done | grep deleted | wc -l
```

`>5` means something is wrong. To see exactly which PIDs:

```bash
for pid in $(pgrep -f "bun.*server.ts"); do
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null)
  [[ "$cwd" == *deleted* ]] && echo "PID $pid → $cwd"
done
```

**Fix**:

```bash
# Kill every bun process whose cwd points to a deleted dir
for pid in $(pgrep -f "bun.*server.ts"); do
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null)
  [[ "$cwd" == *deleted* ]] && kill -9 $pid
done

# Or, if you know what you're killing, blow the whole pgrep set away
pkill -9 -f "bun.*server.ts"
```

Then restart whatever agent / hub processes you needed.

**Prevent**: Kill the corresponding `bun` child process **first** (`anet node stop <name>` or a manual `kill`) before renaming / deleting a plugin directory or agent workdir.

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

It checks: global config + auth token, hub reachability (version / sessions / SSE), each node's config health (legacy fields get a `--fix` migration hint), plain-secret hygiene ([#125](https://github.com/sleep2agi/agent-network/issues/125)), and required CLIs (Claude Code / Codex / Bun). Add `--fix` to auto-migrate repairable node configs and re-issue any `ntok_` the hub rejects.

### Manual Checklist

```bash
# 1. Server health (includes SSE connection count + sessions / license / uptime, no auth required)
curl http://localhost:9200/health
# Key fields: ok / version / sessions_count / sse_connections / sse_sessions / uptime
# Verified at the `GET /health` handler in index.ts

# 2. Valid auth + summary of all session states
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/status
# Returns sessions[] (full list) + summary { idle, working, offline, total }
# ⚠ The status query param is NOT honored — the server does not filter by status
#   (the `GET /api/tasks` handler in index.ts). Filter idle agents locally with jq:
#   curl ... /api/status | jq '.sessions[] | select(.status=="idle")'

# 3. Database size
ls -lh ~/.commhub/commhub.db

# 4. Task / node / session aggregates (NOT the SSE connection count)
curl -H "Authorization: Bearer ntok_xxx" http://localhost:9200/api/stats
# Returns tasks { total, by_status } / sessions { by_status } / nodes { total } / recent_tasks[5]
# Verified at server/src/index.ts:1022-1058
```

::: tip Full 30+ endpoint index
See [REST API → metadata table](/en/api/rest) for the full endpoint catalog (11 categories including SSE / Tmux opt-in / Legacy etc.).
:::

### Log Levels

Agent Node supports adjustable log levels (**top-level field — not nested under `flags`**):

```json
// config.json (.anet/nodes/<alias>/config.json)
{
  "logLevel": "debug"   // debug / info / warn / error
}
```

Verified at [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts): `LOG_LEVEL` is read from `opts["log-level"] || process.env.LOG_LEVEL || fileConfig.logLevel || "info"` — it **only honors the top-level `logLevel`**. Putting `logLevel` inside `flags` has no effect.

You can also set it via environment variable or CLI flag:

```bash
LOG_LEVEL=debug anet node start <alias>
# or
anet node start <alias> --log-level debug
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
