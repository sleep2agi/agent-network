# qa-hub-12-servers-endpoint

Regression coverage for issue #119 step 2.

- `report_status` accepts agent-node `host` telemetry.
- `GET /api/servers` aggregates sessions by `hostname` / `ip`.
- Latest host metrics are used for each server group.
- REST network scoping prevents one user's server list from seeing another network.

