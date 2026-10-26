# agent-node — spread the first SSE reconnect so a hub restart does not herd 300+ requests, v2.5.0-preview.164

Ships `main` after `.163`. Timing-only change on the reconnect path; no wire format, no new fields.

```
@sleep2agi/agent-node@2.5.0-preview.164
```

## Why — measured on the Hub, not guessed

Hub `0.9.0-preview.160` added `/health.mcp_inflight` / `mcp_inflight_peak`. On the production Hub,
**59 seconds after the restart that shipped it**:

```
mcp_inflight 0 | mcp_inflight_peak 308 | sse 150 | sessions 367
```

308 requests in flight at the same moment, while the steady state is **0**. With the measured cost of
≈1.2–1.4 MB per in-flight MCP request, that is **≈400 MB** — the same magnitude as the "RSS suddenly
450 MB, then falls back" episodes that used to be unexplainable.

Root cause: every node's SSE stream breaks at the same instant when the Hub restarts, and the existing
`±25%` jitter only spreads a 1 s base delay over **750–1250 ms**. With 367 sessions that is ~300
requests inside a half-second window.

## What changed

| file | change |
|---|---|
| `agent-node/src/util/supervise-child.ts` | new `firstRetrySpreadMs` (default 0 = previous behaviour): adds `0…N` ms **only to the first retry after a stable connection drops**; exponential backoff (2/4/8/30 s) is unchanged, and `deferNextAttempt`'s floor still wins |
| `agent-node/src/cli.ts` | `connectSSE` passes `firstRetrySpreadMs: 8_000` |
| `agent-node/src/util/herd-spread.test.ts` (new) | 4 assertions: default unchanged / range arithmetic / **only the first retry is spread** (second is a plain doubling) / `deferNextAttempt` floor wins |
| `docs/runbooks/hub-memory-and-sse.md` | how to read `mcp_inflight` vs `mcp_inflight_peak`, the three spike classes (herd / slow-request pile-up / leak), and **the correct way to read the Hub's RSS** (socket-inode lookup — reading the wrapper PID over-reports by ~80–100 MB) |

### Arithmetic (why 8 s)

367 nodes ÷ 8 s ≈ **46 arrivals per second** on average instead of ~300 inside 0.5 s, and every node is
back within ~10 s (`register()` runs immediately after each successful connect, so the dashboard does
not show a long offline gap).

## What this does NOT do

- Does not touch heartbeats (that was `.163`) or the wire protocol;
- Does not add server-side rejection: bounding in-flight requests at the Hub (`429` + `Retry-After`) is
  deliberately **not** the first move — rejecting during a reconnect storm makes clients retry and can
  amplify it.

## Install

```bash
set -e
npm install -g @sleep2agi/agent-node@2.5.0-preview.164
agent-node --version   # 2.5.0-preview.164
```

## Upgrade

```bash
agent-node --version                        # 2.5.0-preview.163 or older
npm i -g @sleep2agi/agent-node@2.5.0-preview.164
agent-node --version                        # 2.5.0-preview.164
anet node list                              # restart running nodes so they exec the new binary
```

## Verification

`herd-spread.test.ts` + `supervise-child.test.ts` = **19 pass** · `bun run build` OK ·
typecheck ratchet **81 = baseline**.

Runtime evidence (the part that needs a live Hub) comes from re-deploying the Hub while watching
`mcp_inflight_peak` on the new node version: the peak after a restart should drop well below 308.
