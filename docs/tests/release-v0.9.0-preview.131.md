# CommHub Server v0.9.0-preview.131

Task dispatch records the authenticated username for user credentials and the
verified node attribution for node credentials on HTTP and MCP. Human dispatch
attribution remains separate from node-ID backfill and inferred node lineage.

Published from exact main `e81debac14db091da41ea02272dd2184b3b1744f` by
formal run38331511688 (build, four gates, preview publication and registry
checks succeeded). Activated2026-10-13 09:32:15+08 from that main deployment.
Evidence: report-test696-hub131-activation.txt.

Source implementation is main `9fc79fab1d697f665bf3e95d7c420a27e284a4dd`
(PR2671). Isolated SQLite/PostgreSQL HTTP contracts, targeted assertion witnesses
and existing transport/origin checks passed. Public bytes equal the main gated
artifact and all345 installed package files. The selected live PID, secured
health and natural heartbeat checks confirm this runtime; the short observation
does not certify fleet-wide ACKs or model execution.

Dependencies, database schema, ports, provider configuration and secret sources
are unchanged. Managed activation follows `deploy/hub/README.md`, with a
consistent private database backup and the previous runtime retained.

## Install

Published preview package:

```sh
bun add --global @sleep2agi/commhub-server@0.9.0-preview.131
```

## Upgrade

Managed deployments install the exact pinned package into a new sibling runtime
and compare its complete public bytes with the main release artifact before
restarting the selected Hub. Preserve the existing vault-key source, PM2
identity, Bun executable, database, port and proxy configuration. Software
rollback selects the retained preview.130 runtime. Production data and keys
remain in their existing private backups and credential sources.

For task dispatch, user clients may omit `from` / `from_session` or specify
their authenticated username. Node dispatches use the corresponding node
credential. The unscoped development transport remains available.
