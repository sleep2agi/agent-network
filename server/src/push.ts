// ── SSE Push: 实时推送事件给 Agent ──────────────────
// Agent 连 GET /events/:session → 保持 SSE 长连接
// send_task 写 inbox 后 → pushEvent() → 秒达
//
// Backpressure & half-open contract (Round-2/4 fix per 通信龙):
//
// 0. **CRITICAL**: `desiredSize` units are determined by the stream's
//    queuing strategy. The web-streams default strategy is COUNT-based
//    (each chunk = 1 unit), so a 1 MB chunk only nudges desiredSize by
//    -1. That defeats the byte-cap entirely — pushing a million 1-byte
//    chunks is what trips the threshold, not 1 MB of real bytes.
//    Bun probe verified by 通信牛: default stream after 1 MiB chunk →
//    desiredSize 0, after 2 MiB → -1; byte strategy after 1 MiB → 0,
//    after 2 MiB → -1048576. We MUST construct the stream with an
//    explicit byte-counting strategy:
//       new ReadableStream(src, { highWaterMark: 0, size: c => c.byteLength })
//    With highWaterMark=0, every enqueued byte counts against the cap
//    directly. The HARD CEILING below then closes the stream at
//    -MAX_QUEUE_BACKPRESSURE_BYTES bytes of queued data, which is what
//    we actually want.
//
// 1. `ReadableStreamDefaultController.desiredSize` is the SSE queue
//    headroom in BYTES (given the strategy above). Positive = room,
//    0 = at high-water-mark, negative = over by that many bytes.
//    Without a bound, half-open TCP consumers (network drop, client
//    crash without FIN) silently accumulate bytes in the queue forever
//    — a public-hub OOM vector.
//
// 2. We bound it two ways:
//
//      a. HARD CEILING — `desiredSize < -MAX_QUEUE_BACKPRESSURE_BYTES`
//         → close the stream immediately. Single huge event can't blow
//         up a stuck client.
//
//      b. STUCK TIMEOUT — `desiredSize < 0` continuously for
//         `STUCK_CLOSE_MS` → close. Catches slow-trickle leaks where
//         the consumer accepts a byte every few seconds but can't keep
//         up.
//
// 3. Liveness: every `LIVENESS_SWEEP_MS` we re-check every registered
//    client even when nobody calls `pushEvent`, so a session that goes
//    half-open during a quiet period still gets reaped — not waiting
//    for the next inbox push.

import { eventBus, type RenameCommittedEvent } from "./event_bus";

// ─────────────────────────────────────────────────────────────────────
// Tunables (env-overridable for tests and ops)
// ─────────────────────────────────────────────────────────────────────
function envNum(k: string, fallback: number): number {
  const v = process.env[k];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Hard ceiling on per-client SSE queue backpressure before we drop the
 *  client. 1 MB by default — generous for normal bursts, lethal for the
 *  half-open consumer that has stopped reading entirely. */
const MAX_QUEUE_BACKPRESSURE_BYTES = envNum("ANET_SSE_MAX_QUEUE_BYTES", 1_000_000);

/** How long `desiredSize` can stay negative (i.e. consumer behind HWM)
 *  before we declare the client dead. 60s by default — past 2× the
 *  keepalive interval, so a live-but-slow consumer wouldn't trip it. */
const STUCK_CLOSE_MS = envNum("ANET_SSE_STUCK_CLOSE_MS", 60_000);

/** Keepalive cadence. Doubles as half-open liveness probe — if enqueue
 *  silently piles up bytes here, the stuck-timeout kicks in. */
const KEEPALIVE_MS = envNum("ANET_SSE_KEEPALIVE_MS", 30_000);

/** Liveness sweep cadence — proactive scan even when no events flow. */
const LIVENESS_SWEEP_MS = envNum("ANET_SSE_LIVENESS_SWEEP_MS", 15_000);

type SSEClient = {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  /** When desiredSize first went negative; cleared on successful drain. */
  stuckSince: number | null;
  /** Once true, the stream has been closed and the client should be
   *  evicted from the map on the next sweep / push. Guards against
   *  double-close. */
  closed: boolean;
  /** keepalive timer handle so it can be cleared on close. */
  keepaliveTimer?: ReturnType<typeof setInterval>;
  /** Stable key for log/diagnostic context. */
  key: string;
};

// 一个 session 可能有多个 SSE 连接（重连时短暂并存）
const clients = new Map<string, SSEClient[]>();

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function clientKey(sessionName: string, networkId?: string | null): string {
  return `${networkId || "global"}:${sessionName}`;
}

// ─────────────────────────────────────────────────────────────────────
// Close + dispatch helpers
// ─────────────────────────────────────────────────────────────────────

/** Close a client's stream (idempotent) and clear its keepalive timer.
 *  Does NOT remove from the map — leave that to the caller so it can
 *  prune the right index without re-finding it. */
function closeClient(client: SSEClient, reason: string): void {
  if (client.closed) return;
  client.closed = true;
  if (client.keepaliveTimer) clearInterval(client.keepaliveTimer);
  try {
    client.controller.close();
  } catch {
    // Already closed by the runtime, or controller errored. Either way
    // we're done with it.
  }
  console.log(`[${ts()}] SSE ✕ ${client.key} closed (reason=${reason})`);
}

/** Best-effort enqueue with backpressure guard. Returns:
 *    - "ok"    → bytes accepted, queue healthy
 *    - "dead"  → client closed; caller must remove from map */
function tryEnqueueBytes(client: SSEClient, bytes: Uint8Array): "ok" | "dead" {
  if (client.closed) return "dead";

  const ctrl = client.controller;
  // desiredSize may be null on a closed/errored stream — defensive
  // null-check, then treat null as "no headroom" since we can't enqueue
  // safely anyway.
  const desired = ctrl.desiredSize;
  if (desired === null) {
    closeClient(client, "controller-null-desired");
    return "dead";
  }

  // Hard ceiling: too far behind HWM, single push could OOM us. Close.
  if (desired < -MAX_QUEUE_BACKPRESSURE_BYTES) {
    closeClient(client, `queue-overflow-${Math.abs(desired)}b`);
    return "dead";
  }

  // Track stuck-since-when for the soft timeout below.
  if (desired < 0) {
    if (client.stuckSince === null) {
      client.stuckSince = Date.now();
    } else if (Date.now() - client.stuckSince > STUCK_CLOSE_MS) {
      closeClient(client, `stuck-${Date.now() - client.stuckSince}ms`);
      return "dead";
    }
  } else {
    client.stuckSince = null;
  }

  try {
    ctrl.enqueue(bytes);
    return "ok";
  } catch (e: any) {
    closeClient(client, `enqueue-throw:${e?.message || e}`);
    return "dead";
  }
}

/** Walk every client and close any that are stuck/half-open. Run on a
 *  timer so half-open detection doesn't depend on event traffic. */
function sweepLiveness(): void {
  const now = Date.now();
  for (const [key, arr] of clients) {
    const alive: SSEClient[] = [];
    for (const c of arr) {
      if (c.closed) continue;
      const desired = c.controller.desiredSize;
      if (desired === null) {
        closeClient(c, "sweep-null-desired");
        continue;
      }
      if (desired < -MAX_QUEUE_BACKPRESSURE_BYTES) {
        closeClient(c, `sweep-overflow-${Math.abs(desired)}b`);
        continue;
      }
      if (desired < 0) {
        if (c.stuckSince === null) c.stuckSince = now;
        else if (now - c.stuckSince > STUCK_CLOSE_MS) {
          closeClient(c, `sweep-stuck-${now - c.stuckSince}ms`);
          continue;
        }
      } else {
        c.stuckSince = null;
      }
      alive.push(c);
    }
    if (alive.length === 0) clients.delete(key);
    else if (alive.length !== arr.length) clients.set(key, alive);
  }
}

// Liveness sweep timer. Started lazily on first stream creation; never
// stopped in production (one timer for the lifetime of the process).
let livenessSweepTimer: ReturnType<typeof setInterval> | null = null;
function ensureLivenessSweep(): void {
  if (livenessSweepTimer) return;
  livenessSweepTimer = setInterval(() => {
    try {
      sweepLiveness();
    } catch (e: any) {
      console.log(`[${ts()}] SSE sweep failed: ${e?.message || e}`);
    }
  }, LIVENESS_SWEEP_MS);
  // Don't keep the event loop alive just for the sweep.
  (livenessSweepTimer as any)?.unref?.();
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/** 创建 SSE Response 并注册到 clients map */
export function createSSEStream(sessionName: string, networkId?: string | null): Response {
  const encoder = new TextEncoder();
  const key = clientKey(sessionName, networkId);
  let client: SSEClient;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = {
        controller,
        encoder,
        stuckSince: null,
        closed: false,
        key,
      };

      if (!clients.has(key)) clients.set(key, []);
      clients.get(key)!.push(client);
      console.log(`[${ts()}] SSE ← ${key} connected (${clients.get(key)!.length} clients)`);

      // Send initial connected frame through the backpressure guard so
      // even the first byte respects the contract.
      tryEnqueueBytes(
        client,
        encoder.encode(`data: ${JSON.stringify({ type: "connected", session: sessionName, network_id: networkId ?? null })}\n\n`),
      );

      // Periodic keepalive doubles as a half-open probe — if the
      // consumer is gone, this enqueue piles bytes in the queue until
      // tryEnqueueBytes catches the ceiling / stuck timeout.
      client.keepaliveTimer = setInterval(() => {
        if (client.closed) {
          if (client.keepaliveTimer) clearInterval(client.keepaliveTimer);
          return;
        }
        const result = tryEnqueueBytes(client, encoder.encode(`: keepalive\n\n`));
        if (result === "dead") {
          // closeClient already cleared the timer; just make sure we
          // also prune from the map.
          pruneClosed(key);
        }
      }, KEEPALIVE_MS);
      (client.keepaliveTimer as any)?.unref?.();

      ensureLivenessSweep();
    },
    cancel() {
      // Consumer side hangup — straightforward path, mark closed and
      // prune. The half-open path goes through closeClient instead.
      if (client) {
        closeClient(client, "cancel");
        pruneClosed(key);
      }
    },
  }, {
    // BYTE-COUNTING strategy. Without this, desiredSize is a chunk
    // counter and the byte-cap below is meaningless (see file header
    // comment #0). highWaterMark=0 means: after enqueuing N bytes, the
    // queue is N bytes over the mark, so `desiredSize === -N`. Pair
    // this with the hard ceiling in tryEnqueueBytes to actually close
    // a half-open consumer at MAX_QUEUE_BACKPRESSURE_BYTES.
    highWaterMark: 0,
    size: (chunk: Uint8Array) => chunk.byteLength,
  });

  return new Response(stream, {
    headers: {
      // #426: explicit charset so legacy Windows clients (PowerShell 5.1's
      // Invoke-RestMethod / Invoke-WebRequest default to ISO-8859-1 when
      // Content-Type omits the charset) decode UTF-8 payloads correctly.
      // Hub itself was already writing clean UTF-8 bytes; the client-side
      // 双重编码样式 mojibake was the header telling the client to guess.
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}

/** Remove closed entries for one key, drop the map slot if empty. */
function pruneClosed(key: string): void {
  const arr = clients.get(key);
  if (!arr) return;
  const alive = arr.filter((c) => !c.closed);
  if (alive.length === 0) {
    clients.delete(key);
    console.log(`[${ts()}] SSE ✕ ${key} disconnected (0 remaining)`);
  } else if (alive.length !== arr.length) {
    clients.set(key, alive);
  }
}

function rekeyClient(oldSessionName: string, newSessionName: string, networkId?: string | null): number {
  if (!oldSessionName || !newSessionName || oldSessionName === newSessionName) return 0;
  const oldKey = clientKey(oldSessionName, networkId);
  const newKey = clientKey(newSessionName, networkId);
  const oldClients = clients.get(oldKey);
  if (!oldClients || oldClients.length === 0) return 0;

  // Update the cached key on each moved client so later closeClient
  // logs report the right session.
  for (const c of oldClients) c.key = newKey;

  const existing = clients.get(newKey) || [];
  clients.set(newKey, existing.concat(oldClients));
  clients.delete(oldKey);
  console.log(`[${ts()}] SSE ↔ rekey ${oldKey} → ${newKey} (${oldClients.length} clients)`);
  return oldClients.length;
}

eventBus.on("rename-committed", (event: RenameCommittedEvent) => {
  try {
    rekeyClient(event.old_alias, event.new_alias, event.networkId);
  } catch (e: any) {
    console.log(`[${ts()}] SSE rekey failed: ${e?.message || e}`);
  }
});

/** 推送事件给指定 session 的所有 SSE 连接 */
export function pushEvent(sessionName: string, event: Record<string, unknown>, networkId?: string | null): void {
  const key = clientKey(sessionName, networkId ?? (event.network_id as string | null | undefined));
  const arr = clients.get(key);
  if (!arr || arr.length === 0) return;

  const data = `data: ${JSON.stringify(event)}\n\n`;
  let needPrune = false;

  for (const c of arr) {
    if (c.closed) {
      needPrune = true;
      continue;
    }
    const result = tryEnqueueBytes(c, c.encoder.encode(data));
    if (result === "dead") needPrune = true;
  }

  if (needPrune) pruneClosed(key);
}

export function __resetSSEClientsForTest(): void {
  for (const arr of clients.values()) {
    for (const c of arr) closeClient(c, "reset-for-test");
  }
  clients.clear();
  if (livenessSweepTimer) {
    clearInterval(livenessSweepTimer);
    livenessSweepTimer = null;
  }
}

/** 获取当前 SSE 连接统计 */
export function getSSEStats(): { total: number; sessions: Record<string, number> } {
  let total = 0;
  const sessions: Record<string, number> = {};
  for (const [name, arr] of clients) {
    const alive = arr.filter((c) => !c.closed);
    if (alive.length === 0) continue;
    sessions[name] = alive.length;
    total += alive.length;
  }
  return { total, sessions };
}

// Test hooks — exported so the test file can simulate half-open / stuck
// consumers without spinning up a real TCP socket.
export const __SSE_INTERNALS_FOR_TEST = {
  tryEnqueueBytes,
  sweepLiveness,
  closeClient,
  MAX_QUEUE_BACKPRESSURE_BYTES,
  STUCK_CLOSE_MS,
  KEEPALIVE_MS,
  LIVENESS_SWEEP_MS,
  clientsMap: clients,
};
