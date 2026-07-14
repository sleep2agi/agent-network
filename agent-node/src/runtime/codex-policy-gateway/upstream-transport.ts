// RFC-030 Wave 1B L3-R6 — Codex upstream transport (B side of A's
// `UpstreamTransport` contract, uds-server.ts @ 00d4ea8).
//
// A RAW frame pipe to the codex app-server WS — deliberately NOT the
// full CodexAppServerClient: in gateway mode the ONE
// UpstreamRequestMux inside A's GatewayLifecycle owns every request id
// on this socket (sendInternal / sendProxiedTui). This transport does
// zero id allocation, zero routing — it writes frames verbatim and
// multicasts inbound frames/close to subscribers.
//
// Extra surface for B's own consumers (does not violate the single-mux
// principle — notifications carry NO id):
//   onNotification(fn) — filtered multicast of id-less method frames
//   (turn/started, item/agentMessage/delta, turn/completed, …). A's
//   GatewayServer drops upstream notifications in Phase 1 ("Wave-2
//   fan-out"), but B's BridgeAdapter needs them to track turns; reading
//   them off the transport keeps A's files untouched.
//
// Close contract (A Segment C header): lifecycle drainAll's the mux on
// upstream close; the resolvers of in-flight sendInternal Promises are
// dropped un-rejected by drainAll (flagged to A as a Wave-2 cleanup).
// B contains this: every adapter-level request through the gateway goes
// via a TIMEOUT-wrapPED shim (see gateway-assembly.ts), so no B-side
// await ever hangs on a dropped resolver; the inner promise becomes
// unreachable and is GC'd.

import { resolveWebSocketCtor } from "../codex-app-server-client";
import type {
  JsonRpcNotificationFrame,
  JsonRpcRequestFrame,
  JsonRpcResponseFrame,
} from "./protocol";
import type { UpstreamTransport } from "./uds-server";

type AnyFrame = JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame;

export interface CodexUpstreamTransportOptions {
  url: string;
  /** WS open timeout. */
  connectTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class CodexUpstreamTransport implements UpstreamTransport {
  private ws: {
    send(s: string): void;
    close(): void;
    addEventListener(ev: string, fn: (e: never) => void): void;
  } | null = null;
  private frameHandlers: Array<(raw: unknown) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private closed = false;
  private closeFired = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: CodexUpstreamTransportOptions) {
    this.log = opts.log ?? (() => {});
  }

  async connect(): Promise<void> {
    const WS: new (url: string) => typeof this.ws & object = resolveWebSocketCtor();
    const ws = new WS(this.opts.url) as NonNullable<typeof this.ws>;
    const timeoutMs = this.opts.connectTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`upstream transport connect timeout (${timeoutMs}ms)`)),
        timeoutMs,
      );
      ws.addEventListener("open", (() => {
        clearTimeout(timer);
        resolve();
      }) as never);
      ws.addEventListener("error", ((e: { message?: string }) => {
        clearTimeout(timer);
        reject(new Error(`upstream transport connect error: ${e?.message ?? "unknown"}`));
      }) as never);
    });
    ws.addEventListener("message", ((ev: { data: unknown }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        raw = { malformed: String(ev.data).slice(0, 200) };
      }
      // Multicast to A's GatewayServer (and any other subscriber) FIRST —
      // response routing must not lag behind B's notification listeners.
      for (const h of [...this.frameHandlers]) h(raw);
      // B-side notification fan-out: id-less method frames only.
      const m = raw as { method?: unknown; id?: unknown; params?: unknown };
      if (typeof m?.method === "string" && m.id === undefined) {
        for (const h of [...this.notificationHandlers]) h(m.method, m.params);
      }
    }) as never);
    ws.addEventListener("close", (() => this.fireClose()) as never);
    this.ws = ws;
  }

  private fireClose(): void {
    if (this.closeFired) return; // exactly once
    this.closeFired = true;
    for (const h of [...this.closeHandlers]) {
      try {
        h();
      } catch (e) {
        this.log(`[transport] close handler threw: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }

  async writeFrame(frame: AnyFrame): Promise<void> {
    if (!this.ws || this.closed || this.closeFired) {
      throw new Error("upstream transport not connected");
    }
    this.ws.send(JSON.stringify(frame));
  }

  onFrame(handler: (raw: unknown) => void): () => void {
    this.frameHandlers.push(handler);
    return () => {
      this.frameHandlers = this.frameHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }

  /** B-side extra: subscribe to id-less upstream notifications. */
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already down */
    }
    this.fireClose();
  }

  // A frozen contract v9 requires `abort(): Promise<void>`. Synchronous
  // teardown alongside `close()`; the real WS underneath has no distinct
  // abort primitive, so we forcibly close and fire the close event.
  async abort(): Promise<void> {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already down */
    }
    this.fireClose();
  }
}
