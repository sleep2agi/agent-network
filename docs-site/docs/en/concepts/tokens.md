# Token System

Agent Network uses three types of tokens for authentication and authorization, each with different purposes and permission scopes.

## Token Types Overview

| Prefix | Name | Scope | Purpose | Used By |
|------|------|---------|------|------|
| `utok_` | User Token | User-level, not bound to a network | CLI login, Dashboard | Human users |
| `ntok_` | Network Token | User + specific network | Agent connection to CommHub | Agent Node |
| `atok_` | API Token | User + optional network | Legacy compat / general API | Backward compat |

## utok_ (User Token)

### When You Get One

- **On registration**: Returned after `anet register` succeeds
- **On login**: Returned after `anet login` succeeds. Each login creates a new utok_; old login tokens remain valid until revoked with `anet token revoke`.

### Permission Scope

utok_ is a user-level token, **not bound to any network**:

| Operation | Allowed |
|------|------|
| CLI login (`anet whoami`) | Yes |
| Dashboard login | Yes |
| REST API read/write | Yes (only your own networks; writes require owner/admin/member) |
| MCP write operations (`send_task`, etc.) | Yes, if a writable network can be resolved (for example via `network_id`) |
| Agent connection | **No** |

::: warning Important
utok_ **cannot** be used for Agent Node SSE connections. Agents must use the ntok_ written by `anet node create`, so the Hub can enforce the bound network.
:::

### Usage Examples

```bash
# CLI operations
anet login
# → Receive utok_xxxxx
# → Automatically saved to ~/.anet/config.json

# Subsequent CLI commands automatically use utok_
anet status     # View network status
anet tasks      # View task list
anet network ls # List networks
```

### Storage Location

```json
// ~/.anet/config.json
{
  "hub": "http://YOUR_IP:9200",
  "token": "utok_xxxxxxxxxxxxxxxx"
}
```

## ntok_ (Network Token)

### When You Get One

- **On registration**: The server returns an ntok_ for the default network, mainly for compatibility
- **On node creation**: `anet node create` automatically creates an ntok_ for that node and saves it in node config

### Permission Scope

ntok_ is bound to a user + specific network, with full permissions within that network:

| Operation | Allowed |
|------|------|
| Agent connection to CommHub | Yes |
| MCP write operations (`send_task`, etc.) | Yes (bound network only) |
| MCP read operations | Yes (bound network only) |
| REST API | Yes (bound network only) |
| Cross-network operations | **No** |

### Usage Examples

```bash
# Agent Node connection (using anet CLI)
anet node create coder-1
anet node start coder-1
# ntok_ is managed automatically, no need to specify manually

# Or manually specify token (advanced usage)
anet node start coder-1 --token ntok_xxxxxxxxxxxxxxxx
```

```yaml
# Docker Compose
services:
  worker:
    environment:
      - COMMHUB_TOKEN=ntok_xxxxxxxxxxxxxxxx
```

### Network Isolation

ntok_ is the core mechanism for network isolation. The server **enforces** the network_id bound to the token -- clients cannot override it:

```typescript
// Server-side logic
const effectiveNetId = enforceNetworkId ?? clientNetId ?? null;
// enforceNetworkId comes from the ntok_ binding; clients cannot bypass it
```

This means:
- If ntok_ is bound to network A, even if the client sends network_id=B, the actual operation targets network A
- Agents in different networks cannot see each other's tasks and messages

## atok_ (API Token)

### When You Get One

- **Manual creation**: `anet token create <name>`
- **Legacy compatibility**: Pre-v3 tokens are automatically compatible

### Permission Scope

The current CLI creates `scope=full` atok_ tokens, optionally bound to a network. The database has room for more scopes, but `agent` / `readonly` selection is not exposed by the CLI yet.

### Usage Examples

```bash
# Create an API token
anet token create my-bot-token

# List all tokens
anet token ls

# Revoke a token
anet token revoke tok_xxxxx
```

### Backward Compatibility

The `COMMHUB_AUTH_TOKEN` environment variable supports the legacy global token mode (not bound to user/network), used for development and testing.

## Permission Decision Flow

```mermaid
flowchart TD
    REQ[Request arrives] --> CHECK{Has Token?}
    CHECK -->|No| LEGACY{COMMHUB_AUTH_TOKEN?}
    LEGACY -->|No| OPEN[Open mode<br/>Allow all]
    LEGACY -->|Match| GLOBAL[Global Token<br/>Allow all]
    LEGACY -->|No match| DENY1[401 Unauthorized]

    CHECK -->|Yes| RESOLVE[Resolve Token]
    RESOLVE --> TYPE{Token Type}

    TYPE -->|utok_| UTOK[User-level]
    UTOK --> UTOK_OP{Operation Type}
    UTOK_OP -->|REST/MCP read/write| SCOPE_CHECK[Check user networks and role]
    SCOPE_CHECK --> ROLE

    TYPE -->|ntok_| NTOK[Network-level]
    NTOK --> NET_ROLE[Check network role]
    NET_ROLE --> ROLE{Role}
    ROLE -->|owner/admin/member| ALLOW[Allow]
    ROLE -->|viewer| VIEW_OP{Operation Type}
    VIEW_OP -->|Read| ALLOW
    VIEW_OP -->|Write| DENY3[Denied<br/>Viewer cannot write]

    TYPE -->|atok_| ATOK[API Token]
    ATOK --> ATOK_SCOPE{Scope}
    ATOK_SCOPE -->|full| ALLOW
```

## Security Best Practices

### 1. Least-Privilege Tokens

| Scenario | Recommended Token |
|------|-----------|
| Daily CLI management | utok_ (obtained after login) |
| Agent Node connection | ntok_ (auto-created) |
| Dashboard | utok_ (login) |
| Third-party integrations | atok_ (manually created; bind it to a network when possible) |
| Monitoring systems | utok_ or a network-bound atok_ |

### 2. Secure Token Storage

```bash
# Correct: Token stored in ~/.anet/config.json (permissions 600)
chmod 600 ~/.anet/config.json

# Correct: Passed via environment variable in Docker
docker run -e COMMHUB_TOKEN=ntok_xxx ...

# Wrong: Don't store tokens in project config
# .anet/config.json should not contain a token field

# Wrong: Don't commit tokens to Git
echo ".anet/" >> .gitignore
```

### 3. Token Rotation

```bash
# Periodically rotate tokens
anet token revoke tok_old
anet token create new-token

# Login creates a new utok_; old tokens remain valid until revoked
anet token ls
anet token revoke tok_old
```

### 4. Network-Based Isolation

```bash
# anet node create automatically creates an independent ntok_ per network
anet network create prod
anet network use prod
anet node create prod-agent

anet network create dev
anet network use dev
anet node create dev-agent
```

## Token Lifecycle

| Event | utok_ | ntok_ | atok_ |
|------|-------|-------|-------|
| Registration | Created | Created (bound to default network) | - |
| Login | Created (old tokens remain until revoked) | Unchanged | - |
| Node creation | Unchanged | Created (bound to node's network) | - |
| Manual creation | - | - | Created |
| Revocation | `anet token revoke` | `anet token revoke` | `anet token revoke` |
| Expiration | No expiration | No expiration | Configurable expiration |

## Global Token (COMMHUB_AUTH_TOKEN)

For development and testing, you can use a global token to simplify authentication:

```bash
# Set when starting the server
anet hub start --token my-dev-token

# All requests use this token
curl -H "Authorization: Bearer my-dev-token" http://localhost:9200/api/status
```

::: warning Development Only
Global tokens have no user/network binding and are not suitable for production. Use the utok_/ntok_ system in production environments.
:::
