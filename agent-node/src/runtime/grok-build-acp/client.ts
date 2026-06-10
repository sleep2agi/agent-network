// Minimal JSON-RPC stdio client for `grok agent stdio` (ACP).
//
// Grok Build currently speaks newline-delimited JSON-RPC over stdio. Keep this
// transport small and runtime-agnostic; anet-specific task/reply mapping lives
// in the adapter layer, not here.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { readFileSync, writeFileSync } from "fs";
import { basename, relative, resolve } from "path";

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
  | JsonRpcRequest
  | JsonRpcSuccess
  | JsonRpcError
  | JsonRpcNotification;

export class GrokAcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rxBuffer = "";
  private closed = false;
  private cwd = process.cwd();
  // #211 — Activity heartbeat. Every successfully parsed JSON-RPC frame on
  // stdout (notification, response, or server-to-client request) bumps
  // this. `requestWithIdleTimeout()` reads it to decide whether the request
  // is genuinely silent or merely long-running while still streaming.
  private lastIncomingAt = Date.now();

  /**
   * Wall-clock timestamp (ms since epoch) of the last successfully parsed
   * JSON-RPC frame received from the agent on stdout. Updated by
   * `onStdout`. Exposed read-only for tests and consumers that want to
   * implement their own activity-based heartbeats around `request()`.
   */
  get lastActivityAt(): number {
    return this.lastIncomingAt;
  }

  start(opts: { cwd?: string; env?: NodeJS.ProcessEnv; binary?: string } = {}): void {
    if (this.child) throw new Error("GrokAcpClient already started");
    this.cwd = resolve(opts.cwd ?? process.cwd());
    const bin = opts.binary ?? "grok";
    this.child = spawn(bin, ["agent", "stdio"], {
      cwd: this.cwd,
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

  /**
   * Issue a JSON-RPC request and treat the supplied `idleTimeoutMs` as an
   * **idle threshold** rather than a hard deadline (#211).
   *
   * Any successfully parsed JSON-RPC frame received from the agent on
   * stdout — streamed `session/update` chunks, `tool_call` events,
   * server-to-client requests, intermediate notifications — resets the
   * timer. The request only times out when the agent goes genuinely
   * silent for longer than `idleTimeoutMs`.
   *
   * Use this for streaming requests (notably `session/prompt`) whose
   * total wall-clock duration is unbounded but whose silent periods
   * indicate a real stall. Quick handshake requests (`initialize`,
   * `authenticate`, `session/new`) should keep using `request()` with
   * a hard deadline.
   *
   * Backward compatibility: callers that previously passed a hard
   * deadline (e.g. the runtime's old `client.request("session/prompt",
   * ..., timeoutMs)` plumbing) can swap to this with the same numeric
   * value and get a strictly more forgiving behaviour — the timer only
   * fires when the agent is genuinely stalled.
   */
  async requestWithIdleTimeout<R = unknown, P = unknown>(
    method: string,
    params?: P,
    idleTimeoutMs = 300_000,
  ): Promise<R> {
    if (!this.child || this.closed) throw new Error("GrokAcpClient not started or already exited");
    const id = this.nextId++;
    const payload: JsonRpcRequest<P> = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const startedAt = Date.now();
    // Reset the heartbeat baseline so a long-quiet preamble before this
    // request does not count against us.
    this.lastIncomingAt = startedAt;

    return new Promise<R>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (action: () => void) => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.pending.delete(id);
        action();
      };

      const tick = () => {
        const sinceActivity = Date.now() - this.lastIncomingAt;
        if (sinceActivity >= idleTimeoutMs) {
          const totalMs = Date.now() - startedAt;
          settle(() =>
            reject(
              new Error(
                `grok ACP request '${method}' (id=${id}) idle for ${sinceActivity}ms ` +
                  `(threshold ${idleTimeoutMs}ms, total elapsed ${totalMs}ms). ` +
                  `The task may still be running in the background — check the Grok session ` +
                  `directory under ~/.grok/sessions/ for partial outputs. ` +
                  `If your task is genuinely long-running (e.g. batch video generation), ` +
                  `raise flags.grokAcpTimeoutMs in your node config (it now controls ` +
                  `the idle threshold, not a hard deadline).`,
              ),
            ),
          );
          return;
        }
        // Reschedule for the remaining idle budget. Reading
        // `lastIncomingAt` again at the next tick is what gives this its
        // activity-resetting behaviour.
        timer = setTimeout(tick, idleTimeoutMs - sinceActivity);
      };

      this.pending.set(id, {
        resolve: (v) => settle(() => resolve(v as R)),
        reject: (e) => settle(() => reject(e)),
      });

      this.child!.stdin.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) settle(() => reject(err));
      });

      timer = setTimeout(tick, idleTimeoutMs);
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
      // #211 — Treat any successfully parsed JSON-RPC frame as a sign of
      // life. This is what `requestWithIdleTimeout` consumes to reset its
      // timer. Streamed `session/update` chunks (the common case during
      // long batch jobs), server-to-client requests, and final responses
      // all count — the only thing that doesn't count is genuine silence.
      this.lastIncomingAt = Date.now();
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("method" in msg && msg.method && "id" in msg && msg.id !== undefined && msg.id !== null) {
      void this.handleServerRequest(msg as JsonRpcRequest).catch((error) => {
        this.emit("server_request_error", { request: msg, error });
      });
      return;
    }

    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) {
        this.emit("orphan_response", msg);
        return;
      }
      this.pending.delete(id);
      if ("error" in msg && msg.error) {
        const err = new Error(formatJsonRpcError(msg.error));
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

  private async handleServerRequest(req: JsonRpcRequest): Promise<void> {
    try {
      const result = this.resolveServerRequest(req.method, req.params);
      this.respond(req.id, result);
    } catch (error: any) {
      // JSON-RPC error.code MUST be an i32. Node's fs errors carry string
      // codes like "ENOENT" / "EACCES"; passing those through verbatim
      // makes Grok's serde parser reject the whole response with
      // `invalid type: string "ENOENT", expected i32 at line 1 column 48`,
      // which silently desynchronises the request/response pairing and
      // hangs the next `session/prompt` until its 300s timeout (see
      // ai-insight A站Grok 2026-06-07 19:50–19:55 incident).
      const rawCode = error?.code;
      const numCode = typeof rawCode === "number" && Number.isInteger(rawCode) ? rawCode : -32000;
      this.respond(req.id, undefined, {
        code: numCode,
        message: error?.message ?? String(error),
        ...(rawCode !== undefined && rawCode !== numCode
          ? { data: { originalCode: rawCode } }
          : {}),
      });
    }
  }

  private resolveServerRequest(method: string, params: unknown): unknown {
    const p = asRecord(params) ?? {};
    if (method === "fs/read_text_file" || method === "fs/readTextFile") {
      const path = typeof p.path === "string" ? p.path : "";
      if (!path) throw new Error("fs/read_text_file missing path");
      return { content: readFileSync(this.safePath(path), "utf8") };
    }
    if (method === "fs/write_text_file" || method === "fs/writeTextFile") {
      const path = typeof p.path === "string" ? p.path : "";
      if (!path) throw new Error("fs/write_text_file missing path");
      const content = typeof p.content === "string" ? p.content : (typeof p.text === "string" ? p.text : "");
      writeFileSync(this.safePath(path), content);
      return {};
    }
    if (method === "session/request_permission") {
      const options = Array.isArray(p.options) ? p.options.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
      const allowOnce =
        options.find((option) => option.optionId === "allow-once")
        ?? options.find((option) => option.kind === "allow_once")
        ?? options.find((option) => typeof option.optionId === "string" && String(option.optionId).includes("allow"));
      if (!allowOnce) throw new Error("session/request_permission has no allow-once option");
      return { outcome: { outcome: "selected", optionId: allowOnce.optionId ?? "allow-once" } };
    }
    const err = new Error(`unsupported client method: ${method}`) as Error & { code?: number };
    err.code = -32601;
    throw err;
  }

  private respond(id: number | string, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    if (!this.child || this.closed) return;
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result: result ?? {} };
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  private safePath(inputPath: string): string {
    const abs = resolve(this.cwd, inputPath);
    const rel = relative(this.cwd, abs);
    if (rel === "" || rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`)) {
      throw new Error(`path outside Grok runtime cwd: ${inputPath}`);
    }
    if (!basename(abs)) throw new Error(`invalid path: ${inputPath}`);
    return abs;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function formatJsonRpcError(error: JsonRpcError["error"]): string {
  const base = `grok ACP error ${error.code}: ${error.message}`;
  if (error.data === undefined) return base;
  let data: string;
  try { data = JSON.stringify(error.data); }
  catch { data = String(error.data); }
  if (data.length > 1000) data = `${data.slice(0, 1000)}...`;
  return `${base} data=${data}`;
}
