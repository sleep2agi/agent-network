# CommHub Server v0.9.0-preview.132

Node task attribution on MCP and HTTP uses the credential's verified node ID,
including nodes that have not reported a session. Rename preparation and commit
both check aliases reserved by nodes as well as registered sessions. Existing
user attribution, unbound legacy node credentials and network isolation remain
covered by the transport tests.

Published from exact main `c49e9316826a064f1db715319fcc7adbde12527a`
by formal run38335516515 (build, four gates, preview publication and
registry checks all succeeded). Activated2026-10-13 10:17:29+08 with deployment
main `53e23e7421138967e0f6534aa6e1ad1fb8d66c42`; evidence:
report-test691-hub132-activation.txt. No production schema,
dependency, credential source, port or provider changes are required.

## Install

Published preview package:

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
