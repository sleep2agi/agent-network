# ANet CLI 2.3.0-preview.167 — #1027 release candidate, NOT PUBLISHED

Updates the exact Daemon software pair to runtime2.5.0-preview.133, containing
the child-network and omitted-OpenCode-generation fixes. Hub0.9.0-preview.126
provides the corresponding network_id response. No new UI or Provider adapter
is advertised. The existing Hub compatibility floor is unchanged; it is not
the required version for this specific fix.

All three candidates must pass their gates, merge normally, and be rebuilt
through `release.yml` from a full40 main ancestor. Publish Hub126 -> runtime133
-> CLI167. Do not publish branch artifacts or change the npm latest channel.

## Install

After formal publication and anonymous tarball-byte verification:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.167 @sleep2agi/agent-node@2.5.0-preview.133
```

Operators should use a private selected-Daemon pair instead of altering business
node installations. See `docs-site/docs/deploy/daemon.md` for the startup path.

## Upgrade

This fix requires Hub0.9.0-preview.126 and the .167/.133 Daemon pair; client
0.2.244 alone does not upgrade either service. Follow `deploy/hub/README.md`
to activate the verified Hub package, then switch only a selected idle Daemon's
launch path. Verify exact running versions, original identity, SSE and new
child creation. Never relabel .166/.132 or Hub125 as containing this fix.
No global package, account, pending task or existing session is mutated by
preparing these release notes.

## Recovery and rollback

Authority: `deploy/hub/`, the Daemon guide, exact source and formal package
digests. Existing ports/proxy/tunnels remain unchanged. Obtain secrets from
their existing protected sources; do not commit values or copy login files.
Keep consistent encrypted Hub DB/vault-key backups and private Daemon state
separate from Git. Roll back the selected software/configuration to the retained
pair; do not erase sessions or credentials. Software publication is not data
restoration, production activation or complete three-runtime acceptance.
