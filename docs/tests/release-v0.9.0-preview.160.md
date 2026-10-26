# CommHub Server — the Hub now reports how many MCP requests are in flight, v0.9.0-preview.160

Ships `main` after `.159`. **One observable added; nothing is rejected, queued or throttled.**

```
@sleep2agi/commhub-server@0.9.0-preview.160
```

## Why

On 2026-10-25 the Hub was `SIGKILL`ed twice by pm2's old 2 GiB `max_memory_restart` while its
resident set hit 2.3 GB. The fix started as an SSE problem (`.159`: one encode per broadcast, degraded
subscribers skip instead of queueing), but the deeper question kept coming back: **what actually
predicts the resident set?**

Measured on an isolated Hub running `.159` against a **copy of the production database**
(367 sessions), capped with `systemd-run --user --scope -p MemoryMax=2G`:

| workload | resident set |
|---|---|
| `send_message` **sequential**, 3,255 messages in 60 s (≈54/s) | **flat at 151–156 MB** |
| 50 concurrent requests in flight | 249 MB |
| 100 concurrent | 446 MB |
| 200 concurrent | 689 MB |
| `get_inbox` 50 / 100 concurrent | 268 / 405 MB (**same shape**) |

So the driver is **requests in flight** (≈1.2–1.4 MB each, at the MCP transport layer), **not** messages
per second, and it is not tool-specific. Production agrees: the last ~2.5 h of log (8,929 s, 91,990 tool
calls) shows p50 10 / p95 19 / **max 51 calls per second** — far from the cliff — and the busiest seconds
cluster at `HH:14:4x`, i.e. the fixed **3-minute heartbeat boundary**.

`/health` already reported `sse_connections`, which only counts **long-lived** streams. It could not see a
burst of short requests, so "why did RSS jump to 450 MB for thirty seconds" was unanswerable after the fact.

## What changed

| file | change |
|---|---|
| `server/src/mcp-inflight.ts` (new) | in-flight counter + high-water mark + idempotent release; pure memory, no IO |
| `server/src/server.ts` | `/mcp` enters the counter **before** the transport is constructed; both exits settle it (an exception from `handleRequest`, and `mcpServer.close()`); `/health` gains `mcp_inflight` and `mcp_inflight_peak` (aggregates — safe for the anonymous watchdog contract) |
| `server/src/mcp-inflight.test.ts` (new) | 7 assertions, including one that **forbids `429` / `hub_busy` / `Retry-After` in the `/mcp` block** — so a "just add a metric" release cannot quietly become a limiter |

### Reading the two numbers

- `mcp_inflight` — requests being handled **right now**;
- `mcp_inflight_peak` — high-water mark since process start. It does **not** decay, so it answers
  "did we ever touch the cliff" separately from "are we in it now".

Calibration done during development: driving 200 concurrent `get_inbox` calls, `/health` reported
`mcp_inflight = 200` at the same moment the process was at **675 MB** (baseline 113 MB) — the online gauge
and the offline experiment agree.

### Boundary — read this before asking for a limit

The counter settles when `mcpServer.close()` completes, so it is a **lower bound on the handling phase**,
not an exact stream lifetime. Nothing was added to reject requests: bounding in-flight requests
(`ANET_MCP_MAX_INFLIGHT`, `429` + `Retry-After`) is a **separate change** that needs a day of real
distribution first, plus confirmation of how agent nodes back off on `429`. See
`docs/runbooks/hub-memory-and-sse.md`.

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.160
commhub-server --version   # 0.9.0-preview.160
```

## Upgrade

```bash
commhub-server --version                     # 0.9.0-preview.159 or older
npm i -g @sleep2agi/commhub-server@0.9.0-preview.160
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d["mcp_inflight"], d["mcp_inflight_peak"])'
```

Expected after upgrading: the version line prints `0.9.0-preview.160` and the two gauge values are
integers (usually small — single digits at idle).

## Verification

- `server/src/mcp-inflight.test.ts` — 7 pass; `health-redaction.test.ts` — 25 pass (anonymous callers still
  get aggregates only);
- `scripts/verify-hub-release.sh` now probes `mcp_inflight` for this version;
- isolated Hub, production DB copy: 0/0 at idle → 120 under a 120-request burst → back to 0.
