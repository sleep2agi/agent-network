# Agent runtime v2.5.0-preview.132 — release candidate, not published

This runtime is paired with CLI2.3.0-preview.166 and Hub0.9.0-preview.124.
Publish only after this commit is merged into main, using the formal workflow
bound to a full40 main SHA. Branch tarballs are test-only.

## Install

After formal publication and registry-byte verification, install in a private
Daemon software directory, not a business node's global installation:

```bash
npm install --prefix ./anet-daemon-pair @sleep2agi/agent-node@2.5.0-preview.132 @sleep2agi/agent-network@2.3.0-preview.166
```

## Upgrade

Publish and verify Hub0.9.0-preview.124 first, then this runtime, then CLI166.
Use the existing procedure in docs-site/docs/deploy/daemon.md to switch only
the selected idle Daemon to the private .166/.132 pair. Retain its original
node_id, configuration, credential ownership and previous software directory.
Verify actual versions, SSE and redacted Provider operation receipts.
Do not copy another node's Codex login, adopt or restart unrelated nodes.

## Recovery and scope

The runtime remains the execution component of the Daemon Provider flow;
installation alone does not create credentials or prove model entitlement.
Back up private account/Provider data separately from source. Roll back the
selected launch path to the retained pair without deleting credential state.
The shared core, vault-key requirements and recovery boundaries are recorded
in release-v2.3.0-preview.166.md in this directory. This is not a release receipt.
