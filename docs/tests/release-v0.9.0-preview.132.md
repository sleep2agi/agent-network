# CommHub Server v0.9.0-preview.132

Node task attribution on MCP and HTTP uses the credential's verified node ID,
including nodes that have not reported a session. Rename preparation and commit
both check aliases reserved by nodes as well as registered sessions. Existing
user attribution, unbound legacy node credentials and network isolation remain
covered by the transport tests.

This is a release candidate until the exact merged main commit passes all four
formal release gates and the registry publication checks. No production schema,
dependency, credential source, port or provider changes are required.

## Install

After publication:

```sh
bun add --global @sleep2agi/commhub-server@0.9.0-preview.132
```

## Upgrade

Follow `deploy/hub/README.md`: install the pinned public package into an inactive
sibling runtime, verify whole-package bytes against the exact main release
artifact, make a consistent private database backup, run the isolated upgrade
preflight and activate only the selected Hub. Preserve the existing vault-key
source, Bun executable, PM2 identity, database, ports and proxy configuration.
Retain the previous runtime for software rollback; production data and keys
remain in private backup and credential sources.
