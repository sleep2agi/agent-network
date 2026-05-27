# Upgrade Guide (already have anet — bump to a newer version)

This guide covers how **existing users** upgrade Agent Network to the latest version, plus migration notes between major versions.

::: warning v0.10.6 chicken-and-egg — current binary at 2.2.4 or older needs a one-time manual install to reach 2.2.5+
v0.10.4 [#151](https://github.com/sleep2agi/agent-network/issues/151) Option A only updated the verbiage in `anet upgrade` (displaying "⚠️ NEEDS MANUAL UPGRADE"), **but the chicken-and-egg deadlock remained** — a Node process can't in-place replace its own binary. **Your current 2.2.2 / 2.2.3 / 2.2.4 binary running `anet upgrade` still falls back to the old "skipped" behavior** (that logic is frozen in the npm tarball).

v0.10.6 [#154](https://github.com/sleep2agi/agent-network/issues/154) actually resolves the chicken-and-egg: it defaults to `spawn(forkScript, { detached: true })` + `child.unref()` + main-process exit, with the detached child running `npm install` in the background. **But this fix only lives in the 2.2.5+ binary.**

**One-time manual install** (jump straight to latest, skip intermediate versions — one install gets you all fixes):

```bash
npm install -g @sleep2agi/agent-network@latest
anet --version            # current latest v2.2.9 (v0.10.10, 2026-05-27)
```

From any 2.2.5+ binary onward (the v0.10.6 [#154](https://github.com/sleep2agi/agent-network/issues/154) fix lives in 2.2.5+), `anet upgrade` **auto detached-spawns**; a minute or two later `anet --version` shows the new build — no `--self` flag or manual install required.
:::

::: tip Brand-new machine, never installed anet before?
**First-time install** goes through the [Getting Started guide](/en/guide/getting-started), or in one shell line:

```bash
npm install -g @sleep2agi/agent-network
# Or via the one-shot install script (handles admin-password prompts and other UX)
curl -fsSL https://anet.sh/install.sh | bash
```

This page is for **existing users** moving between versions.
:::

## Upgrade Steps

### 1. Check Your Current Version

```bash
# Check CLI version
anet --version

# Check Agent Node version, if globally installed
agent-node --version

# Check CommHub Server version
curl http://127.0.0.1:9200/health
```

### 2. Backup Configuration

Always back up your configuration before upgrading:

```bash
# Backup global config
cp -r ~/.anet ~/.anet.backup

# Backup project-level config (if any)
cp -r .anet .anet.backup
```

::: warning Important
The backup directory contains your Tokens, node configurations, and session records. If lost, you'll need to re-login and reconfigure.
:::

### 3. Upgrade npm Packages

::: tip v0.9.0+: one-shot `anet upgrade`
[#88](https://github.com/sleep2agi/agent-network/issues/88) overhauled `anet upgrade` with 4-package coverage, dual-channel, dry-run, and opt-in self-upgrade. **Strongly recommend `--dry-run` first to inspect the plan before actually upgrading**:

```bash
# Dry run: print the plan only (4 packages × current→target × action badge)
anet upgrade --dry-run

# Real run (default = print the manual npm commands, does not touch global install; channel is auto-detected: prerelease tag → preview, otherwise latest)
anet upgrade

# Force a channel (overrides auto-detect)
anet upgrade --channel preview
anet upgrade --channel latest

# Self-upgrade anet itself (opt-in detached spawn; stderr is captured to /tmp/anet-self-upgrade.err; without this flag the default prints the manual command to avoid replacing the running process)
anet upgrade --self
```

**Reading the plan**: one row per package with `current → target` and an action badge:

| Badge | Meaning |
|------|------|
| `upgrade` | current < target, install the new version |
| `up-to-date` | already at target, skipped |
| `lazy via npx skip` | not globally installed; anet fetches on demand via `bunx/npx`, no global upgrade needed |
| `self skip` | anet does not self-upgrade by default (pass `--self`) |
| `lookup failed` | npm registry lookup failed — network / package name issue |

**Note on `commhub-server`**: that row shows the current `PINNED_SERVER_VERSION` (`0.8.2` on v0.10.8 stable — bumped from `0.8.0` by the v0.10.1 PINNED chain-bump hotfix) — `anet hub start` runs that pinned version regardless of what's globally installed (to avoid server-breaking churn). So even if you upgrade the global `commhub-server`, it doesn't change what your hub actually runs.

**After the upgrade**: `anet upgrade` prints a hint that running nodes need a restart to pick up the new agent-node:

```bash
anet project restart    # #117, all nodes under cwd
# Or one by one: anet node stop <name> && anet node start <name>
```

`anet upgrade` is the v0.9.0+ stable (`@latest`) default behavior.
:::

**Manual npm (works on any channel)**:

```bash
# Upgrade the CLI (CommHub Server is NOT in this package — anet hub start in step 4 pulls it at its PINNED version via bunx)
npm install -g @sleep2agi/agent-network

# Upgrade Agent Node (if globally installed)
npm install -g @sleep2agi/agent-node

# If using npx, no manual upgrade needed -- it automatically pulls the latest version
```

### 4. Restart Processes

```bash
# List local nodes
anet node ls

# Stop the agents you need to restart
anet node stop <name>

# If the Hub is running in the foreground, stop it with Ctrl-C, then restart
anet hub start

# Restart agents
anet node start <name>
```

### 5. Verify the Upgrade

```bash
# Check version
anet --version

# Run diagnostics
anet doctor

# Confirm agents are online
anet status
```

---

## v0.7 → v0.8 Upgrade Notes (historical path) {#v0-7-v0-8-upgrade-notes-latest}

::: info Current stable is v0.10.8
This section documents **the historical path from v0.7 to v0.8**, kept as a reference for users who need to traverse v0.7 → v0.10.8 in one go. **Upgrading between v0.8 / v0.9 / v0.10.x** is a straight `anet upgrade` or `npm install -g @sleep2agi/agent-network@latest` — the auth migration below is **not** required (see [changelog](/en/changelog) and read the per-release notes for v0.8 / v0.9 / v0.10).
:::

v0.8 ships [RFC-001 Phase 2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md), which changes **auth and password** behavior:

::: tip v0.8.x → v0.10.8 increments
After the v0.8 main path, v0.8.2 / v0.8.3 / v0.9.0 / v0.9.1 / v0.9.2 / v0.10.0 / v0.10.1 / v0.10.2 / v0.10.3 / v0.10.4 / v0.10.5 / v0.10.6 / v0.10.7 / **v0.10.8** (current stable; four packages at npm `latest`: `agent-network 2.2.6` (v0.10.7 [#156 codex-sdk batch path yolo flags parity + `--no-yolo` opt-out](https://github.com/sleep2agi/agent-network/issues/156) — batch + codex-sdk users get the autonomous posture, single-node users unaffected + v0.10.6 [#154 anet upgrade Option B detached spawn default](https://github.com/sleep2agi/agent-network/issues/154) + [#155 batch wizard silent-exit fix](https://github.com/sleep2agi/agent-network/issues/155) + v0.10.3 codex preset + v0.10.4 [#151 anet upgrade UX](https://github.com/sleep2agi/agent-network/issues/151) + v0.10.5 [#152 batch workdir wizard + #153 codex/claude skip API key](https://github.com/sleep2agi/agent-network/issues/152)) / `agent-node 2.4.2` (v0.10.2 Hero A disk + v0.10.3 codex-sdk gpt-5.5 + yolo flags) / `commhub-server 0.8.2` / `agent-network-dashboard 0.5.3` (v0.10.8 [#157 Servers panel UI copy fix + TopoGraph density-tier polish](https://github.com/sleep2agi/agent-network/issues/157) + v0.10.4 [#150 orphan-band](https://github.com/sleep2agi/agent-network/issues/150) + v0.10.2 Hero D + disk render + 100+ rounds of polish)) progressively added: `anet channel add telegram` one-shot bind, `claude-code-cli` runtime session-resume fix, `anet create --batch` bulk-agent primitive, `anet demo sci-team` / `pr-review` demos, `anet login` first-login guidance, `anet doctor --fix` ntok_ repair, envRef vendor credential storage ([#125](https://github.com/sleep2agi/agent-network/issues/125)), SDK high-concurrency retry-with-backoff + 300s timeout ([#132](https://github.com/sleep2agi/agent-network/issues/132)), runtime-first wizard ([#133](https://github.com/sleep2agi/agent-network/issues/133)), `anet project up/restart/down` cwd-wide orchestration ([#117](https://github.com/sleep2agi/agent-network/issues/117)), the `codex-direct-stdio` opt-in path ([#141](https://github.com/sleep2agi/agent-network/issues/141), enable via `ANET_CODEX_STDIO_DIRECT=1`), the per-server-daemon observability endpoint family ([#99](https://github.com/sleep2agi/agent-network/issues/99) `/api/server/:host/health` + `/api/server/:host/agents`) + per-agent `process_telemetry` ([#142](https://github.com/sleep2agi/agent-network/issues/142)), dashboard Hero 3 8 surfaces, and more.

These increments **keep the same upgrade path as v0.7 → v0.8 main path** (the admin bootstrap + password management is a one-time migration; later incremental upgrades carry no extra auth steps). Full per-version increments: [changelog](/en/changelog).
:::

### Behavior changes

| Item | v0.7 | v0.8 | Impact |
|------|------|------|--------|
| Hub startup password | None / `COMMHUB_AUTH_TOKEN` | **First `anet hub start` non-interactively bootstraps admin (default `admin` / `anethub`; overridable via `--username` / `--password` flags)** | One-time auto-create, no interactive prompt |
| Global master token | `COMMHUB_AUTH_TOKEN` full read/write | **Soft-deprecated**: only `/api/*` read + deprecation warning | Writes rejected |
| Password strength | No check | **≥ 8 chars + weak-password dict block** (first bootstrap admin allowed ≥ 4) | Weak password errors |
| Change password | No command | **`anet passwd`** interactive | New tool |
| Admin reset | Edit SQLite manually | **`anet hub admin reset-user <username>`** | Local owner only |
| Token repair | Manual `anet login` | **`anet doctor --fix`** auto-probe and re-issue `ntok_` | Smarter doctor |

### Upgrade steps

```bash
# 1. Bump the three packages (npm latest tag — see npmjs.com for the current version)
npm install -g @sleep2agi/agent-network@latest
npm install -g @sleep2agi/agent-node@latest

# commhub-server isn't installed separately — `anet hub start` runs it via bunx
# at a PINNED version (verify agent-network/bin/cli.ts:2125 PINNED_SERVER_VERSION;
# the pin bumps along with the anet release).
# ⚠ commhub-server is bun-shebang TypeScript — install Bun first:
#   curl -fsSL https://bun.sh/install | bash

# 2. Restart Hub (first run non-interactively bootstraps admin — no prompt)
anet hub start
# Expect: '✅ Admin account created' + 'username: admin / password: anethub'
# Or:    '✅ Admin already exists' (if ~/.anet/server/admin-utok.json exists, register is skipped)
# Details: troubleshooting → 'second anet hub start re-bootstraps admin?'

# 3. Doctor repairs token + network
anet doctor --fix
# Auto-detects expired ntok_ and reissues; legacy atok_ shows deprecation but still reads
```

### Still using `COMMHUB_AUTH_TOKEN`?

- No hard error, `/api/*` reads still work, but logs spew deprecation warnings
- Write operations (register, configure agents...) must switch to `utok_` (auto-loaded from `~/.anet/config.json` after login)
- v1.0 will **fully remove** this path (RFC-001 Phase 3) — clean it up during this upgrade

### Forgot the password?

```bash
# On the Hub machine (needs SQLite write access)
anet hub admin reset-user <username>
# Interactive password reset — old password not required
```

See [security model](/en/concepts/security) for details.

---

## V2 to V3 Migration

V3 is a major upgrade with the following key changes:

### Breaking Changes

| Change | V2 | V3 | Impact |
|--------|----|----|--------|
| Token system | Single token | Dual tokens (`utok_` + `ntok_`) | **Re-login required** |
| Config format | `.agent-node.json` | `.anet/nodes/<node-name>/config.json` | Auto-migrated |
| CLI commands | `agent-node` | `anet` | Old commands no longer work |

### Manual Actions Required

1. **Re-login**: V3 uses a new dual token system (User Token `utok_` + Network Token `ntok_`). Old tokens are not compatible.

   ```bash
   # Re-login
   anet login --hub http://YOUR_HUB_IP:9200
   ```

2. **Re-join networks**: If you previously joined multiple networks, you'll need to re-join them.

   ```bash
   anet network join <invite_code>
   ```

### What's Preserved on Upgrade

The following are automatically preserved or migrated during upgrade:

- **Node configuration**: runtime, model, tools, and other settings in `config.json` are preserved
- **Session resume**: the `session` field is preserved, so you can use `anet node resume` to restore previous conversations
- **Node names**: alias/node_name remain unchanged
- **Environment variables**: API keys and other settings in the `env` field remain intact

### Migration Command

V3 provides an automatic migration tool:

```bash
# Auto-detect and migrate old configuration
anet doctor

# doctor checks for:
# - Legacy config files (.agent-node.json)
# - Token validity
# - Network connectivity
```

---

## Rollback

If you encounter issues after upgrading, you can roll back to a previous version:

### Rollback Steps

```bash
# 1. Stop all services
anet node stop <name>
# If the Hub is running in the foreground, stop it with Ctrl-C

# 2. Restore backed-up config
rm -rf ~/.anet
cp -r ~/.anet.backup ~/.anet

# 3. Install the old version (specify version number)
npm install -g @sleep2agi/agent-network@<old-version>
npm install -g @sleep2agi/agent-node@<old-version>

# 4. Restart services
anet hub start
anet node start <name>

# 5. Verify
anet doctor
```

::: tip View available versions
```bash
npm view @sleep2agi/agent-network versions --json
```
:::

### Common Upgrade Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| `Token invalid` | V2 tokens are incompatible with V3 | Run `anet login` to re-login |
| `Config format error` | Legacy config not yet migrated | Run `anet doctor` for auto-migration |
| Agent cannot connect | Server/Node version mismatch | Ensure Server and Node versions match |
| `session not found` | Session format changed | Use `anet node start <name> --new-session` to create a new session |

---

## Next Steps

- [Key Concepts](/en/guide/basics) -- Understand Agent Network core concepts
- [CLI Commands](/en/guide/cli) -- See the full anet command reference
- [FAQ](/en/faq) -- Frequently asked questions
