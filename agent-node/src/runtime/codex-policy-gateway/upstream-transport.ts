// RFC-030 Stage 2 — the single raw Codex app-server WebSocket transport.
//
// This class deliberately does not allocate JSON-RPC ids or interpret
// responses.  Final A's UpstreamRequestMux remains the sole request owner.
// Every public async boundary is an `async` function in this realm so the
// value handed to final A is an ordinary base native Promise.

import WebSocket, { type RawData } from "ws";
import type {
  JsonRpcNotificationFrame,
  JsonRpcRequestFrame,
  JsonRpcResponseFrame,
} from "./protocol";
import type { UpstreamTransport } from "./uds-server";

type AnyFrame = JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame;

type TransportState = "idle" | "connecting" | "open" | "closing" | "closed" | "aborted";

type TransportErrorCode =
  | "codex_upstream_already_started"
  | "codex_upstream_connect_failed"
  | "codex_upstream_connect_timeout"
  | "codex_upstream_not_open"
  | "codex_upstream_serialize_failed"
  | "codex_upstream_write_failed"
  | "codex_upstream_close_failed"
  | "codex_upstream_abort_failed";

type DiagnosticCode =
  | "upstream_socket_error"
  | "upstream_malformed_frame"
  | "upstream_frame_handler_failed"
  | "upstream_notification_handler_failed"
  | "upstream_close_handler_failed";

/** Hard cap before JSON parsing; hostile upstream frames fail the socket. */
export const UPSTREAM_WS_MAX_PAYLOAD = 1_048_576;

class CodexUpstreamTransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode) {
    super(code);
    this.name = "CodexUpstreamTransportError";
    this.code = code;
  }
}

export interface CodexUpstreamTransportOptions {
  readonly url: string;
  /** WS open timeout. Lifecycle owns the separate close/abort bounds. */
  readonly connectTimeoutMs?: number;
  /** Stable diagnostics only: no frame, URL, Error, message, or close reason. */
  readonly log?: (msg: string) => void;
  /** Force-terminates the owned app-server process group when lifecycle aborts. */
  readonly abortUpstream?: () => Promise<void>;
}

function rawDataUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/**
 * R2 wire boundary. Final A intentionally routes a valid JSON-RPC response
 * to either its internal caller or the attached TUI, so the one real
 * transport must remove upstream-controlled error text/data before either
 * route can observe it. Malformed frames remain malformed and are rejected
 * by A's classifier; only an otherwise-valid error response is rewritten.
 */
function redactErrorResponse(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const frame = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(frame, "error")) return raw;
  if (
    frame.jsonrpc !== "2.0" ||
    (typeof frame.id !== "number" && typeof frame.id !== "string") ||
    Object.prototype.hasOwnProperty.call(frame, "method") ||
    Object.prototype.hasOwnProperty.call(frame, "result")
  ) return { malformed: true };
  const upstreamError = frame.error;
  if (
    typeof upstreamError !== "object" ||
    upstreamError === null ||
    Array.isArray(upstreamError) ||
    typeof (upstreamError as Record<string, unknown>).code !== "number" ||
    typeof (upstreamError as Record<string, unknown>).message !== "string"
  ) {
    return { malformed: true };
  }
  return {
    jsonrpc: "2.0",
    id: frame.id,
    error: {
      code: (upstreamError as Record<string, unknown>).code,
      message: "upstream request failed",
    },
  };
}

export class CodexUpstreamTransport implements UpstreamTransport {
  private ws: WebSocket | null = null;
  private readonly frameHandlers = new Set<(raw: unknown) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly notificationHandlers = new Set<
    (method: string, params: unknown) => void
  >();
  private state: TransportState = "idle";
  private closeFired = false;
  private diagnosticSequence = 0;
  private readonly log: (msg: string) => void;
  private readonly closeObserved: Promise<void>;
  private resolveCloseObserved!: () => void;
  private abortOperation: Promise<void> | null = null;

  constructor(private readonly opts: CodexUpstreamTransportOptions) {
    this.log = opts.log ?? (() => {});
    this.closeObserved = new Promise<void>((resolve) => {
      this.resolveCloseObserved = resolve;
    });
  }

  /**
   * Open the one production upstream socket. The returned value is a
   * same-realm base native Promise because this is a native async boundary.
   */
  async connect(): Promise<void> {
    if (this.state !== "idle") {
      throw new CodexUpstreamTransportError("codex_upstream_already_started");
    }

    this.state = "connecting";
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url, { maxPayload: UPSTREAM_WS_MAX_PAYLOAD });
    } catch {
      this.state = "closed";
      this.fireClose();
      throw new CodexUpstreamTransportError("codex_upstream_connect_failed");
    }
    this.ws = ws;

    // Install permanent listeners before awaiting open so an immediate close,
    // malformed frame, or socket error is never unobserved.
    ws.on("error", () => this.report("upstream_socket_error"));
    ws.on("message", (data) => this.dispatchMessage(data));
    ws.once("close", () => this.fireClose());

    const timeoutMs = this.opts.connectTimeoutMs ?? 10_000;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: CodexUpstreamTransportError): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.off("open", onOpen);
          ws.off("error", onConnectError);
          ws.off("close", onConnectClose);
          if (error) reject(error);
          else resolve();
        };
        const onOpen = (): void => {
          if (!this.closeFired) this.state = "open";
          finish();
        };
        const onConnectError = (): void => {
          finish(new CodexUpstreamTransportError("codex_upstream_connect_failed"));
        };
        const onConnectClose = (): void => {
          finish(new CodexUpstreamTransportError("codex_upstream_connect_failed"));
        };
        const timer = setTimeout(() => {
          finish(new CodexUpstreamTransportError("codex_upstream_connect_timeout"));
        }, timeoutMs);
        timer.unref?.();
        ws.once("open", onOpen);
        ws.once("error", onConnectError);
        ws.once("close", onConnectClose);
      });
    } catch (error) {
      if (ws.readyState !== WebSocket.CLOSED) {
        try {
          ws.terminate();
        } catch {
          // The stable connect failure remains primary. A permanent error
          // listener is already installed, so there is no detached failure.
        }
      }
      throw error;
    }
  }

  /**
   * Side-effect-free readiness probe used by production preflight. It sends
   * no frame, ping, or duplicate `initialized` notification.
   */
  async probe(): Promise<void> {
    if (this.state !== "open" || this.ws?.readyState !== WebSocket.OPEN) {
      throw new CodexUpstreamTransportError("codex_upstream_not_open");
    }
  }

  private dispatchMessage(data: RawData): void {
    let raw: unknown;
    try {
      raw = redactErrorResponse(JSON.parse(rawDataUtf8(data)));
    } catch {
      // Never retain or render the hostile payload. The protocol layer gets
      // only a fixed marker and fails the frame closed.
      raw = { malformed: true };
      this.report("upstream_malformed_frame");
    }

    // Response routing runs before B's notification observers.
    for (const handler of [...this.frameHandlers]) {
      try {
        handler(raw);
      } catch {
        this.report("upstream_frame_handler_failed");
      }
    }

    const notification = raw as { method?: unknown; id?: unknown; params?: unknown };
    if (typeof notification?.method !== "string" || notification.id !== undefined) return;
    for (const handler of [...this.notificationHandlers]) {
      try {
        handler(notification.method, notification.params);
      } catch {
        this.report("upstream_notification_handler_failed");
      }
    }
  }

  private report(code: DiagnosticCode): void {
    const correlation = `upstream-${++this.diagnosticSequence}`;
    try {
      this.log(`code=${code} correlation=${correlation}`);
    } catch {
      // Diagnostics are observational and must never affect transport state.
    }
  }

  private fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    if (this.state !== "aborted") this.state = "closed";
    this.resolveCloseObserved();
    for (const handler of [...this.closeHandlers]) {
      try {
        handler();
      } catch {
        this.report("upstream_close_handler_failed");
      }
    }
    this.closeHandlers.clear();
  }

  /** Resolve only after ws confirms that the frame was accepted for send. */
  async writeFrame(frame: AnyFrame): Promise<void> {
    const ws = this.ws;
    if (this.state !== "open" || ws?.readyState !== WebSocket.OPEN) {
      throw new CodexUpstreamTransportError("codex_upstream_not_open");
    }

    let payload: string;
    try {
      payload = JSON.stringify(frame);
    } catch {
      throw new CodexUpstreamTransportError("codex_upstream_serialize_failed");
    }

    await new Promise<void>((resolve, reject) => {
      try {
        ws.send(payload, (error) => {
          if (error) {
            reject(new CodexUpstreamTransportError("codex_upstream_write_failed"));
          } else {
            resolve();
          }
        });
      } catch {
        reject(new CodexUpstreamTransportError("codex_upstream_write_failed"));
      }
    });
  }

  onFrame(handler: (raw: unknown) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    if (!this.closeFired) {
      this.closeHandlers.add(handler);
      return () => this.closeHandlers.delete(handler);
    }

    // A subscriber installed after a fast remote close must still observe
    // closed. Queueing preserves subscription/unsubscription semantics.
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        handler();
      } catch {
        this.report("upstream_close_handler_failed");
      }
    });
    return () => {
      active = false;
    };
  }

  /** B-side extra: subscribe to id-less upstream notifications. */
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Graceful close: completion means the real ws close event was observed. */
  async close(): Promise<void> {
    const ws = this.ws;
    if (this.closeFired) return;
    if (ws === null) {
      this.fireClose();
      return;
    }

    this.state = "closing";
    try {
      if (ws.readyState === WebSocket.CLOSED) {
        this.fireClose();
      } else {
        ws.close();
      }
    } catch {
      throw new CodexUpstreamTransportError("codex_upstream_close_failed");
    }
    await this.closeObserved;
  }

  /**
   * Required function-property force abort. Socket termination and the owned
   * provider abort are both awaited; no rejection is detached.
   */
  readonly abort = async (): Promise<void> => {
    if (this.abortOperation === null) this.abortOperation = this.performAbort();
    await this.abortOperation;
  };

  private async performAbort(): Promise<void> {
    this.state = "aborted";
    const ws = this.ws;

    let socketFailure: unknown = null;
    if (!this.closeFired && ws !== null) {
      try {
        if (ws.readyState === WebSocket.CLOSED) this.fireClose();
        else ws.terminate();
      } catch (error) {
        socketFailure = error;
      }
    } else if (ws === null) {
      this.fireClose();
    }

    let upstreamFailure: unknown = null;
    const upstreamAbort = this.opts.abortUpstream;
    const upstreamPromise = (async (): Promise<void> => {
      if (upstreamAbort === undefined) return;
      await upstreamAbort();
    })();

    const socketPromise = (async (): Promise<void> => {
      if (socketFailure !== null) throw socketFailure;
      await this.closeObserved;
    })();

    const [socketResult, upstreamResult] = await Promise.allSettled([
      socketPromise,
      upstreamPromise,
    ]);
    if (upstreamResult.status === "rejected") upstreamFailure = upstreamResult.reason;
    if (upstreamFailure !== null) throw upstreamFailure;
    if (socketResult.status === "rejected") {
      throw new CodexUpstreamTransportError("codex_upstream_abort_failed");
    }
  }
}
