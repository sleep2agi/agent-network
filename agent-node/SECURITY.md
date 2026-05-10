# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, **please do not open a public issue**.

Instead, use **[GitHub Private Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new)** to report privately.

Please include:

- A clear description of the vulnerability
- Steps to reproduce (PoC welcome)
- Affected versions
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

## Out of Scope

- Vulnerabilities requiring a compromised local machine (e.g. attacker already has filesystem access to `~/.commhub/commhub.db`)
- Issues in dependencies — please report upstream first; we'll update once a fix is published
- DoS via resource exhaustion on a self-hosted Hub (run behind a rate limiter / WAF)

## Disclosure Policy

We follow **coordinated disclosure**: once a fix is released, we publish an advisory referencing the CVE (if assigned) and credit the reporter.
