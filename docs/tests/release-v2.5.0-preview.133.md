# Agent runtime 2.5.0-preview.133 — #1027 release candidate, NOT PUBLISHED

Daemon child creation persists `network_id`. Omitted OpenCode generation
explicitly stays V1; V2 still requires explicit generation and unsafe opt-in.
Pair: CLI2.3.0-preview.167 / runtime2.5.0-preview.133 / Hub0.9.0-preview.126.
Publish only through the main-SHA release workflow; never reuse PR artifacts.

## Install

After formal publication and registry-byte verification, install privately:

```bash
npm install --prefix ./anet-daemon-pair @sleep2agi/agent-node@2.5.0-preview.133 @sleep2agi/agent-network@2.3.0-preview.167
```

## Upgrade

Publish/activate Hub126 first, then runtime133, then CLI167. Follow the existing
`docs-site/docs/deploy/daemon.md` procedure for one selected idle Daemon.
Retain its node_id, original configuration, private credentials and old pair.
Verify actual versions, SSE and a newly created child's network scope and
generation. A software upgrade does not rewrite existing child configurations
or require a blanket restart of business nodes. Do not copy Codex login state.

## Evidence and recovery

The original #1027 Docker CI and `report-test1027-ci-evidence.txt` record bounded
source-level evidence; final release gates and three-runtime acceptance remain
separate. Native V2 plus a rendered Web IPC client is not an installed desktop
or Android package, real OAuth login or vendor model-entitlement proof.
Use checked-in Daemon startup procedures; no new service, port or secret source.
Rollback selects the retained private pair/configuration without deleting node
state. Private sessions/accounts need secure backup or owner login, not Git.
