# CommHub Server v0.9.0-preview.130

Session registrations now participate in node-token refresh authorization. Verified holder refresh and administrator recovery remain available, while existing node ownership, network membership and Agent restrictions retain their existing boundaries.

This release changes no dependencies, database schema, ports, provider configuration or secret sources. Runtime activation follows the pinned main-only process in `deploy/hub/README.md`; preserve the previous runtime and a consistent database backup before activation.

Release and live-activation evidence will be appended after their respective gates complete. A merged candidate alone does not establish publication or live deployment.

## Install

After the formal main release gates publish the preview package:

```sh
bun add --global @sleep2agi/commhub-server@0.9.0-preview.130
```

## Upgrade

Managed deployments use a versioned sibling install, consistent SQLite backup and retained previous runtime, following `deploy/hub/README.md`. Verify the published package and pinned main deployment profile before restarting the selected Hub. Preserve the existing vault-key source, PM2 identity, Bun executable, database, port and proxy configuration. Software rollback selects the retained preview.129 runtime; production data and keys come from their existing private backups and credential sources, not Git.
