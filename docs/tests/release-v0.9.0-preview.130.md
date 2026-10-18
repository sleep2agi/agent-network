# CommHub Server v0.9.0-preview.130

Published from exact main `7f12230b7eb064aa56131bbc17fc21c944f9a6d0` by formal run38326074270 (four gates, preview publication and registry checks succeeded). Activated2026-10-13 08:21:23+08 from main deployment `d8537c633dc3573419c1bd1d8b28ea5c394212c1` (PR2669). Full evidence: report-test689-hub130-activation.txt.

Session registrations now participate in node-token refresh authorization. Verified holder refresh and administrator recovery remain available, while existing node ownership, network membership and Agent restrictions retain their existing boundaries.

This release changes no dependencies, database schema, ports, provider configuration or secret sources. Runtime activation follows the pinned main-only process in `deploy/hub/README.md`; preserve the previous runtime and a consistent database backup before activation.

The public whole package equals the gated main artifact and all344 installed package files. Live PID, secured health and heartbeat checks confirm the selected runtime.

## Install

Published preview package:

```sh
bun add --global @sleep2agi/commhub-server@0.9.0-preview.130
```

## Upgrade

Managed deployments use a versioned sibling install, consistent SQLite backup and retained previous runtime, following `deploy/hub/README.md`. Verify the published package and pinned main deployment profile before restarting the selected Hub. Preserve the existing vault-key source, PM2 identity, Bun executable, database, port and proxy configuration. Software rollback selects the retained preview.129 runtime; production data and keys come from their existing private backups and credential sources, not Git.
