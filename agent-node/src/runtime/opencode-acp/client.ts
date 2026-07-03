// RFC-029 PR② — opencode ACP stdio JSON-RPC client.
//
// Transport layer for `spawn('opencode', ['acp'])`. Mirrors the
// grok-build-acp/client.ts skeleton because Phase 0b (U8) confirmed
// the wire framing is identical JSON-RPC 2.0 over newline-delimited
// stdio. Kept in-tree (not a shared abstraction with Grok) so
// upstream churn on either side can be absorbed without cross-
// runtime blast radius.
//
// What lives here:
//   - subprocess spawn + stdio pump
//   - newline-delimited JSON-RPC framing (in + out)
//   - id-correlated request/response with per-request timeout
//   - streaming notifications surface via `on("notification", ...)`
//   - HOME env isolation is the caller's job (env passed through
//     verbatim — runtime.ts sets `HOME=<node workdir>` per §8 D5)
//
// What lives in runtime.ts:
//   - session/new vs session/load restart policy (crash-preservation
//     per 通信龙 review-point on PR② flag)
//   - state machine driving initialize → session/{new,load} →
//     session/prompt in the long-running process
//   - sessionId persistence (writebackSession) for restart

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
  | JsonRpcRequest
  | JsonRpcSuccess
  | JsonRpcError
  | JsonRpcNotification;

export interface OpencodeAcpClientOptions {
  /** cwd for the spawned opencode process. Not the anet cwd — per §8
   *  D5 this should be the per-node work dir so opencode's own
   *  `--cwd` file resolution stays scoped. */
  cwd?: string;
  /** Full env for the child. Callers MUST set `HOME=<node workdir>`
   *  here to isolate opencode's auth.json + opencode.json + session
   *  cache per anet node (§8 D5). */
  env?: NodeJS.ProcessEnv;
  /** Binary name / path. Defaults to `"opencode"` (found via $PATH). */
  binary?: string;
}

export class OpencodeAcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rxBuffer = "";
  private closed = false;
  private lastIncomingAt = Date.now();

  /** Timestamp (ms since epoch) of the last JSON-RPC frame received
   *  from the agent. Runtime.ts uses this to distinguish a wedged
   *  agent from a long-running streaming turn. */
  get lastActivityAt(): number {
    return this.lastIncomingAt;
  }

  start(opts: OpencodeAcpClientOptions = {}): void {
    if (this.child) throw new Error("OpencodeAcpClient already started");
    const bin = opts.binary ?? "opencode";
    // NOTE: `opencode acp` v1.17.13 IGNORES --port/--hostname (see
    // Phase 0b U8 finding — flags are accepted for CLI parsing but
    // the server binds to stdio only). Do not pass them here.
    this.child = spawn(bin, ["acp"], {
      cwd: opts.cwd ?? process.cwd(),
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
      const errMsg = `opencode acp exited (code=${code} signal=${signal})`;
      for (const [, p] of this.pending) p.reject(new Error(errMsg));
      this.pending.clear();
    });
    this.child.on("error", (err) => this.emit("error", err));
  }

  async request<R = unknown, P = unknown>(method: string, params?: P, timeoutMs = 30_000): Promise<R> {
    if (!this.child || this.closed) throw new Error("OpencodeAcpClient not started or already exited");
    const id = this.nextId++;
    const payload: JsonRpcRequest<P> = {
      jsonrpc: "2.0", id, method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`opencode ACP request '${method}' (id=${id}) timed out after ${timeoutMs}ms`));
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
   * Idle-threshold variant of `request()` for `session/prompt`, which
   * streams `session/update` chunks for the entire LLM turn. Mirrors
   * grok-build-acp/client.ts:requestWithIdleTimeout — any incoming
   * frame resets the timer so a genuinely long-running turn isn't
   * killed while frames are actively flowing.
   */
  async requestWithIdleTimeout<R = unknown, P = unknown>(
    method: string,
    params: P,
    idleTimeoutMs: number,
  ): Promise<R> {
    if (!this.child || this.closed) throw new Error("OpencodeAcpClient not started or already exited");
    const id = this.nextId++;
    const payload: JsonRpcRequest<P> = { jsonrpc: "2.0", id, method, params };
    const sentAt = Date.now();
    return new Promise<R>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const check = () => {
        const idleFor = Date.now() - Math.max(sentAt, this.lastIncomingAt);
        if (idleFor >= idleTimeoutMs) {
          this.pending.delete(id);
          reject(new Error(
            `opencode ACP request '${method}' (id=${id}) idle for ${idleFor}ms ` +
            `(threshold ${idleTimeoutMs}ms); background work may still be running.`,
          ));
        } else {
          timer = setTimeout(check, Math.max(500, idleTimeoutMs - idleFor));
        }
      };
      timer = setTimeout(check, idleTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v as R); },
        reject:  (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      this.child!.stdin.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Terminate the child and refuse further requests. Idempotent. */
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.child || this.closed) return;
    try { this.child.kill(signal); } catch { /* already gone */ }
    // Await the exit handler which sets `closed = true` and clears pending.
    if (!this.closed) await new Promise<void>((r) => this.once("exit", () => r()));
  }

  /**
   * Whether the child process is alive AND still accepting requests.
   * Used by runtime.ts's crash-restart detector.
   */
  get isRunning(): boolean {
    return this.child !== null && !this.closed;
  }

  private onStdout(chunk: string): void {
    this.rxBuffer += chunk;
    while (this.rxBuffer.includes("\n")) {
      const idx = this.rxBuffer.indexOf("\n");
      const line = this.rxBuffer.slice(0, idx).trim();
      this.rxBuffer = this.rxBuffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(line) as JsonRpcMessage; }
      catch { this.emit("parseError", line); continue; }
      this.lastIncomingAt = Date.now();
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    // Response frame (has `id` AND either `result` or `error`, no `method`).
    if ("id" in msg && !("method" in msg && (msg as any).method)) {
      const id = Number((msg as any).id);
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if ("error" in msg && (msg as JsonRpcError).error) {
          const e = (msg as JsonRpcError).error;
          p.reject(new Error(`opencode ACP error id=${id}: ${e.code} ${e.message}`));
        } else {
          // Emit the WHOLE response so callers that need `stopReason`
          // from the `result` field can also see it via listeners
          // (in addition to the resolved promise result).
          this.emit("response", msg);
          p.resolve((msg as JsonRpcSuccess).result);
        }
      } else {
        this.emit("orphanResponse", msg);
      }
      return;
    }
    // Notification frame (has `method`, no correlating `id`).
    if ("method" in msg && (msg as any).method) {
      this.emit("notification", msg as JsonRpcNotification);
    }
  }
}
