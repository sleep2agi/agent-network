# Upgrade Guide (already have anet — bump to a newer version)

This guide covers how **existing users** upgrade Agent Network to the latest version, plus migration notes between major versions.

::: tip Most cases: one line
```bash
anet upgrade          # bumps agent-network / agent-node and prints a restart hint (in 1–2 min `anet -v` shows the new version)
```

Then `anet project restart` to re-spawn the cwd's nodes against the new agent-node and you're done. The sections below cover edge cases.
:::

::: details I'm on a v0.10.6-pre binary (2.2.4 or older)
Only relevant if `anet -v` shows `2.2.4` or older — anything `2.2.5+` can skip this.

v0.10.6 [#154](https://github.com/sleep2agi/agent-network/issues/154) actually resolves the chicken-and-egg (defaults to `spawn(forkScript, { detached: true })` + `child.unref()` + main-process exit, detached child runs `npm install` in the background). That fix only lives in the `2.2.5+` binary; v0.10.4 [#151](https://github.com/sleep2agi/agent-network/issues/151) only rephrased the message without solving the deadlock.

**One-time manual install** — jump straight to latest:

```bash
npm install -g @sleep2agi/agent-network@latest
anet --version            # whichever version prints is the npm latest you just installed
```

From there on, `anet upgrade` auto-detached-spawns and `anet -v` reflects the new build a minute or two later.
:::

::: details Brand-new machine, never installed anet
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

# Real run (default = auto-installs each out-of-date package + auto-detaches a self-upgrade of anet itself, since v0.10.6 #154; channel is auto-detected: prerelease tag → preview, otherwise latest)
anet upgrade

# Force a channel (overrides auto-detect)
anet upgrade --channel preview
anet upgrade --channel latest

# Opt out of anet self-upgrade (anet auto-self-upgrades via detached spawn by default since v0.10.6 #154; pass this for CI/scripted use to get the manual command instead; stderr → /tmp/anet-self-upgrade.err)
anet upgrade --no-auto-self
```

**Reading the plan**: one row per package with `current → target` and an action badge:

| Badge | Meaning |
|------|------|
| `upgrade` | current < target, install the new version |
| `up-to-date` | already at target, skipped |
| `lazy via npx skip` | not globally installed; anet fetches on demand via `bunx/npx`, no global upgrade needed |
| `self skip` | you opted out of anet self-upgrade via `--no-auto-self` (self-upgrade is the default since v0.10.6 #154) |
| `lookup failed` | npm registry lookup failed — network / package name issue |

**Note on `commhub-server`**: that row shows the current `PINNED_SERVER_VERSION` (`0.8.4` on current stable; historical chain detail in the [changelog](/en/changelog) `commhub-server` rows). `anet hub start` runs that pinned version regardless of what's globally installed (to avoid server-breaking churn). So even if you upgrade the global `commhub-server`, it doesn't change what your hub actually runs.

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

::: info Fewer and fewer people need this section
Current stable is v0.10.13. Upgrading between v0.8 / v0.9 / v0.10.x is a straight `anet upgrade` or `npm install -g @sleep2agi/agent-network@latest` — **the auth migration below is NOT required**. Full per-version increments: [changelog](/en/changelog). Kept here as a reference for users who need to traverse v0.7 → v0.10.13 in one go.
:::

::: details v0.7 → v0.8 auth / password migration detail
v0.8 ships [RFC-001 Phase 2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md), which changes **auth and password** behavior:

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
# at a PINNED version (verify agent-network/bin/cli.ts PINNED_SERVER_VERSION;
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
:::

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
