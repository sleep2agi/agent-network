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
| `anet init project` | Configure Claude Code project (`project` is a literal subcommand, not a placeholder) | verified |
| `anet setup` | Interactive wizard to install runtime dependencies (pick claude CLI / agent-node / codex CLI / commhub-server as needed) | verified |

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
| `anet logout` | Log out (clears the token from `~/.anet/config.json` locally; the token still works server-side — use `anet token revoke` for full invalidation) |
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
| `anet token create <name>` | Create an API token (token is shown **once**; save it immediately) |
| `anet token` / `anet token ls` | List all tokens (default subcommand = ls) |
| `anet token revoke <id>` | Revoke a token (immediate server-side invalidation) |

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
| `anet node rename <old> <new>` | Rename an agent — ⚠ **The node must have been `anet node start`ed at least once** (so a sessions row exists on the commhub server). Purely-created nodes that have never started will fail at the `prepareRename` step with `node not found in network`, [#110](https://github.com/sleep2agi/agent-network/issues/110). Workaround: run `anet node start <old>` once so the server registers it, then `stop` and rename. Fail-safe (PHASE 1 rollback — the old node stays intact) |
| `anet node migrate-token-to-envref <name>` | Migrate plain-secret env values in this node's `config.json` (detected by key suffix `_TOKEN`/`_KEY`/`_SECRET`/`AUTH` or value prefix `sk-`/`utok_`/`ntok_`/`atok_`/`ak-`/`gsk_`/`key-`/`Bearer `) to the envRef shape `{ _envRef: "<KEY>_<NODE_SUFFIX>" }`, so secrets no longer persist on disk. Writes a `config.json.bak-<ts>` backup and prints the `export` lines you need to set the env variables. See [Security — Vendor Credential Storage envRef mode](/en/concepts/security#vendor-credential-storage-envref-mode-v0-9-0) + [Tokens — envRef](/en/concepts/tokens) ([#125](https://github.com/sleep2agi/agent-network/issues/125)) |
| `anet node delete <name>` | Delete an agent (interactive confirm by default; add `--force` or `--yes` to skip; **does not auto-revoke the `ntok_`** — pair with `anet token revoke <id>` for full cleanup, see [Token lifecycle](/en/concepts/tokens#token-lifecycle-matrix)) |

### Session binding (`claude-code-cli` runtime)

Only the `claude-code-cli` runtime touches Claude Code sessions (`~/.claude/projects/<cwd>/*.jsonl`); the `claude-agent-sdk` / `codex-sdk` runtimes have no Claude Code session semantics.

| Command | Description |
|------|------|
| `anet node create <name> --resume <id>` | Create a node bound to a **specific session** (errors out and exits if the id is unknown, [`cli.ts:1629-1634`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1629)) |
| `anet node create <name> --resume-latest` | Create a node bound to the **most recent session** (`listClaudeSessions()[0]`, [`cli.ts:1637-1644`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1637)) |
| `anet node create <name>` | Interactive picker on TTY (age / size / 60-char first-line preview, [`cli.ts:1645-1651`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1645)); non-TTY falls back to a random session id |
| `anet node start <name> --new-session` | Force a **fresh** session (overrides `profile.session`) |
| `anet node resume <name> [--session <id>]` | Resume a session (see [anet node resume](#anet-node-resume)) |
| `anet session ls` | List Claude Code sessions in the current cwd (the picker and `ls` share [`listClaudeSessions()` cli.ts:103](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L103)) |

> **Zero-keystroke recovery:** since #115, `anet node start` injects `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999` ([`cli.ts:1960`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1960)) into the `claude` spawn env, skipping Claude Code's default 70-minute session-age threshold for the "Resume from summary / full / Don't ask again" interactive prompt — so **restarting a batch of nodes needs no per-node keypress**. The injection is per-spawn, does not touch `~/.claude/settings.json`, and respects an explicit user override. Resume restores the **full session** as-is (no per-invocation flag forces a compact summary; per the #115 commit message, restart-recovery is safer without unexpected compaction).

### Project-wide (cwd)

Scans every node under the current cwd's `.anet/nodes/` and starts / restarts / stops them as a batch. See [issue #117](https://github.com/sleep2agi/agent-network/issues/117) and verify [`cli.ts:3000 projectCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3000).

| Command | Description |
|------|------|
| `anet project up` | Start every node (skip already-running, idempotent; ▶ started / ⏭ already-running) |
| `anet project restart` | Kill existing tmux + start fresh per node (↻ restarted / ▶ started) |
| `anet project down` | Stop every node (kill tmux + notify hub offline; ⏹ stopped) |

**Shared options:**

| Option | Default | Description |
|------|------|------|
| `--stagger <seconds>` | `3` | Delay between nodes; `0` disables |
| `--only a,b,c` | — | Operate only on these aliases or node IDs |
| `--exclude x,y` | — | Skip these aliases or node IDs |

> **`down` caps the hub-offline notify at a 2-second timeout** (cli.ts:3085-3088) — this command is commonly used in the "hub itself crashed" scenario, where serially fetching offline notifications for 22 nodes would hang on 44 timeouts and deadlock the teardown; the 2 s race guarantees a fast worst-case teardown.

### Monitoring

| Command | Description |
|------|------|
| `anet status` | Network overview (online agents + task stats) |
| `anet tasks [status]` | View task list |
| `anet doctor` | System diagnostics (add `--fix` to auto-probe and re-issue expired `ntok_` back to the node config) |

### Demo (multi-agent showcase)

| Command | Description |
|------|------|
| `anet demo ls` | List available demos |
| `anet demo debate [opts]` | **Debate**: 6-role (host / pro × 2 / con × 2 / judge) one-command 9-step debate |
| `anet demo socialmedia [opts]` | **Social media content factory**: 4 roles (topic / copy / image / reviewer), ~3 min |
| `anet demo pr-review [opts]` | **Code PR review room**: 4 roles (3 reviewers — security / perf / style — running in parallel + judge), ~2 min |
| `anet demo sci-team [opts]` | **Research squad**: 1 leader + N-1 workers (default 10, tunable 5-50) actively fanning out to collaborate |

See [Debate Demo case](/en/cases/debate). For the others, run `anet demo <name> --help` for usage.

### Channel Management

| Command | Description |
|------|------|
| `anet channel add <type>` | Add a channel (telegram/wechat/feishu) |
| `anet channel ls` | List channels |

### Other

| Command | Description |
|------|------|
| `anet config` | **Read-only** view of `~/.anet/config.json` (`anet config path` prints the path, `anet config json` prints raw JSON). To modify config, use `anet login` / `anet init` / `anet network use` — there is no `anet config --set`. Verified at [`cli.ts:5670-5702 configShowCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5670). |
| `anet upgrade` | Prints an upgrade plan (self-upgrade is disabled by default to avoid replacing the running CLI process mid-run; gives manual steps). Full guide: [Upgrade Guide](/en/guide/upgrade) |
| `anet create --batch` / `anet batch <verb>` | Spin up N agents in bulk (auto-numbered prefix + separate workdir/config/tmux), then manage their lifecycle with `anet batch list/start/stop/restart/cleanup`. See [Batch Agents](/en/guide/batch) |
| `anet license` | v0.6 legacy: view trial / license status. **No longer needed after Apache 2.0 OSS**; Hub keeps the `licenses` table + `send_task` 14-day trial check for backward-compat |
| `anet activate <key>` | v0.6 legacy: write a pro license key. **No longer needed after Apache 2.0 OSS**; last-resort fix for `license_expired` — see [troubleshooting](/en/troubleshooting) |
| `anet session ls` | List Claude Code sessions in the current project (for the `claude-code-cli` runtime) |
| `anet import [alias]` | Import claude-code agent sessions from CommHub into local `.anet/nodes/<alias>/config.json` (imports all if no alias is given) |
| `anet run` | Starts a **minimal standalone SSE agent** via the Client SDK: connects to the hub, listens for tasks, and auto-echoes a "received" reply — **no LLM**. Requires `--alias`, `--hub` optional. Unlike `anet node start` (which runs a real AI runtime), `anet run` is just a minimal connectivity demo. Verify [`cli.ts:2044 runCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2044) |

---

## Detailed Usage

### anet hub start

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2068)

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
   Store this password now; it will not be shown again.
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

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3608)

Change the current logged-in user's password. By default it prompts for old password, new password, and confirmation. Scripts may pass `--old` / `--new`.

```bash
anet passwd
anet passwd --old old-password --new new-password
```

On success the hub returns a fresh `utok_`; CLI saves it back to `~/.anet/config.json`. Other devices' `utok_` are revoked. Agent `ntok_` credentials are not affected.

### anet hub admin reset-user

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2318)

Local hub-host recovery command. It bypasses HTTP and reads SQLite directly.

```bash
anet hub admin reset-user --username alice
```

It generates a random password, revokes all user `utok_`, issues a fresh `utok_`, and writes `password_reset_by_admin` to `audit_log`. The password is printed once.

### anet node create

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1391) (`createCommand`)

Create a new agent node.

```bash
anet node create <name> [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--runtime` | omit it to enter the interactive **runtime-first wizard** (since v0.9.2 [#133](https://github.com/sleep2agi/agent-network/issues/133), per Vincent's 5101 push: a 3-way picker chooses `claude-agent-sdk` / `claude-code-cli` / `codex-sdk` first; **only** `claude-agent-sdk` continues into the vendor picker. `claude-code-cli` prints a `claude auth login` hint and skips the vendor step; `codex-sdk` prints a `codex auth login` hint and does the same) | `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` |
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

After creation, a config file is generated at `.anet/nodes/<node-name>/config.json` (directory name is the alias, not the internal `node_id`). Below is the actual output of the `codex-sdk` example command above (no extra flags):

```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "code-assistant",
  "alias": "code-assistant",
  "runtime": "codex-sdk",
  "model": "<codex-model-id>",
  "channels": ["server:commhub"],
  "env": {},
  "flags": {
    "dangerouslySkipPermissions": true
  }
}
```

The following fields are generated **conditionally** — not every node has them: `teammateMode` (only for the `claude-code-cli` runtime, default `in-process`), `session` (only for `claude-code-cli` or when `--session` is passed), `maxTurns` (only when `--max-turns` is passed), `tools` (only when `--tools` is passed).

### anet node start

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2209)

Start an agent node. **Default is foreground** (stdio inherits the current terminal); pass `--tmux` to launch the node inside a new tmux session and attach.

> v0.9.0 briefly introduced an "auto-wrap into detached tmux" default ([#122](https://github.com/sleep2agi/agent-network/issues/122)). v0.9.2 reverts it via [#136](https://github.com/sleep2agi/agent-network/issues/136) — detached tmux triggered `setRawMode errno 5` on macOS bun (the detached child's stdio isn't a real PTY, claude-code-cli's setRawMode call failed). The new `--tmux` path is **attached** (`tmux new -As`), keeping the PTY chain intact so setRawMode works everywhere.

```bash
anet node start <name> [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--tmux` | false | Start in a new tmux session and attach (session name = alias; `-A` attaches if it already exists). Detach with `Ctrl-B D`. |
| `--new-session` | false | Ignore previous Claude session, create a new one (the "start over" path on the `--resume` chain) |

**Default (no flag)**:

```bash
anet node start <name>
# Foreground in this terminal, stdio inherited. Ctrl-C to exit.
# Want a background tmux session? Either roll your own —
#   tmux new -s <name>
#   anet node start <name>
# — or pass --tmux for the one-liner:
anet node start <name> --tmux
```

**`--tmux` semantics**: internally runs `tmux new -As <alias> -c <cwd> "anet node start <alias>"`:
- `-A` — if a same-name session already exists, attach to it instead of erroring (rerun-friendly)
- `-s` — session name = alias (discoverability)
- `-c` — start in the current cwd
- the inner command does **not** carry `--tmux`, so the inner `anet node start` runs foreground — no recursion
- the parent terminal becomes a tmux client, keeping the PTY chain intact: `claude-code-cli` setRawMode, `Ctrl-C`, raw input all work normally

**`--tmux` fallback**: if tmux isn't installed, the command errors out and suggests installing tmux or dropping the flag to run foreground.

**`anet node stop` behavior**: when a same-name tmux session exists, **`tmux kill-session` runs first**, then SIGTERM the recorded PID + notify the hub. This applies both to sessions created by `--tmux` and to the detached sessions `anet project up` ([#117](https://github.com/sleep2agi/agent-network/issues/117)) spawns; output reports either "tmux + process killed" or just "process killed".

### anet status

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2995)

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

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3059)

View task list.

```bash
anet tasks [status] [--limit <n>]
```

| Parameter | Description |
|------|------|
| `status` | Filter by status; any state from the [Task lifecycle state machine](/en/concepts/task-lifecycle#status-reference) is accepted (`delivered` / `acked` / `running` / `replied` / `failed` / `cancelled` / `expired`) |
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

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5917)

System diagnostics.

```bash
anet doctor              # Diagnose only; prints ✅ / ❌ per check with fix hints
anet doctor --fix        # Auto-repair: (a) migrateNode converts V2 legacy fields (alias/resume/legacy_runtime_name) to v0.8 schema (b) probes expired ntok_ and re-issues them via the hub, writing back to .anet/nodes/<name>/config.json
```

Checks (in actual order per [`cli.ts:5917-6082 doctorCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5917)):

1. Global config (`~/.anet/config.json` — has `hub` / `token`?)
2. Auth token presence
3. Hub reachability (GET `/health` — shows sessions / SSE / license / multi-network info)
4. Local node configs + per-node process status + legacy-field diagnosis ([`diagnoseNode` cli.ts:5842](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L5842) detects 8 issue kinds: legacy_alias_field / legacy_resume_field / legacy_runtime_name / stale_dev_hub / missing_token / user_token / untyped_token / missing_node_id)
5. Dependencies: `claude --version` / `codex --version` / `bun --version`
6. Current project `.mcp.json` commhub config
7. Telegram channel env (`~/.claude/channels/telegram/.env` silently empty? — known token-loss foot-gun for `/telegram:configure`)

::: tip `--fix` is new in v0.8
Pre-v0.7, an expired `ntok_` required a manual `anet node delete` + recreate. Since v0.8, `--fix` probes + re-issues in place, and agent-node SSE 401 auto-reloads the token instead of going offline ([RFC-001 Phase 2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) implementation detail).
:::

### anet upgrade

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3522)

Print / execute the upgrade plan — covers 4 packages (`anet self` / `agent-node` / `commhub-server` / `agent-network-dashboard`) across two channels (preview / latest, auto-detected or overridden via `--channel`). Rewritten in [#88](https://github.com/sleep2agi/agent-network/issues/88) for v0.9.0+; the old behavior covered only 2/3 packages and **silently downgraded** preview-channel users to `@latest`.

```bash
anet upgrade [--channel preview|latest] [--self] [--dry-run]
```

| Parameter | Default | Description |
|------|--------|------|
| `--channel preview|latest` | auto-detect | Force a release channel; auto-detect: anet version has prerelease tag → `preview`, otherwise `latest` |
| `--self` | false | Trigger a detached self-spawn upgrade of anet itself (`sh -c 'npm install -g ... && anet -v'`, stderr → `/tmp/anet-self-upgrade.err`); without this flag the default just prints the manual command, avoiding replacing the running CLI process mid-upgrade |
| `--dry-run` | false | Print the plan only — do not actually run |
| `--fork-script` | — | Deprecated, retained for back-compat |

**Plan output (one line per package)**:

```
  anet (self)         2.2.0                →  2.2.6                → upgrade
                      (since v0.10.6 #154 anet upgrade auto-detached-spawns by default — no --self flag needed when self is < target;
                       chicken-and-egg note for users on 2.2.4 or older: one-time manual `npm install -g @sleep2agi/agent-network@latest`
                       to reach 2.2.5+, then subsequent `anet upgrade` will auto-detached-spawn)
  agent-node          2.4.0                →  2.4.2                → upgrade
  commhub-server      not installed        →  0.8.2                (lazy via npx, skipped)
                      (not installed globally — lazy-fetched via npx by `anet hub start`)
  dashboard           0.5.0                →  0.5.3                → upgrade
```

| Badge | Meaning |
|------|------|
| `→ upgrade` | current < target, install the new version |
| `✓ up to date` | Already at target, skipped |
| `(lazy via npx, skipped)` | Not installed globally — anet auto-fetches via `bunx/npx`, no global upgrade required |
| `(self — see below)` | anet does not self-upgrade by default (pass `--self`) |
| `⚠ npm registry lookup failed` | Bad package name or network issue |

**`commhub-server` row always carries the note**: `(anet hub start uses pinned <PINNED_SERVER_VERSION>)` — `anet hub start` runs that pinned version regardless of what's globally installed (to avoid server-breaking churn). A global install is only useful for `bunx @sleep2agi/commhub-server` direct runs.

**Node version check**: below `engines.node` (22.13.0) only warns — does not block (preview.9+ really does fail, but users who explicitly know what they're doing get to proceed). The warning suggests `nvm install 22 && nvm use 22`.

**After upgrade, recommend `anet project restart`** ([#117](https://github.com/sleep2agi/agent-network/issues/117)) so already-started nodes under cwd pick up the new agent-node version.

Full upgrade walkthrough: [Upgrade Guide](/en/guide/upgrade).

### anet project

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3163)

Cwd-wide node orchestration, introduced in [#117](https://github.com/sleep2agi/agent-network/issues/117) (v0.9.0+, on npm `latest` since v0.10.0, verify [`agent-network/bin/cli.ts:7137` `case "project"`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L7137)).

```bash
anet project <up|restart|down> [--stagger <seconds>] [--only a,b] [--exclude x,y]
```

| Subcommand | Behavior |
|--------|------|
| `anet project up` | Start every node under cwd's `.anet/nodes/`; same-name tmux already running is skipped (▶ started / ⏭ already-running) |
| `anet project restart` | Kill each node's existing tmux session, then start fresh (↻ restarted / ▶ started) |
| `anet project down` | Stop every node + notify hub offline (⏹ stopped) |

**`down`'s 2 s offline-notify timeout** ([`cli.ts:3085-3088`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3085)): this command is commonly used when the hub itself has crashed; serially fetching offline notifications for 22 nodes would hang on 44 timeouts and deadlock the teardown. `Promise.race + setTimeout(2000)` guarantees a fast worst-case teardown.

**Node selection**: `--only` / `--exclude` take aliases or node IDs (comma-separated, parsed via `splitCsv`).

**Pairs with #115**: every inner `anet node start` is spawned by [`startNodeTmuxSession`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L35); `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999` is auto-injected to skip Claude Code's resume prompt — recovering 22 nodes after reboot via `anet project up` is genuine **zero-keystroke recovery**.

> ⚠ Since v0.9.2 `anet node start` defaults to foreground ([#136](https://github.com/sleep2agi/agent-network/issues/136)). `anet project up` still spawns each node into a detached tmux session as before, which can re-trigger `setRawMode errno 5` on macOS bun (same root cause as #136) — affected users should pre-create a `tmux new -s mybox` then sequentially run `anet node start <alias> --tmux` per node. Tracking issue for the bulk-detached path: #136 follow-up.

### anet attach

> ⏳ **Status: [#121](https://github.com/sleep2agi/agent-network/issues/121) not yet implemented** (P2; expected v0.9.x post-release)

Design goal: `anet attach <alias>` = single-command attach to the detached tmux session for that alias — equivalent to `tmux attach -t <alias>` but with alias→tmux-session-name resolution (handles `node_id` references / alias normalization). For now use `tmux a -t <alias>` directly, or `anet node start <alias> --tmux` (the v0.9.2 `--tmux` flag uses `tmux new -As` which attaches if the session already exists — see [#136](https://github.com/sleep2agi/agent-network/issues/136)).

### anet network invite

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3432)

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

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3555)

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

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1875)

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

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L825)

Initialize a Claude Code project with automatic MCP and CLAUDE.md configuration.

Here, `project` is a **literal subcommand keyword**, not a replaceable project-name placeholder. Type `anet init project` exactly. It initializes configuration in the current directory; it does not create a new directory named `project`.

```bash
anet init project
```

**Auto-created files**:

```
{project}/
├── .mcp.json            # MCP Server config
├── CLAUDE.md            # Agent behavior rules
└── .anet/
    ├── node-server.js   # Channel plugin (auto-copied from the npm package's dist/src/node-server.js; aligned with R216/R221 chain)
    └── package.json     # Dependencies
```

`.mcp.json` contents:

```json
{
  "mcpServers": {
    "commhub": {
      "type": "stdio",
      "command": "bun",
      "args": [".anet/node-server.js"]
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
| `COMMHUB_URL` | CommHub Server address | env > config file (CLI `--hub` is highest) |
| `COMMHUB_ALIAS` | Agent alias | env > config file (CLI `--alias` is highest) |
| `COMMHUB_TOKEN` | Auth token | **agent-node: lowest** — node config (`ntok_`) > global config > this env, and if the env conflicts with the node config it is **ignored + a warning is logged** ([`agent-node/src/cli.ts:187-190`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L187), to stop a leftover export from routing replies to the wrong network). In the `anet` CLI it's env > global config instead. |
| `COMMHUB_AUTH_TOKEN` | **Server-side** legacy master token (v0.8 soft-deprecated, removed in v1.0) — read by the hub process, not an agent-connection priority variable | server-side |
| `ANTHROPIC_BASE_URL` | Model API URL (MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo / OpenRouter and other third-party Anthropic-compatible endpoints; full provider list in [multi-model](/en/guide/multi-model)) | - |
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
