# qa-hub-13-server-health-agents

Regression suite for v0.10 Hero server drawer endpoints.

Coverage:

- `report_status` persists host disk telemetry and process telemetry.
- `GET /api/server/:host/health` returns latest health, alert level, and 5m/1h/24h history.
- `GET /api/server/:host/agents` returns per-host agent details and health chips.
- Existing `GET /api/servers` and `GET /api/messages` remain usable.
- Broadcast/SSE network-scope loop remains isolated across networks.
