# Production / Public-Internet Deployment

::: danger Default config is NOT safe for the public internet
The current stable line (v0.10.8 — the `v0.X.Y` format mirrors `commhub-server`'s `0.X.Y` semver style; the old `v2.1.x` CLI version scheme is deprecated — see [changelog](/en/changelog)) is tuned for **local use only**. Running with `--host 0.0.0.0` straight to the open internet leaves you wide open.

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

**Since v0.8, the tmux control plane is disabled by default.** Verified at [`server/src/index.ts:14`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L14): `TMUX_ENABLED = process.env.COMMHUB_ENABLE_TMUX === "1"` — **only an explicit `=1` enables it**; `=0` / `=true` / unset all leave it off.

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

- **v0.8.0 / v0.8.1 has closed P0**: auth required ✅ / localhost-only default ✅ / `admin/anethub` default with required `anet passwd` rotation ✅ / tmux off ✅ / network scope enforced ✅
- **v0.9.0 / v0.9.1 shipped** ([changelog](/en/changelog#v0-9-0-recovery-observability-2026-05-15-stable)): vendor-credential envRef mode ✅ ([#125](https://github.com/sleep2agi/agent-network/issues/125) — secrets no longer persist in plaintext `config.json`) + default-toolset transparency ✅ ([#101](https://github.com/sleep2agi/agent-network/issues/101) — Claude Code preset by default + behavior-disclosure banner, [user-responsibility checklist](/en/concepts/security#tool-permissions-default-claude-code-preset-user-responsibility)) + host-telemetry observability ✅ ([#119](https://github.com/sleep2agi/agent-network/issues/119) `/api/servers` + dashboard ServersDrawer)
- **v0.9.2 shipped** ([changelog](/en/changelog#v0-9-2-patch-auth-fast-fail-fan-out-retry-wizard-redo-122-default-tmux-reverted-2026-05-16-stable)): vendor API auth fast-fail ✅ ([#129](https://github.com/sleep2agi/agent-network/issues/129) — 15 min → <5 s + vendor-specific URL hint) + fan-out retry-with-backoff ✅ ([#132](https://github.com/sleep2agi/agent-network/issues/132) Tier 1 `CLAUDE_MAX_RETRIES=2` + jitter) + `anet node start` reverted to foreground default ✅ ([#136](https://github.com/sleep2agi/agent-network/issues/136) — fixes the macOS bun setRawMode bug)
- **v0.10.0 / v0.10.1 shipped** ([changelog](/en/changelog)): per-server-daemon Phase 1 observability endpoint family ✅ ([#99](https://github.com/sleep2agi/agent-network/issues/99) `GET /api/server/:host/health` + `/api/server/:host/agents`, used by the dashboard ServersDrawer, monitoring scripts, and external observability integrations; auth matches the existing `/api/servers`) + per-agent process telemetry ✅ ([#142](https://github.com/sleep2agi/agent-network/issues/142) `rss` / `cpu_pct` / `uptime_seconds` / `in_flight_count`) + codex app-server stdio direct opt-in ✅ ([#141](https://github.com/sleep2agi/agent-network/issues/141) `ANET_CODEX_STDIO_DIRECT=1` bypasses the `@openai/codex-sdk` wrapper [#102](https://github.com/sleep2agi/agent-network/issues/102) hang root cause family) + release-gate playbook first full run + v0.10.1 `PINNED_SERVER_VERSION` chain-bump fixes the `anet hub start` default-path functionality regression
- **v0.10.2 → v0.10.8 shipped** (same-day 7-patch chain, [changelog](/en/changelog)): host disk telemetry ✅ (v0.10.2 Hero A, `df -k` POSIX) + dashboard Hero D topology prefix-label Option C + disk render (v0.10.2) + codex-sdk default model `gpt-5.5` + yolo flags persisted in config (v0.10.3 [#149](https://github.com/sleep2agi/agent-network/issues/149)) + dashboard topology orphan-band "Others" cluster + `anet upgrade` UX warning (v0.10.4 [#150](https://github.com/sleep2agi/agent-network/issues/150) + [#151](https://github.com/sleep2agi/agent-network/issues/151)) + `anet create --batch` wizard workdir mode + codex/claude skip API-key prompt (v0.10.5 [#152](https://github.com/sleep2agi/agent-network/issues/152) + [#153](https://github.com/sleep2agi/agent-network/issues/153)) + `anet upgrade` Option B detached spawn default + batch-wizard silent-exit fix (v0.10.6 [#154](https://github.com/sleep2agi/agent-network/issues/154) + [#155](https://github.com/sleep2agi/agent-network/issues/155)) + codex-sdk batch-path yolo flags parity + `--no-yolo` opt-out for CI/scripted (v0.10.7 [#156](https://github.com/sleep2agi/agent-network/issues/156)) + Dashboard Servers panel UI copy fix + TopoGraph density-tier polish (v0.10.8 [#157](https://github.com/sleep2agi/agent-network/issues/157)) — **18 cumulative `@latest` publishes, 0 split-brain / 0 rollback / 0 retry**
- **Unscheduled / future**: Argon2id passwords ([security report R9](https://github.com/sleep2agi/agent-network/blob/main/docs/open-source-security-risk-report.md)) + token TTL + revoke-all + checksummed install scripts — **not in the v0.9.x or v0.10.x scope**; planned for v0.11+ as priorities permit
- Vulnerabilities: report via [GitHub Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — 48-hour ack, 7-day patch for critical

## Feedback

Hitting an edge case this page doesn't cover? Reach out on:
- [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — public
- [WeChat community](/en/community) — Chinese-speaking
- [Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) — private vulnerabilities
