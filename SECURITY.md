# Security Policy

> **Status:** Agent Network v2.1 is **public beta**. A full open-source security audit
> is published at [`docs/open-source-security-risk-report.md`](./docs/open-source-security-risk-report.md).
> The P0 items in that report are being addressed for **v0.6.1 stable**, targeted for early June 2026.

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

## Known Risk Surface (v2.1 public beta)

If you self-host on the public internet, read [**`/deploy/production`**](https://anet.sh/deploy/production)
before opening firewall ports. The headline items:

1. **Default credentials** `admin / anethub` — change immediately on first start
2. **Open-mode server** when `COMMHUB_AUTH_TOKEN` is unset — `requireAuth()` bypasses
3. **tmux control plane** in open mode allows remote terminal read/write ≈ RCE
4. **Multi-tenant scope** is incomplete — any valid token can read global tasks / SSE
5. **Agent nodes** run with `dangerouslySkipPermissions: true` by default — agents can call any tool without confirmation. Treat agents as untrusted code, run them in disposable working directories
6. **Plain HTTP** is the default — production deployments must front the Hub with a TLS reverse proxy (Caddy / Nginx)

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

- **v0.6.1** (early June 2026): close P0 items — default `requireAuth`, default `127.0.0.1`,
  random initial password, tmux off by default, MCP/SSE network scope enforcement
- **v0.7** (~ July 2026): Argon2id passwords, token TTL + revoke-all, `chmod 600` on secret
  files, pinned + checksummed install scripts
- **v0.8+**: signed releases, SLSA provenance, optional E2EE for inter-agent messages
