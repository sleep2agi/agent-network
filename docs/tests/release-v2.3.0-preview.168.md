# CLI 2.3.0-preview.168 — OpenCode selected-model release candidate, NOT PUBLISHED

Pairs with runtime 2.5.0-preview.134 to deliver main-merged #894 ACP selected-model
binding. V2 creation/config alignment and launch health remain existing main
behavior. Unavailable V1 selections must not silently use the default model.
No live OAuth, vendor entitlement, native client or all-runtime claim.

## Install

After formal main-SHA publication and anonymous package-byte verification:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.168 @sleep2agi/agent-node@2.5.0-preview.134
```

## Upgrade

Publish runtime .134 first, then CLI .168 using the same exact merged main SHA.
Existing verified Hub .126 stays in place; no new Hub release is required.
Follow docs-site/docs/deploy/daemon.md for a selected private software pair;
retain identity/config, credentials, sessions and the old pair. Publication does
not switch a running Daemon or upgrade business nodes. Client .247 alone does
not install this unreleased pair.

## Evidence and recovery

PR2559 and report-test894-main-restack.txt retain core/protocol Docker evidence.
Real safe ACP CI uses isolated TLS/model fixtures, not vendor credentials.
Formal release/install gates remain separate. Authority: docs/RELEASE-SOP.md,
.github/workflows/release.yml and the Daemon guide. No new launcher, port/proxy,
tunnel, key source or database migration. Rollback selects the retained private
pair/config without deleting sessions; production accounts/data require protected
backups or owner login.
