# Runtime 2.5.0-preview.135 — Provider and scoped secrets candidate, NOT PUBLISHED

Pairs exactly with CLI 2.3.0-preview.169. The daemon reads and reconciles
explicit HTTP Hub/Provider configurations, without claiming transport
encryption or automatically switching a node. HTTPS remains recommended.

#1053 enables Daemon/node private environment-key management: Daemon defaults
and node overrides reach the runtime's child processes on a complete restart.
Names-only receipts do not imply a running node has consumed a new value.
The Daemon also routes managed OpenCode co-presence stop/delete through the
complete pinned CLI cleanup instead of relying only on orphan process signals.

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
Scoped-key core: docs/tests/report-test1053-scoped-secrets.txt. OpenCode stop
correction: docs/tests/report-test1045-opencode-stop.txt; exact real-client
Docker gate must pass before merge, not just its routing unit tests.
Existing startup
scripts, topology, credential sources and schema are unchanged. Verify actual
process versions, SSE and redacted catalog receipt after selected activation.
Git restores software, not accounts, sessions or private Provider state; those
require the original protected backups or owner login. Publication alone is
not activation, model access proof or a native installer result.
Back up scoped-secrets.json and secrets-source.json as documented in
docs/scoped-secrets.md. Hub management requests are transient and must be
reissued explicitly if lost at a Hub restart; never report lost requests saved.
