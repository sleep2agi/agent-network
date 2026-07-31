# Production Deployment Security

::: danger Do not expose the Hub or Dashboard ports directly
The defaults are designed for local use: the Hub listens on `127.0.0.1:9200`, and the Dashboard uses port `3000`.
The Dashboard bind address can inherit the `HOSTNAME` environment variable, so set it explicitly in production.
Before an internet deployment, configure a strong password, TLS proxy, firewall, and backups.
:::

## Defaults

| Item | Default | Production requirement |
|---|---|---|
| Hub | `127.0.0.1:9200` | Keep it local and access it through a reverse proxy |
| Dashboard | Port `3000`; bind address may inherit `HOSTNAME` | Set `--host 127.0.0.1` explicitly |
| Admin | Username `admin`; initial password varies by release channel | Run `anet passwd` after the first login |
| HTTPS | Not provided | Terminate TLS at Caddy, Nginx, or a cloud gateway |
| tmux control plane | Disabled | Keep it disabled in production |
| Data | `~/.commhub/commhub.db` | Back it up and restrict backup permissions |

## Deployment checklist

### 1. Change the password immediately

Start locally, then log in and change the password:

```bash
anet hub start
anet login --hub http://127.0.0.1:9200 --username admin
anet passwd
```

The initial password depends on the release channel:

- **stable (`@latest`)** uses a fixed default. Run `anet hub start --help` and read the `--password` description.
- **preview (`@preview`)** prints a one-time random password on first start. Save it immediately.

On either channel, run `anet passwd` immediately after logging in. The new password must be at least eight characters and must not appear in the weak-password list.

### 2. Use an HTTPS reverse proxy

Keep the Hub and Dashboard on their loopback addresses. This is a minimal Caddy configuration:

```text
hub.example.com {
    reverse_proxy 127.0.0.1:9200
    header -Server
    header X-Content-Type-Options nosniff
}

dashboard.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Point the domains at the server, then run `sudo systemctl reload caddy`. Replace the example domains.

### 3. Pin the bind addresses

Keep the Hub on its default `127.0.0.1` address, and start the Dashboard explicitly:

```bash
anet hub dashboard --host 127.0.0.1
```

Remote nodes connect through `https://hub.example.com`; the Hub itself does not need a public bind address.

### 4. Restrict the firewall

Expose only the entry points you need, usually:

- `22`: SSH (preferably restricted by source IP)
- `80`: certificate issuance and HTTP redirects
- `443`: HTTPS

Do not expose `9200` or `3000` directly to the internet.

### 5. Verify the tmux control plane is off

The server enables its tmux HTTP/WebSocket endpoints only when `COMMHUB_ENABLE_TMUX=1`.
Leave that variable unset in production; the startup log should show `Tmux: DISABLED`.

If a trusted environment genuinely needs this feature, also configure the IP allowlist and require an admin caller.
See [REST API: tmux control plane](/en/api/rest#tmux-debug-endpoints-opt-in).

### 6. Use invitations

Account registration and network membership are separate. After teammates register their own accounts,
use a single-use member invitation to add them to the intended network:

```bash
anet network invite --role member --uses 1
```

`POST /api/auth/register` is currently public and rate-limited. If self-service registration is not allowed,
block that path at the reverse proxy or gateway. Do not share an administrator account.

### 7. Back up and monitor

Use SQLite's online backup command rather than copying a live database file:

```bash
umask 077
mkdir -p ~/.commhub/backups
sqlite3 ~/.commhub/commhub.db \
  ".backup '$HOME/.commhub/backups/commhub-$(date +%F).db'"
```

Automate backups, define a retention period, and regularly test a restore. Backups contain account and message data,
so handle them as sensitive data.

At minimum, monitor:

- `GET http://127.0.0.1:9200/health`
- free disk space
- the Dashboard Audit Log
- whether a reliable process manager supervises the Hub

For long-running service and reboot recovery, see [Hub process supervision](/en/deploy/daemon).

## Deployment modes

| Scenario | Recommendation |
|---|---|
| Personal development | Listen on loopback only |
| Trusted LAN | Still use strong passwords and HTTPS |
| Internet collaboration | TLS proxy + firewall + invitations + backups |

## Security resources

- Configuration and permissions: [Security](/en/concepts/security)
- Version migrations: [Upgrade guide](/en/guide/upgrade)
- Private vulnerability reports: [GitHub Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new)
