# agent-node — heartbeat jitter so hubs do not get a synchronized burst, v2.5.0-preview.162

Ships `main` after `.161`. Timing-only change; no wire format, no new fields.

```
@sleep2agi/agent-node@2.5.0-preview.162
```

## Why

Measured on an isolated Hub with a **copy of the production database** (capped with
`systemd-run --user --scope -p MemoryMax=2G`):

| workload | Resident set |
|---|---|
| `send_message` **sequential**, 3,255 messages in 60 s (≈54/s) | **flat at 151–156 MB** |
| **50 concurrent** in flight | 249 MB |
| **100 concurrent** | 446 MB |
| **200 concurrent** | 689 MB |
| `get_inbox` 50 / 100 concurrent | 268 / 405 MB (same shape as `send_message`) |

So the Hub's memory tracks **requests in flight** (≈1.2–1.4 MB each, at the MCP transport
layer), **not** messages per second, and **not** SQLite.

That matters because every node reports on a **fixed 3-minute** cadence and copresence nodes
refresh session control every **30 s** — i.e. hundreds of nodes arrive on the same second:

```
production log, 8,929 s window, 91,990 tool calls
per-second calls: p50 10 · p95 19 · max 51
busiest seconds cluster at HH:14:4x  ← the 3-minute heartbeat boundary
```

## What changed

| site | before | after |
|---|---|---|
| status heartbeat | `setInterval(…, 180 s)` | `setTimeout` → re-arm each time, adding **0–20 % jitter** (≤30 s by default), `unref`'d |
| copresence session-control refresh | `setInterval(…, 30 s)` | same pattern with **0–30 % jitter** (≤9 s) |
| heartbeat tick body | — | unchanged: full-load retry / in-turn "working" / idle |

New tunable: `ANET_STATUS_HEARTBEAT_JITTER_MS` (0…60 000; `0` disables jitter — tests use that).
Average reporting cadence is unchanged in practice (jitter averages 10 % of one interval).

## Proof that the jitter cannot silently regress

`src/runtime/heartbeat-jitter.test.ts` (4 source assertions):

- the heartbeat must go through `setTimeout(...) + scheduleHeartbeat()` and call `Math.random()`;
- the jitter must be overridable and switchable off;
- session-control refresh must **not** be a bare `30 s setInterval`;
- the three tick branches must still be there.

## Install

```bash
set -e
npm install -g @sleep2agi/agent-node@2.5.0-preview.162
agent-node --version   # 2.5.0-preview.162
```

## Upgrade

```bash
agent-node --version                       # 2.5.0-preview.161 or older
npm i -g @sleep2agi/agent-node@2.5.0-preview.162
agent-node --version                       # 2.5.0-preview.162
anet node list                             # restart running nodes so they exec the new binary
```

## What this does NOT fix

The **server-side** half — bounding requests in flight at the MCP entry (bounded queue, `429` +
`Retry-After` beyond the cap) — is a separate change and needs its own grey release. Until then
the Hub's 6 GiB `max_memory_restart` remains the operating envelope; see
`docs/runbooks/hub-memory-and-sse.md`.

## Verification

`bun run build` OK · typecheck ratchet **81 = baseline** · 4/4 jitter assertions pass.
