# Test #119 — CommHub `/api/servers` aggregation

Date: 2026-05-15

## Scope

- `report_status` accepts agent-node `host` telemetry payload.
- `sessions` persists nullable CPU/RAM host telemetry fields.
- `GET /api/servers` groups agents by `hostname` / `ip`.
- Latest host telemetry wins per server group.
- REST network scope prevents cross-network server data leakage.

## Commands

```bash
cd /home/vansin/agent-orchestra
cd server && bunx tsc --noEmit
sg docker -c 'docker build -t anet-qa-hub-12-servers -f tests/qa-hub-12-servers-endpoint/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-12-servers'
```

## Result

```text
PASS qa-hub-12 servers endpoint (#119 host telemetry aggregation ✓ / network scope ✓)
```

Status: PASS
