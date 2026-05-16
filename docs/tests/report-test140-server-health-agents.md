# Test 140 — v0.10 server health/agents endpoints

Date: 2026-05-16

Scope:
- `report_status` host disk telemetry + `process_telemetry` persistence
- `GET /api/server/:host/health`
- `GET /api/server/:host/agents`
- `GET /api/status` surfaces nested `host` + `process_telemetry`
- SSE `status_update` includes `process_telemetry`
- Regression gates: `GET /api/servers`, `GET /api/messages`, broadcast loop, SSE cross-network isolation

Commands:

```bash
cd /home/vansin/agent-orchestra
bunx tsc --noEmit # from server/
git diff --check
sg docker -c 'docker build -t anet-qa-hub-13-server-health -f tests/qa-hub-13-server-health-agents/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-13-server-health'
sg docker -c 'docker build -t anet-qa-hub-10-regression -f tests/qa-hub-10-network-scope-regressions/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-10-regression'
sg docker -c 'docker build -t anet-qa-hub-12-regression -f tests/qa-hub-12-servers-endpoint/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-12-regression'
```

Results:

```text
PASS qa-hub-13 server health/agents endpoints (#140 Hero 1+2 ✓ / regression gates ✓)
health_endpoint_p99_seconds=0.005639

PASS qa-hub-10 network scope regressions (#67 message ✓ / #54 SSE isolation ✓)
PASS qa-hub-12 servers endpoint (#119 host telemetry aggregation ✓ / network scope ✓)
```

Endpoint evidence from Docker smoke:

```json
{
  "health": {
    "ok": true,
    "host": "hero-box",
    "agent_count": 2,
    "alert_level": "red",
    "latest": {
      "cpu_pct": 90,
      "mem_avail_gb": 0.4,
      "disk_avail_gb": 0.8
    },
    "history": {
      "5m": "non-empty",
      "1h": "non-empty",
      "24h": "non-empty"
    }
  },
  "agents": {
    "ok": true,
    "host": "hero-box",
    "agent_count": 2,
    "agents_checked": [
      {
        "alias": "hero-a2",
        "runtime": "codex-sdk",
        "health": "online",
        "progress": 66,
        "process_in_flight_count": 2,
        "process_cpu_pct": 80.1,
        "process_telemetry": {
          "rss_bytes": 223456789,
          "rss_mb": 213.1,
          "cpu_pct": 80.1,
          "uptime_seconds": 200,
          "in_flight_count": 2
        }
      }
    ]
  }
}
```

Regression notes:
- Same hostname/IP in another network did not leak into `/api/server/:host/health` or `/agents`.
- Old clients without `process_telemetry` surface null process fields.
- New clients with `rss_bytes/rss_mb/cpu_pct/uptime_seconds/in_flight_count` persist all five fields.
- `GET /api/servers` aggregate remained array-shaped and returned latest host metrics.
- `GET /api/messages` returned within `--max-time 2` after task write.
- `status_update` SSE includes `process_telemetry`.
- Broadcast SSE event in network A did not appear in network B subscriber.
