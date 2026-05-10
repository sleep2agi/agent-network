# Upgrade Guide

This guide covers how to upgrade Agent Network to the latest version, along with migration notes between major versions.

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

```bash
# Upgrade CLI + CommHub Server
npm install -g @sleep2agi/agent-network@preview

# Upgrade Agent Node (if globally installed)
npm install -g @sleep2agi/agent-node@preview

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

## V2 to V3 Migration

V3 is a major upgrade with the following key changes:

### Breaking Changes

| Change | V2 | V3 | Impact |
|--------|----|----|--------|
| Token system | Single token | Dual tokens (`utok_` + `ntok_`) | **Re-login required** |
| Config format | `.agent-node.json` | `.anet/nodes/<id>/config.json` | Auto-migrated |
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

- [Key Concepts](/en/guide/basics) -- Understand V3 core concepts
- [CLI Commands](/en/guide/cli) -- See all V3 commands
- [FAQ](/en/faq) -- Frequently asked questions
