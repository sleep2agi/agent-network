// RFC-030 Phase 0 — WebSocket JSON-RPC client for `codex app-server`.
//
// Independent runtime for the shared-thread bridge (human TUI + agent both
// connected to the same `codex app-server`). Not a codex-sdk transport wrapper;
// agent-node is the second app-server client alongside `codex --remote`.
//
// Why this exists (not a fork of codex-stdio-client.ts): `app-server` sends
// **reverse requests** — JSON-RPC calls FROM the server TO the client, most
// notably approval prompts. Those messages carry BOTH `method` AND `id`. The
// existing stdio client's `dispatch()` (codex-stdio-client.ts around line 145)
// tests `id !== undefined && id !== null` first, tries to look the id up in
// its own pending map, misses, and emits `orphan_response` — silently
// dropping the reverse request. That path is fine for stdio (which the RFC
// notes doesn't use reverse requests today) but wrong for app-server.
//
// Dispatch order in this client:
//   1. `method` string present + `id` present → reverse request from server.
//      Emit `reverse_request` with { id, method, params }. The bridge decides
//      whether/how to respond. Phase 0 bridge NEVER responds (approvals must
//      come from the human TUI); it just records `waiting_human`.
//   2. `method` string present + `id` absent → notification. Emit on the
//      method name + a generic `notification` event.
//   3. `id` present with `result` or `error` → response. Match against pending.
//   4. Anything else → `malformed`.
//
// WebSocket resolution: Bun and Node 22+ expose a global `WebSocket`, but the
// fleet runs agent-node under **Node 20**, which has NO global `WebSocket`
// (it's behind `--experimental-websocket`). The shipped node bundle therefore
// must fall back to undici's WebSocket — agent-node already depends on undici,
// and `undici.WebSocket` works under Node 20. Without this the whole
// codex-app-server runtime fails at connect time under the fleet's node
// (worked in dev only because Bun has the global). See RFC-030 §18.

import { EventEmitter } from "events";

/**
 * Resolve a usable WebSocket constructor: prefer the global (Bun / Node 22+),
 * fall back to undici's (Node 20, where the global is absent). Cached.
 */
let _wsCtor: any;
export function resolveWebSocketCtor(): any {
  if (_wsCtor) return _wsCtor;
  const g = (globalThis as any).WebSocket;
  if (typeof g === "function") return (_wsCtor = g);
  try {
    // undici is a direct dependency of agent-node.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const undici = require("undici");
    if (typeof undici?.WebSocket === "function") return (_wsCtor = undici.WebSocket);
  } catch {
    /* fall through to the throw below */
  }
  throw new Error(
    "no WebSocket implementation available — need a global WebSocket (Bun / Node 22+) or the undici package",
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Wire types (subset). Field names camelCase per Codex serde convention.
// ────────────────────────────────────────────────────────────────────────────

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc?: "2.0";
  id: number;
  result: R;
}

export interface JsonRpcErrorMsg {
  jsonrpc?: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc?: "2.0";
  method: string;
  params?: P;
}

/** Server-initiated request (a JSON-RPC "call" from server to client). */
export interface JsonRpcReverseRequest<P = unknown> {
  jsonrpc?: "2.0";
  id: number;
  method: string;
  params?: P;
}

type IncomingMsg =
  | JsonRpcSuccess
  | JsonRpcErrorMsg
  | JsonRpcNotification
  | JsonRpcReverseRequest;

/**
 * RFC-030 Wave 1B: shared upstream id allocator (see
 * codex-policy-gateway/upstream-mux.ts). In gateway mode the client and
 * A's TUI proxy share ONE socket — two independent nextId counters would
 * collide. When a mux is injected the client allocates every request id
 * through it (`origin: "internal"`), and responses whose ids belong to the
 * "tui" origin are emitted as `tui_response` instead of orphaning.
 */
export interface UpstreamIdMuxLike {
  allocate(origin: "internal" | "tui"): number;
  ownerOf(id: number): "internal" | "tui" | undefined;
  release(id: number): void;
}

export interface CodexAppServerClientOptions {
  /** Full URL: `ws://127.0.0.1:4500` or `wss://…`. Loopback only in Phase 0. */
  url: string;
  /** Optional bearer / capability token; sent as `Authorization: Bearer …`. */
  authToken?: string;
  /** Default per-request timeout (ms). */
  defaultTimeoutMs?: number;
  /** Debug label for logs / errors. */
  clientLabel?: string;
  /**
   * Shared upstream id mux (gateway mode). Standalone/Phase-0 usage may
   * omit it — the client falls back to its private counter, which is safe
   * only when it is the sole writer on the socket.
   */
  mux?: UpstreamIdMuxLike;
}

// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────

/**
 * Events emitted:
 *   - "open"                        → WS connection established
 *   - "close"                       → { code, reason }
 *   - "error"                       → Error (transport-level)
 *   - "parse_error"                 → { line, error }
 *   - "malformed"                   → raw message that didn't fit any shape
 *   - "orphan_response"             → response with no matching pending id
 *   - "notification"                → raw notification envelope
 *   - <method>                      → notification's params, keyed by method
 *   - "reverse_request"             → { id, method, params } — server called us
 *
 * The bridge listens for `reverse_request`, records `waiting_human` on
 * approval methods, and does NOT call `respondToReverseRequest` in Phase 0.
 * A helper is provided for later phases when we do want to answer
 * (`tool/*` for the local tool proxy, once that exists).
 */
export class CodexAppServerClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }
  >();
  private closed = false;
  private readonly opts: CodexAppServerClientOptions;
  private readonly defaultTimeoutMs: number;

  constructor(opts: CodexAppServerClientOptions) {
    super();
    this.opts = opts;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  /** True while the socket is open (constructed and not yet closed). */
  get isConnected(): boolean {
    return !!this.ws && !this.closed;
  }

  /** Open the WebSocket. Resolves on `open`; rejects on first `error`. */
  async connect(): Promise<void> {
    if (this.ws) throw new Error("CodexAppServerClient already connected");
    const headers: Record<string, string> = {};
    if (this.opts.authToken) headers.Authorization = `Bearer ${this.opts.authToken}`;
    // The global WebSocket ctor supports (url) or (url, protocols). Header
    // injection isn't standardized on the browser API; we rely on Node/Bun's
    // WebSocket, which accepts an options bag as the third argument. If the
    // runtime doesn't, callers should embed the token in the URL query.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WS: any = resolveWebSocketCtor();
    this.ws = new WS(this.opts.url, undefined, headers.Authorization ? { headers } : undefined);

    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.ws!.removeEventListener("error", onErrorInit);
        this.emit("open");
        resolve();
      };
      const onErrorInit = (ev: Event) => {
        // Extract a useful message from the DOM event when possible.
        const err = extractError(ev, `connect ${this.opts.url}`);
        this.ws!.removeEventListener("open", onOpen);
        reject(err);
      };
      this.ws!.addEventListener("open", onOpen, { once: true });
      this.ws!.addEventListener("error", onErrorInit, { once: true });

      // Steady-state handlers (installed regardless of connect outcome).
      this.ws!.addEventListener("message", (ev: MessageEvent) => {
        this.onMessage(String(ev.data));
      });
      this.ws!.addEventListener("close", (ev: CloseEvent) => {
        this.closed = true;
        this.emit("close", { code: ev.code, reason: ev.reason });
        for (const [, p] of this.pending) {
          p.reject(new Error(`codex app-server closed (code=${ev.code} reason=${ev.reason})`));
        }
        this.pending.clear();
      });
      this.ws!.addEventListener("error", (ev: Event) => {
        this.emit("error", extractError(ev, "ws steady-state"));
      });
    });
  }

  /** Send a JSON-RPC request and await response. */
  async request<R = unknown, P = unknown>(
    method: string,
    params?: P,
    timeoutMs?: number,
  ): Promise<R> {
    if (!this.ws || this.closed) {
      throw new Error("CodexAppServerClient not connected or already closed");
    }
    // Gateway mode: allocate through the shared mux so ids can never
    // collide with TUI-proxied requests on the same socket. Standalone
    // mode keeps the private counter.
    const id = this.opts.mux ? this.opts.mux.allocate("internal") : this.nextId++;
    const payload: JsonRpcRequest<P> = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const to = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.opts.mux?.release(id);
        reject(new Error(`codex request '${method}' (id=${id}) timed out after ${to}ms`));
      }, to);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as R);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify<P = unknown>(method: string, params?: P): void {
    if (!this.ws || this.closed) {
      throw new Error("CodexAppServerClient not connected or already closed");
    }
    const payload: JsonRpcNotification<P> = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Respond to a **reverse request** from the server. Phase 0 bridge MUST
   * NOT call this for approvals — the human TUI is the sole approver. It is
   * exposed here for later phases (tool proxy, etc.). Refusing to expose the
   * primitive would just push callers to reach into `ws.send` themselves.
   */
  respondToReverseRequest<R = unknown>(id: number, result: R): void {
    if (!this.ws || this.closed) {
      throw new Error("CodexAppServerClient not connected or already closed");
    }
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  /** Error-form response to a reverse request (also gated to bridge policy). */
  errorReverseRequest(id: number, code: number, message: string, data?: unknown): void {
    if (!this.ws || this.closed) {
      throw new Error("CodexAppServerClient not connected or already closed");
    }
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
      }),
    );
  }

  /** Graceful close. Any in-flight requests reject with a close error. */
  async close(code?: number, reason?: string): Promise<void> {
    if (!this.ws || this.closed) return;
    return new Promise<void>((resolve) => {
      this.ws!.addEventListener("close", () => resolve(), { once: true });
      try {
        this.ws!.close(code, reason);
      } catch {
        resolve();
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Wire handling
  // ──────────────────────────────────────────────────────────────────────

  private onMessage(raw: string): void {
    let msg: IncomingMsg;
    try {
      msg = JSON.parse(raw) as IncomingMsg;
    } catch (e) {
      this.emit("parse_error", { line: raw, error: e });
      return;
    }
    this.dispatch(msg);
  }

  /**
   * See the file header for the full ordering rationale. Summary:
   *   method + id → reverse request
   *   method     → notification
   *   id (+ result | error) → response
   */
  private dispatch(msg: IncomingMsg): void {
    const hasMethod = "method" in msg && typeof (msg as { method: unknown }).method === "string";
    const idField = "id" in msg ? (msg as { id: unknown }).id : undefined;
    const hasId = idField !== undefined && idField !== null;

    if (hasMethod && hasId) {
      // Reverse request from server.
      const rr = msg as JsonRpcReverseRequest;
      this.emit("reverse_request", { id: rr.id, method: rr.method, params: rr.params });
      // Also emit on the method name for method-specific listeners.
      this.emit(`reverse:${rr.method}`, { id: rr.id, params: rr.params });
      return;
    }

    if (hasMethod && !hasId) {
      // Notification.
      const n = msg as JsonRpcNotification;
      this.emit(n.method, n.params);
      this.emit("notification", n);
      return;
    }

    if (hasId) {
      // Response.
      const id = idField as number;
      const pending = this.pending.get(id);
      if (!pending) {
        // Gateway mode: a response whose id belongs to the TUI origin is
        // NOT an orphan — it's the answer to a TUI-proxied request. Route
        // it out for A's proxy layer to deliver; never resolve internal
        // pendings with it.
        if (this.opts.mux?.ownerOf(id) === "tui") {
          this.emit("tui_response", msg);
          return;
        }
        this.emit("orphan_response", msg);
        return;
      }
      this.pending.delete(id);
      this.opts.mux?.release(id);
      if ("error" in msg && (msg as JsonRpcErrorMsg).error) {
        const err = msg as JsonRpcErrorMsg;
        const e = new Error(
          `codex JSON-RPC error ${err.error.code}: ${err.error.message} (method=${pending.method})`,
        );
        (e as Error & { code?: number; data?: unknown }).code = err.error.code;
        (e as Error & { code?: number; data?: unknown }).data = err.error.data;
        pending.reject(e);
      } else if ("result" in msg) {
        pending.resolve((msg as JsonRpcSuccess).result);
      } else {
        pending.reject(
          new Error(
            `codex JSON-RPC response (id=${id}, method=${pending.method}) missing both result and error`,
          ),
        );
      }
      return;
    }

    this.emit("malformed", msg);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function extractError(ev: Event, context: string): Error {
  // Node/Bun WebSocket often surface the underlying error via `.error`
  // property on the event; browser API doesn't.
  const anyEv = ev as unknown as { error?: unknown; message?: unknown };
  if (anyEv.error instanceof Error) return anyEv.error;
  if (typeof anyEv.message === "string") return new Error(`${context}: ${anyEv.message}`);
  return new Error(`${context}: WebSocket error`);
}
