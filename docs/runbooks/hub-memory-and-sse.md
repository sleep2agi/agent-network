# Runbook — Hub memory spikes and SSE backpressure

**Applies to**: a production `commhub-hub` (pm2) that goes unresponsive for seconds or is
restarted by pm2.
**Born from**: 2026-10-25/26, two `SIGKILL`s at 20:37 and 21:19 plus a measured 2.0–3.6 GB RSS spike.

## 1. First check: was it pm2's own memory cap?

```bash
grep -n "max-memory-restart\|exceeds\|SIGKILL" ~/.pm2/pm2.log | tail -20
```

A line like this means **pm2 killed the Hub**, not the code, not the kernel:

```
[PM2][WORKER] Process 3 restarted because it exceeds --max-memory-restart value
  (current_memory=2331094964  max_memory_limit=2147483648)
App [commhub-hub:3] exited with code [0] via signal [SIGKILL]
```

If `current_memory` is at the limit, see §2. If instead you see a stack trace, it is a code
crash — different problem.

## 2. Give the Hub headroom (30 seconds, no redeploy)

```bash
env -i HOME=$HOME PM2_HOME=$HOME/.pm2 LOGNAME=$USER USER=$USER LANG=C.UTF-8 \
  PATH=$HOME/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin \
  $HOME/.nvm/versions/node/v20.20.0/bin/pm2 restart commhub-hub --max-memory-restart 6G --update-env
# verify
curl -s localhost:9200/health | head -c 120
```

(`HOME`/`PM2_HOME` are explicit on purpose: a node process's `HOME` must not leak into pm2.)

## 3. Measure, don't guess

Sample RSS + connection counts every minute (read-only; do **not** inject load on a host that
also runs production):

```bash
PID=$(pm2 jlist | python3 -c 'import sys,json;print([a["pid"] for a in json.load(sys.stdin) if a["name"]=="commhub-hub"][0])')
awk '/VmRSS/{print int($2/1024)" MB"}' /proc/$PID/status
curl -s localhost:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["sse_connections"],d["sessions_count"])'
```

What we learned from controlled experiments (isolated Hub + a **copy** of the production DB,
capped with `systemd-run --user --scope -p MemoryMax=2G`):

| workload | effect |
|---|---|
| 150 idle reconnects ×10 rounds | +6.7 MB — **not** the cause |
| 30 concurrent plain HTTP `/health` (2370 req) | RSS flat at 81 MB — **not** the cause |
| SQLite-only inserts 60 rows/s | +17 MB — **not** the cause |
| `send_message` at 18–40 msg/s | 165–199 MB peak — fine |
| `send_message` at **~57 msg/s sustained 60 s** | **2.0 GB → OOM at the 2 GB cap** |

So: the spike is a **sustained message-throughput** phenomenon, not "many SSE clients" and not
"slow SQLite".

## 4. What the Hub already does about it

`server/src/push.ts`:

- per-connection queue is **byte-metered** (`highWaterMark: 0, size: c => c.byteLength`);
- **hard ceiling** `ANET_SSE_MAX_QUEUE_BYTES` (default 1 MB) → closes the stream;
- **stuck timeout** `ANET_SSE_STUCK_CLOSE_MS` (default 30 s) → reaps a connection that is behind;
- since `0.9.0-preview.159`: **degraded subscribers skip non-critical frames** once they are more
  than `ANET_SSE_COALESCE_AT_BYTES` (default 64 KB) behind (counted, never silently swallowed),
  and each broadcast is encoded **once** instead of per subscriber.

Operators can tighten these **without a redeploy**:

```bash
ANET_SSE_COALESCE_AT_BYTES=65536
ANET_SSE_MAX_QUEUE_BYTES=262144
ANET_SSE_STUCK_CLOSE_MS=30000
```

Set them in the pm2 env (or `hub-daemon.sh`) and restart with `--update-env`; then watch RSS while
the traffic pattern is normal.

## 5. When a spike is happening right now

1. Confirm it is the Hub: `curl -m 3 localhost:9200/health` — a timeout with `uptime` still
   increasing means "alive but stalled", not "crashed".
2. Note `sse_connections` and the log write rate (`stat -c %s ~/.commhub/pm2-hub-out.log` deltas) —
   that separates "many subscribers" from "many messages".
3. If the Hub is above your cap and you must act: raise the cap (§2) rather than restart — a
   restart drops 100+ live sessions and every subscriber must reconnect at once.

## 6. Known open item

`ANET-CARD #2363` tracks the remaining question: **which allocation inside the message path grows
with sustained throughput**. Candidates being tested: per-request buffering in the MCP transport,
inbox insert + per-message inbox COUNT, and broadcast serialization under load. Until that is
settled, the 6 GB cap plus the knobs above are the operating envelope.
