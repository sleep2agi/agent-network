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
//   - child environment isolation is the caller's job (`env` is the
//     complete environment and is passed through verbatim)
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

export type JsonRpcServerRequest<P = unknown> = JsonRpcRequest<P>;

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
  /** Complete env for the child. It is NOT merged with process.env. */
  env?: NodeJS.ProcessEnv;
  /** Binary name / path. Defaults to `"opencode"` (found via $PATH). */
  binary?: string;
}

export interface OpencodeAcpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Present only for the ChildProcess `error` finalizer. A native `exit`
   *  event leaves this undefined and proves the captured process instance is
   *  no longer able to write its launch-scoped state. */
  cause?: Error;
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

  /** Native child PID captured by spawn. Kept readable after `exit` so the
   *  cleanup boundary can distinguish the exited direct process from live
   *  descendants that inherited its launch environment. */
  get processId(): number | undefined {
    return this.child?.pid;
  }

  start(opts: OpencodeAcpClientOptions = {}): void {
    if (this.child) throw new Error("OpencodeAcpClient already started");
    const bin = opts.binary ?? "opencode";
    // NOTE: `opencode acp` v1.17.13 IGNORES --port/--hostname (see
    // Phase 0b U8 finding — flags are accepted for CLI parsing but
    // the server binds to stdio only). Do not pass them here.
    this.child = spawn(bin, ["acp"], {
      cwd: opts.cwd ?? process.cwd(),
      // `spawn()` inherits process.env when `env` is undefined. Use an empty
      // object as the lower-level default so a caller can never accidentally
      // leak agent-node's CommHub/channel/MCP credentials. runtime.ts always
      // supplies the exact allowlisted environment built in child-env.ts.
      env: opts.env ?? {},
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    this.child.on("exit", (code, signal) => {
      this.finalizeExit(code, signal);
    });
    this.child.on("error", (err) => {
      // A spawn failure may emit `error` without `exit`. Finalize first so
      // stop() and any handshake request cannot hang forever. EventEmitter's
      // special `error` event throws when unobserved, so surface it only when
      // the caller explicitly subscribed (runtime.ts does).
      this.finalizeExit(null, null, err);
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
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
    await new Promise<void>((resolve, reject) => {
      const onExit = () => resolve();
      // Subscribe before kill(): a very short-lived child can otherwise exit
      // between kill() and once(), leaving shutdown waiting forever.
      this.once("exit", onExit);
      if (this.closed) {
        this.off("exit", onExit);
        resolve();
        return;
      }
      try {
        this.child!.kill(signal);
      } catch (error) {
        this.off("exit", onExit);
        if (this.closed) resolve();
        else reject(error);
      }
    });
  }

  /**
   * Whether the child process is alive AND still accepting requests.
   * Used by runtime.ts's crash-restart detector.
   */
  get isRunning(): boolean {
    return this.child !== null && !this.closed;
  }

  private finalizeExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    cause?: Error,
  ): void {
    if (this.closed) return;
    this.closed = true;
    const err = cause ?? new Error(`opencode acp exited (code=${code} signal=${signal})`);
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
    const info: OpencodeAcpExitInfo = { code, signal, ...(cause ? { cause } : {}) };
    this.emit("exit", info);
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
    // Reverse request from the agent to this unattended client. We advertise
    // no filesystem/terminal capabilities and expose no permission/question
    // UI, so no client method is implemented. Never silently treat an id-
    // carrying request as a notification: the agent would wait forever for a
    // response and leave session/prompt wedged until its five-minute idle kill.
    if ("id" in msg && "method" in msg && (msg as any).method) {
      const request = msg as JsonRpcServerRequest;
      this.emit("serverRequest", request);
      if (this.child && !this.closed) {
        const response = {
          jsonrpc: "2.0" as const,
          id: request.id,
          error: {
            code: -32601,
            message: `Unsupported ACP client method: ${request.method}`,
          },
        };
        this.child.stdin.write(`${JSON.stringify(response)}\n`, (error) => {
          if (error) this.emit("protocolError", error);
        });
      }
      return;
    }
    // Notification frame (has `method`, no correlating `id`).
    if ("method" in msg && (msg as any).method) {
      this.emit("notification", msg as JsonRpcNotification);
    }
  }
}
