// Minimal JSON-RPC stdio client for `grok agent stdio` (ACP).
//
// Grok Build currently speaks newline-delimited JSON-RPC over stdio. Keep this
// transport small and runtime-agnostic; anet-specific task/reply mapping lives
// in the adapter layer, not here.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc?: "2.0";
  id: number | string;
  result: R;
}

export interface JsonRpcError {
  jsonrpc?: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc?: "2.0";
  method: string;
  params?: P;
}

export type JsonRpcMessage =
  | JsonRpcSuccess
  | JsonRpcError
  | JsonRpcNotification;

export class GrokAcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rxBuffer = "";
  private closed = false;

  start(opts: { cwd?: string; env?: NodeJS.ProcessEnv; binary?: string } = {}): void {
    if (this.child) throw new Error("GrokAcpClient already started");
    const bin = opts.binary ?? "grok";
    this.child = spawn(bin, ["agent", "stdio"], {
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
      for (const [, p] of this.pending) p.reject(new Error(`grok agent stdio exited (code=${code} signal=${signal})`));
      this.pending.clear();
    });
    this.child.on("error", (err) => this.emit("error", err));
  }

  async request<R = unknown, P = unknown>(method: string, params?: P, timeoutMs = 30_000): Promise<R> {
    if (!this.child || this.closed) throw new Error("GrokAcpClient not started or already exited");
    const id = this.nextId++;
    const payload: JsonRpcRequest<P> = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`grok ACP request '${method}' (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as R); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child!.stdin.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  notify<P = unknown>(method: string, params?: P): void {
    if (!this.child || this.closed) throw new Error("GrokAcpClient not started or already exited");
    const payload: JsonRpcNotification<P> = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  async close(graceMs = 1000): Promise<void> {
    if (!this.child || this.closed) return;
    try { this.child.stdin.end(); } catch { /* noop */ }
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
    let nl: number;
    while ((nl = this.rxBuffer.indexOf("\n")) >= 0) {
      const line = this.rxBuffer.slice(0, nl).trim();
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(line) as JsonRpcMessage; }
      catch (e) { this.emit("parse_error", { line, error: e }); continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) {
        this.emit("orphan_response", msg);
        return;
      }
      this.pending.delete(id);
      if ("error" in msg && msg.error) {
        const err = new Error(`grok ACP error ${msg.error.code}: ${msg.error.message}`);
        (err as Error & { code?: number; data?: unknown }).code = msg.error.code;
        (err as Error & { code?: number; data?: unknown }).data = msg.error.data;
        pending.reject(err);
      } else if ("result" in msg) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(`grok ACP response (id=${String(msg.id)}) missing both result and error`));
      }
      return;
    }

    if ("method" in msg && msg.method) {
      this.emit(msg.method, msg.params);
      this.emit("notification", msg);
    } else {
      this.emit("malformed", msg);
    }
  }
}
