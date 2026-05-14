# Production / Public-Internet Deployment

::: danger Default config is NOT safe for the public internet
The current stable line (v0.8.2 / CLI v2.1.7) is tuned for **local use only**. Running with `--host 0.0.0.0` straight to the open internet leaves you wide open.

Read this entire page **before opening any firewall ports**.
:::

## What the defaults look like today

| Item | Default | Risk |
|---|---|---|
| Hub bind | `127.0.0.1` (local only) | Public mode needs explicit `--host 0.0.0.0` |
| Default account | `admin / anethub` for quick-start, or set by `--username/--password` | Rotate immediately with `anet passwd` |
| `COMMHUB_AUTH_TOKEN` | deprecated in v0.8 | No longer part of the main deployment path |
| tmux control plane | disabled by default | Requires `COMMHUB_ENABLE_TMUX=1` + admin auth |
| Multi-tenant isolation | network-scoped | Users only access networks they belong to |
| HTTPS | none | 9200 / 3000 are plaintext by default |

Full audit: [`docs/open-source-security-risk-report.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/open-source-security-risk-report.md). **v0.8.0 / v0.8.1 has closed all P0 items** (auth required ✅ / localhost-only default ✅ / `admin/anethub` default with forced `anet passwd` rotation ✅ / tmux off ✅ / network scope enforced ✅). This page is kept as a public-deployment checklist.

## Minimum checklist for public deployment

### 1. Change the password — now

```bash
anet login --username admin --password anethub
anet passwd                       # interactive, ≥ 12 chars, mixed case + digits + symbols
```

### 2. Do not configure a master token in v0.8+

```bash
anet hub start --host 0.0.0.0
```

First start provisions an admin user and writes a local recovery admin `utok_` to `~/.anet/server/admin-utok.json` (`chmod 600`). Legacy `COMMHUB_AUTH_TOKEN` / `--token` remains as a v0.8 soft-compat path only and logs a deprecation warning.

### 3. Reverse proxy + TLS (required)

Don't expose `9200` / `3000` directly. Caddy gives you automatic HTTPS:

```caddy
hub.your-domain.com {
    reverse_proxy localhost:9200
    header {
        X-Content-Type-Options nosniff
        -Server
    }
}

dashboard.your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

DNS your hostname to the box and Caddy will fetch a Let's Encrypt cert automatically.

### 4. Firewall: 22 + 80 + 443 only

Keep the security group / firewall locked down to **22(SSH) + 80 + 443**. Don't open 9200 / 3000 to the world — Caddy proxies them through 443.

### 5. Verify the tmux control plane is off

**Since v0.8, the tmux control plane is disabled by default.** Verified at [`server/src/index.ts:13`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L13): `TMUX_ENABLED = process.env.COMMHUB_ENABLE_TMUX === "1"` — **only an explicit `=1` enables it**; `=0` / `=true` / unset all leave it off.

So as long as you do **not** actively set `COMMHUB_ENABLE_TMUX=1`, it's already off:

```bash
# Default (off, no env needed)
anet hub start --host 0.0.0.0

# Verify by checking the startup banner after the hub boots:
# Tmux: DISABLED (set COMMHUB_ENABLE_TMUX=1)   ← expected
```

::: warning Drop `COMMHUB_ENABLE_TMUX=1` from legacy scripts
v0.7 / V2-era deployment scripts often passed `COMMHUB_ENABLE_TMUX=1` (when it was the default). On a public deployment that leaves tmux HTTP/WS endpoints exposed — even with admin auth + an IP allowlist, that's an unnecessary attack surface. **Confirm any `--host 0.0.0.0` hub does not set `COMMHUB_ENABLE_TMUX=1` in env / systemd unit / docker-compose** (the startup banner should show `Tmux: DISABLED`).
:::

### 6. Back up the SQLite database

```bash
crontab -l 2>/dev/null > /tmp/cron
echo "0 3 * * * sqlite3 ~/.commhub/commhub.db \".backup '~/.commhub/backup-\$(date +\\%F).db'\"" >> /tmp/cron
crontab /tmp/cron
```

Prune weekly: `find ~/.commhub/backup-*.db -mtime +30 -delete`.

### 7. Watch failed logins

```bash
journalctl --user -u anet-hub | grep -E '401|auth' | tail -50
```

v0.8 ships `/api/audit-log` + a Dashboard Audit Log page (admin role).

## Sharing a Hub across users? Read this

::: tip v0.8 has multi-tenant isolation
As of v0.8.0:

- `get_inbox` / `get_all_status` / `list_tasks` are filtered by the caller's network membership (R7 / R8 fixed)
- SSE subscribe enforces network membership

Cross-team / open-registration scenarios are safe to enable, but we still recommend invite-only via `anet network invite --role member --uses N` rather than fully-open `/api/auth/register`.
:::

Acceptable today:

- Inside-the-team trust, ≤ 20 people
- Solo with multiple agents
- Trusted contractors with NDAs

## Self-host vs. hosted

| Option | Use it for | Notes |
|---|---|---|
| **Local only** | Solo dev | Safest, zero config |
| **LAN** | Team 5–20 | Trusted network, no TLS needed |
| **VPS + reverse proxy** | Cross-site collaboration | Run all 7 steps above |
| **Hosted SaaS** | ❌ Not offered | Project is self-hosted-first; no hosted tier planned |

## Our commitments

- v0.8.0 / v0.8.1 has closed P0: auth required ✅ / localhost-only default ✅ / `admin/anethub` default with required `anet passwd` rotation ✅ / tmux off ✅ / network scope enforced ✅
- v0.9 (planned): Argon2id passwords / token TTL + revoke-all / pinned + checksummed install scripts
- Vulnerabilities: report via [GitHub Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — 48-hour ack, 7-day patch for critical

## Feedback

Hitting an edge case this page doesn't cover? Reach out on:
- [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — public
- [WeChat community](/en/community) — Chinese-speaking
- [Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — private vulnerabilities
