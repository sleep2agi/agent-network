# CommHub Server — slow SSE subscribers stop growing the heap, v0.9.0-preview.159

Ships `main` after `.158`. One tunable added; no event semantics, routes or payloads changed.

```
@sleep2agi/commhub-server@0.9.0-preview.159
```

## Why

The Hub's resident set had been jumping to **2.3–3.6 GB** in production, and pm2's old 2 GiB
`max_memory_restart` killed the process twice on 2026-10-25 (20:37, 21:19). Measured on an isolated
Hub with a **copy of the production database** (367 sessions / 336 nodes, baseline 67–74 MB),
driving N slow SSE subscribers (64-byte reads) while pushing messages:

| load | messages | RSS start → peak | delta |
|---|---|---|---|
| 120 subscribers × 60 s @20/s | 980 | 87.9 → 262.3 MB | +174 MB |
| 150 subscribers × 60 s @60/s | 2760 | 184.6 → 550.8 MB | +366 MB |
| 150 subscribers, tighter caps | 2790 | 66.9 → **2064.6 MB** | +1998 MB (142 MB after 40 s idle) |

Two hypotheses were ruled out with the same harness: **idle reconnect churn** (150 connections × 10
cycles: +6.7 MB) and the **heavy snapshot endpoints** (`/api/status` ×20 sequential and ×40
concurrent: 119 MB peak, p50 1.36 s).

## What changed (`server/src/push.ts`)

1. **One encode per broadcast.** `pushEvent` / `pushUserEvent` / `pushNetworkObserverEvent` used to
   call `client.encoder.encode(data)` *per subscriber* — 150 connections × 30 events/s is 4,500
   short-lived `Uint8Array`s per second. They now encode once into a shared read-only buffer.
2. **Degraded subscribers skip instead of queueing.** A new tunable
   `ANET_SSE_COALESCE_AT_BYTES` (default **65,536**) makes non-critical frames a no-op for a
   connection that is already more than 64 KB behind; the skip is counted (process-local
   `sseDegradedDropCount()`). **Critical frames — the `connected` greeting and `: keepalive` — are
   still enqueued**, so liveness probing and the initial handshake keep working.
3. **Existing bounds unchanged.** The 1 MB hard ceiling (`ANET_SSE_MAX_QUEUE_BYTES`) is still
   checked *first* and still closes the stream; the `STUCK_CLOSE_MS` (30 s) reaper still collects
   connections that never read again. Order matters: ceiling → skip → enqueue.

Nothing else moved: same event names, same payloads, same routes, same `/api/status` projection.

## Acceptance (run against the published artifact)

Same harness, 150 subscribers × 60 s @60/s:

- RSS delta ≤ **100 MB** (was +366 MB, peak 2 GB);
- after 40 s idle, RSS back to baseline ±20 MB;
- slow subscribers are **counted**, never silently swallowed.

Grey release without a version bump is possible today: lower
`ANET_SSE_COALESCE_AT_BYTES` / `ANET_SSE_MAX_QUEUE_BYTES` / `ANET_SSE_STUCK_CLOSE_MS` on the
running Hub and watch RSS before taking the release.

## Tests

- `server/src/push.test.ts` — 26 pass. The non-reading-consumer test was rewritten to assert the new
  contract: the queue stops growing at the coalesce threshold, the skip is counted, and the stuck
  reaper still closes the connection afterwards.
- `server/src/observer-push.test.ts` — 9 pass (observer broadcast path encodes once as well).
- `doc-symbol-pins` (both `docs/` and `docs-site/`) OK after following the moved anchor.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v159-preview159"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.159
```

## Upgrade

```bash
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
DIR="$HOME/.commhub/runtime-v159-preview159"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.159"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# point HUB_RUNTIME_DIR at $DIR, then
pm2 reload commhub-hub --update-env
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.159"'
```

## Not in this release

No permission change, no MCP tool change, no `/api/status` byte-contract change, no `latest`
dist-tag move.
