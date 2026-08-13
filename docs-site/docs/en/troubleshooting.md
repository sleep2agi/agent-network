# Troubleshooting

Debug in this order: environment → Hub → authentication → node → runtime → task. If an earlier layer is broken, later errors are usually secondary symptoms.

See the [CLI reference](/en/guide/cli) for complete syntax, [Production deployment](/en/deploy/production) for infrastructure, and [Runtimes](/en/guide/runtimes) for runtime-specific setup.

## Collect a minimal diagnostic first

Run these on the affected machine and from the affected project directory:

```bash
anet doctor
anet hub status
anet whoami
anet status
anet node ls
anet info <alias>
anet logs <alias> --follow
```

`doctor` checks configuration, Hub connectivity, node identity, and local dependencies. Do not begin with `doctor --fix`; read what it intends to change and back up the affected configuration first.

Before sharing logs, remove tokens, API keys, passwords, cookies, complete environment variables, and private Hub URLs. Do not upload all of `~/.anet`, `.anet/nodes/*/config.json`, or `.env`.

## Installation and startup

### `requires the Bun runtime` / `spawn bunx ENOENT` / Bun not found

The **preview** channel (`2.3.0-preview.x`) refuses before launch with a clear message:

```
❌ anet hub start requires the Bun runtime (commhub-server is bun-only …)
```

and exit with code 1.

🔴 **The `latest` channel (currently `2.2.21`) does not have that preflight yet** — there you still get a bare `Error: spawn bunx ENOENT` plus a Node stack trace. `npm i -g @sleep2agi/agent-network` installs `latest`, so for most readers the string below is **present tense, not history**.

`spawn bunx ENOENT` is what [#235](https://github.com/sleep2agi/agent-network/issues/235) removed **on preview**; the string is kept in this heading so people arriving from older versions — and everyone still on `latest` — find this section.

Agent Network CLI requires Node.js ≥ 22.13, and the Hub requires Bun ≥ 1.2:

```bash
node --version
bun --version
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

If a newly installed command is still missing, open a new shell and inspect `PATH`. For a global npm `EACCES` error, use nvm/fnm to manage Node instead of `sudo npm` or weakening system-directory permissions.

### `agent-node is not installed` / version check failed

```bash
agent-node --version
anet upgrade --dry-run
npm install -g @sleep2agi/agent-node
```

Upgrade on the selected release channel. Do not copy a fixed preview or package version from an old document. See [Versioning](/en/guide/versioning) and [Upgrading](/en/guide/upgrade).

### Port conflict or immediate Hub exit

```bash
anet hub status
curl http://127.0.0.1:9200/health
lsof -iTCP:9200 -sTCP:LISTEN
```

First determine whether the listener is an existing Hub. Stop an anet-managed instance with `anet hub stop`; do not kill processes by a broad name match. If you change the port, the Hub, CLI, and node configurations must all use the new URL.

## Hub and network connectivity

### `ECONNREFUSED`

Verify the Hub locally:

```bash
curl http://127.0.0.1:9200/health
anet hub status
```

Then test the configured URL from the node machine:

```bash
curl http://HUB_HOST:9200/health
```

If local access works but remote access does not, the Hub may be bound only to loopback, a firewall/security group may block the port, or the URL may be wrong. For cross-machine deployments, bind to a reachable address and protect public access with a TLS reverse proxy.

### `ETIMEDOUT` / DNS / TLS errors

Check resolution, routing, certificates, and proxies from the node machine, not only on the Hub host. Verify that the domain does not point to an old host and that an HTTPS reverse proxy can reach the backend `/health` endpoint.

### `SSE connection failed` / reconnect loop

First prove that ordinary health and login requests work, then inspect the node log. SSE is a long-lived connection: Nginx/Caddy/load balancers must not buffer the response or impose a short idle timeout. See [Production deployment](/en/deploy/production).

The task-push path is established only after the log reports `SSE connected`. Brief drops reconnect with backoff; persistent failures should be fixed at the proxy or identity layer rather than hidden by repeated restarts.

## Login, tokens, and networks

### `No hub configured`

```bash
anet init --hub http://HUB_HOST:9200
anet login
```

`~/.anet/config.json` stores the current Hub, user token, and network. Do not assemble tokens by hand or copy one from another machine.

### 401 `invalid token` / `auth required`

```bash
anet whoami
anet login
anet doctor
```

Old tokens become invalid after a Hub database rebuild, token revocation, or switching to another Hub. Log in again before checking nodes. A node must use its own `ntok_`; do not place a user `utok_` in node configuration.

For a legacy node config or rejected token, back up `.anet/nodes/<alias>/config.json`, read the `anet doctor` result, and only then decide whether to run:

```bash
anet doctor --fix
```

### Forgotten password

Run on the Hub host:

```bash
anet hub admin reset-user --username <username>
```

This generates a new password and user token and revokes old user tokens. Do not delete `users`, token rows, or bootstrap markers directly; that bypasses auditing and can corrupt related state.

### `network_id_required` / `access_denied` / `permission_denied`

- `network_id_required`: no unique network can be inferred. Log in/select the intended network, or pass `network_id` in calls that support it.
- `access_denied` / `permission_denied`: identity resolution succeeded, but the role cannot perform the operation. Ask the network owner to change membership; a global admin is not automatically every network's owner.
- Agent Nodes use an `ntok_` bound to one network. Do not reuse a node token across networks.

See [Tokens and permissions](/en/concepts/tokens), [Roles](/en/concepts/roles), and [Networks](/en/concepts/networks).

### Other authentication/network errors

<a id="quota-exceeded-max-n-networks-for-free-plan"></a>
<a id="license-expired-license-expired-legacy-behavior"></a>

| Error | Safe response |
|---|---|
| `password must be at least 8 characters` / `too common` | Choose at least eight characters and avoid the weak-password list |
| 429 / `too many attempts` | Stop retrying and wait for the indicated window; correct the credential before trying again |
| `network name already exists` | Inspect current networks and choose another name; do not edit the database |
| `network has N active session(s)` | Use `anet status`, stop the nodes normally, then retry network deletion |
| `quota exceeded` | Use `anet network ls` and remove unused networks. There is currently no public CLI for changing a user plan/global role; contact the Hub operator and do not promote the user to global admin as a shortcut |
| `license_expired` | If it remains after `anet license` and an upgrade, contact the Hub operator. There is no safe public CLI for cleaning legacy rows; stop the Hub, back up the database, and file a redacted diagnostic instead of deleting `licenses` rows online |

Direct database writes bypass API authorization, auditing, and consistency checks and can corrupt related license or identity state, so this guide does not provide SQL “fixes.”

## Agent Node

### Node remains offline / receives no tasks

Verify in order:

1. The node machine can reach Hub `/health`.
2. `anet whoami` points to the intended Hub and network.
3. `anet info <alias>` shows the correct runtime, working directory, and identity.
4. `anet logs <alias> --follow` eventually reports `SSE connected`.
5. No other process uses the same alias, `node_id`, or `ntok_`.

Restart one node safely:

```bash
anet node stop <alias>
anet node start <alias>
```

Do not copy a node `config.json` to another machine. Log in and run `anet node create` on the target so the Hub issues a separate identity.

### Duplicate results / changing runtime / `alias_identity_mismatch`

This usually means multiple processes or old configs use one identity:

```bash
anet info <alias>
anet logs <alias> --follow
tmux ls
```

Stop old instances and keep one process. Do not reclaim identity by editing `node_id`, alias, token, or the Hub database. Use `anet node rename` for renaming.

`Node "<alias>" already exists` usually means the current project already has that local config under `.anet/nodes/`. Inspect it with `anet node ls` / `anet info <alias>` before reusing it; do not delete the directory merely to recreate the name.

### Wrong working directory

File tools use the node's launch directory. Stop it, enter the intended project, and start again. In Codex TUI co-presence, the thread directory is inherited from the app-server process. Follow [Codex TUI co-presence](/en/guide/codex-copresence) and inspect the full session group, not only the bridge.

<a id="vendor-api-auth-failure-401-invalid-api-key-expired-token-intern-a02xx-user-token-expired"></a>
<a id="vendor-api-timeout-high-concurrency-fan-out-132-retry-with-backoff"></a>
<a id="grok-build-acp-node-task-hangs-session-prompt-timed-out-after-300000ms-json-rpc-error-32603"></a>

## Runtime and model

Confirm that the configured runtime exists on the installed release channel:

```bash
anet info <alias>
anet logs <alias> --follow
anet upgrade --dry-run
```

| Symptom | Check |
|---|---|
| Claude/Codex command missing | The corresponding CLI is installed, is in the node process `PATH`, and is authenticated |
| Vendor 401/403 | API key, envRef target, and `ANTHROPIC_BASE_URL` belong to the same service |
| Vendor timeout/rate limit | Service status, account quota, and node concurrency; do not burn quota with unbounded retries |
| Long Grok ACP task times out | Check `flags.grokAcpTimeoutMs` / `GROK_ACP_TIMEOUT_MS` in the runtime guide |
| Codex co-presence recovers as a normal node | Continue using `anet node start <alias> --copresence`, not plain start |

OpenCode is currently a task runtime, not a shared TUI. Shared Grok TUI support has not shipped. Follow [Runtimes](/en/guide/runtimes), not old versions or historical changelog commands.

## Tasks and messages

### Work does not invoke the model

Executable work must use `send_task`. `send_reply` is a task result and `send_message` is ordinary chat; neither invokes the model again.

```bash
anet status
```

Confirm that the target node is online, the task is in the current network, and the alias is correct. See [Task lifecycle](/en/concepts/task-lifecycle) for status, retry, and parent-child semantics.

### `task not found` / `message not found`

The current token/network may not own the object, or a message may belong to another node. Start with `anet whoami` and `anet status`; do not bypass network isolation by querying or editing SQLite directly.

### Scheduled task did not run

```bash
anet goal list <alias>
anet info <alias>
```

Recurring goals require an online node and consume real model quota. They are not a high-precision cron service; validate with a conservative interval.
Inspect `next_wake_at`, failure entries, and `paused` status with `goal show` / `wake-log`. See [Goals and Loops](/en/guide/goals-and-loops) for the full behavior.

## Channels

```bash
anet channel status <alias>
anet logs <alias> --follow
```

Check the bot token, pairing/allowlist, target node, and channel runtime. Telegram uses long polling; reverse-proxy webhook settings do not apply to it. See [Channels](/en/guide/channels) for current support and restart requirements.

## Docker

```bash
docker compose ps
docker compose logs --tail=200 <service>
```

Check Hub health, persistent volumes, the Hub URL inside the container, token files, and model-credential mounts. Inside a container, `localhost` refers to that container, not the host.

Do not run `docker system prune`, `docker image prune -a`, or broad name-pattern cleanup on a shared host. Resolve containers and exact image references first.

## Still unresolved

Include the following in an issue:

- `anet -v`, Node/Bun versions, and release channel
- runtime, operating system, and deployment method
- minimal reproduction and exact error
- redacted excerpts from `anet doctor`, `anet info`, and relevant logs

Search [Issues](https://github.com/sleep2agi/agent-network/issues) first. Report security problems through a [GitHub Security Advisory](https://github.com/sleep2agi/agent-network/security/advisories/new), not a public issue.
