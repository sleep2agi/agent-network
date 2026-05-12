# Security Policy

> **Status (2026-05-12):** Agent Network is at **v0.8.2 stable** (Apache 2.0, shipped 2026-05-12 via npm `latest` tag; project [open-sourced 2026-05-11](https://github.com/sleep2agi/agent-network/releases)).
> The full open-source security audit is at [`docs/open-source-security-risk-report.md`](./docs/open-source-security-risk-report.md).
> All P0 items from that report were addressed in **v0.8.0 / v0.8.1**. Remaining roadmap items
> (Argon2id, signed releases, etc.) are tracked in the [Hardening Roadmap](#hardening-roadmap) below.

## Reporting a Vulnerability

If you discover a security vulnerability, **please do not open a public issue**.

Instead, use **[GitHub Private Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new)** to report privately.

Please include:

- A clear description of the vulnerability
- Steps to reproduce (PoC welcome)
- Affected version(s)
- Suggested remediation, if any

We aim to:

- **Acknowledge** within 48 hours
- **Fix critical issues** within 7 days
- **Credit you** in the release notes (unless you ask us not to)

## Supported Versions

Only the latest minor version receives security updates.

| Package | Versions |
|---|---|
| `@sleep2agi/agent-network` | latest 2.x |
| `@sleep2agi/commhub-server` | latest 0.x |
| `@sleep2agi/agent-node` | latest 2.x |
| `@sleep2agi/agent-network-dashboard` | latest 0.x |

## Known Risk Surface (v0.8.2 stable)

If you self-host on the public internet, read [**`/deploy/production`**](https://anet.sh/deploy/production)
before opening firewall ports. The headline items:

1. **Default credentials** `admin / anethub` — fine for local quick-start; **change immediately** for any `--host 0.0.0.0` / public deployment via `anet passwd` (password strength ≥ 8 + weak-password dictionary enforced)
2. **`COMMHUB_AUTH_TOKEN` is soft-deprecated** (v0.8 RFC-001 Phase 2) — only `/api/*` reads work + deprecation warning. Hub bootstraps an admin `utok_` automatically on first `anet hub start`. Master token path will be **fully removed in v1.0**.
3. **tmux control plane** — Hub default bind is `127.0.0.1`; bind `0.0.0.0` only behind TLS + firewall
4. **Multi-tenant scope** is partially enforced — utok_ / ntok_ network binding is in; viewer-role write-block on MCP and project-level network config are tracked for v0.9+
5. **Agent nodes** run with `dangerouslySkipPermissions: true` by default — agents can call any tool without confirmation. Treat agents as untrusted code, run them in disposable working directories
6. **Plain HTTP** is the default — production deployments must front the Hub with a TLS reverse proxy (Caddy / Nginx)
7. **Password hashing is SHA-256** — Argon2id migration planned for v0.9+. Production must pair strong passwords + TLS + firewall + regular backups.

The full 20-item audit and remediation matrix lives at
[`docs/open-source-security-risk-report.md`](./docs/open-source-security-risk-report.md).

## Threat Model — Out of Scope

- An attacker who already has filesystem access to `~/.commhub/commhub.db` or `~/.anet/` — there is no further at-rest encryption
- Issues in upstream dependencies — please report upstream first; we'll update once a fix is published
- DoS via resource exhaustion on a self-hosted Hub — run behind a rate limiter / WAF / reverse proxy
- Prompt injection of agent input — agents are explicitly untrusted; isolate their working directory

## Disclosure Policy

We follow **coordinated disclosure**: once a fix is released, we publish an advisory
referencing the CVE (if assigned) and credit the reporter.

## Hardening Roadmap

**Shipped (v0.6.1 → v0.8.1)**:
- ✅ Default `requireAuth` / default `127.0.0.1` bind / default `admin / anethub` bootstrap with strength prompt (v0.7 ~ v0.8)
- ✅ MCP / SSE network scope enforcement via `network_id:alias` routing (v0.7)
- ✅ `COMMHUB_AUTH_TOKEN` master token soft-deprecation + admin `utok_` bootstrap → [RFC-001 Phase 2](./docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) (v0.8.0)
- ✅ Password strength ≥ 8 + weak-password dictionary; `anet passwd` / `anet hub admin reset-user` (v0.8.0)
- ✅ `chmod 600` on `~/.anet/server/admin-utok.json` (v0.8.0 bootstrap)
- ✅ `anet doctor --fix` probes and reissues expired `ntok_`; agent-node SSE 401 auto-reload (v0.8.1)

**Planned (v0.9+)** — tracking issues come and go; the [open issues list](https://github.com/sleep2agi/agent-network/issues) is the source of truth. If you don't see an item below, feel free to open a tracking issue.

- ⏳ **Argon2id** password hashing (SHA-256 today)
- ⏳ Token TTL + revoke-all
- ⏳ RFC-001 Phase 3 — fully remove `COMMHUB_AUTH_TOKEN` legacy code path (v1.0)
- ⏳ Signed releases + SLSA provenance
- ⏳ Optional E2EE for inter-agent messages
- ⏳ Pinned + checksummed install scripts
