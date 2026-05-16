// Minimal stdio JSON-RPC client for `codex app-server`.
//
// Wire convention (verified via #120 R225-R230 POC against codex-cli 0.130.0):
//   - line-delimited JSON over stdin/stdout (NO LSP Content-Length framing)
//   - server may push notifications interleaved with request responses
//   - serde rename_all = "camelCase" on the Rust side → camelCase on the wire
//   - error envelope: `{ "id": N, "error": { "code": -32600, "message": "..." } }`
//   - pipelined requests respond out-of-order → must correlate by id
//
// This is intentionally tiny (~150 LOC with comments). It doesn't try to be a
// general JSON-RPC framework — just enough for #141 Phase 1.3 to map anet's
// task lifecycle onto codex's thread/turn JSON-RPC surface.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

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

export interface JsonRpcError {
  jsonrpc?: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc?: "2.0";
  method: string;
  params?: P;
}

export class CodexStdioClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rxBuffer = "";
  private closed = false;

  /**
   * Spawn `codex app-server` and start reading stdout. Throws synchronously
   * only on spawn config errors; binary-missing surfaces via `error` event +
   * pending-request rejection.
   */
  start(opts: { cwd?: string; env?: NodeJS.ProcessEnv; binary?: string } = {}): void {
    if (this.child) throw new Error("CodexStdioClient already started");
    const bin = opts.binary ?? "codex";
    this.child = spawn(bin, ["app-server"], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.emit("exit", { code, signal });
      // Reject any in-flight requests so callers don't hang forever.
      for (const [, p] of this.pending) p.reject(new Error(`codex app-server exited (code=${code} signal=${signal})`));
      this.pending.clear();
    });
    this.child.on("error", (err) => this.emit("error", err));
  }

  /** Send a JSON-RPC request and await its response (resolved or rejected). */
  async request<R = unknown, P = unknown>(method: string, params?: P, timeoutMs = 30_000): Promise<R> {
    if (!this.child || this.closed) throw new Error("CodexStdioClient not started or already exited");
    const id = this.nextId++;
    const payload: JsonRpcRequest<P> = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const line = JSON.stringify(payload) + "\n";
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex request '${method}' (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as R); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child!.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify<P = unknown>(method: string, params?: P): void {
    if (!this.child || this.closed) throw new Error("CodexStdioClient not started or already exited");
    const payload: JsonRpcNotification<P> = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  /** Gracefully close: call shutdown, wait briefly, then SIGTERM. */
  async close(graceMs = 1000): Promise<void> {
    if (!this.child || this.closed) return;
    try { await this.request<void>("shutdown", undefined, 2_000); } catch { /* fall through */ }
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const onExit = () => resolve();
      this.child!.once("exit", onExit);
      setTimeout(() => {
        try { this.child?.kill("SIGTERM"); } catch { /* noop */ }
        setTimeout(() => {
          try { this.child?.kill("SIGKILL"); } catch { /* noop */ }
          this.child?.removeListener("exit", onExit);
          resolve();
        }, 500);
      }, graceMs);
    });
  }

  private onStdout(chunk: string): void {
    this.rxBuffer += chunk;
    // Split on newlines; keep the last (possibly partial) fragment in the buffer.
    let nl: number;
    while ((nl = this.rxBuffer.indexOf("\n")) >= 0) {
      const line = this.rxBuffer.slice(0, nl).trim();
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcSuccess | JsonRpcError | JsonRpcNotification;
      try { msg = JSON.parse(line) as JsonRpcSuccess | JsonRpcError | JsonRpcNotification; }
      catch (e) { this.emit("parse_error", { line, error: e }); continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcSuccess | JsonRpcError | JsonRpcNotification): void {
    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        this.emit("orphan_response", msg);
        return;
      }
      this.pending.delete(msg.id);
      if ("error" in msg && msg.error) {
        const err = new Error(`codex JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
        (err as Error & { code?: number; data?: unknown }).code = msg.error.code;
        (err as Error & { code?: number; data?: unknown }).data = msg.error.data;
        pending.reject(err);
      } else if ("result" in msg) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(`codex JSON-RPC response (id=${msg.id}) missing both result and error`));
      }
      return;
    }
    // No id → it's a notification (server-initiated push).
    if ("method" in msg && msg.method) {
      // Emit on the method name itself for typed listeners (e.g. on("agentMessage/delta", ...))
      // and a generic "notification" event for broad observers.
      this.emit(msg.method, msg.params);
      this.emit("notification", msg);
    } else {
      this.emit("malformed", msg);
    }
  }
}
