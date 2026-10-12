# Runtime 2.5.0-preview.135 — HTTP Provider candidate, NOT PUBLISHED

Pairs exactly with CLI 2.3.0-preview.169. The daemon reads and reconciles
explicit HTTP Hub/Provider configurations, without claiming transport
encryption or automatically switching a node. HTTPS remains recommended.

## Install

Only after formal full40 main-SHA publication and registry-byte verification:

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.135
```

## Upgrade

Publish Hub .127, runtime .135, then CLI .169, retaining latest unchanged.
Use the identity-matched private software pair documented in
docs-site/docs/deploy/daemon.md. Keep .168/.134 and original configuration
for rollback. Do not rotate credentials, migrate conversations or upgrade
business nodes implicitly.

## Evidence and recovery

Core behavior: docs/tests/report-test1045-provider-http.txt. Existing startup
scripts, topology, credential sources and schema are unchanged. Verify actual
process versions, SSE and redacted catalog receipt after selected activation.
Git restores software, not accounts, sessions or private Provider state; those
require the original protected backups or owner login. Publication alone is
not activation, model access proof or a native installer result.
