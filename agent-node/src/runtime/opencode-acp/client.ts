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
import { readdirSync, readFileSync } from "fs";
import { isAbsolute } from "path";
import { OPENCODE_GROUP_SUPERVISOR_SOURCE } from "./group-supervisor";

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

export interface OpencodeSupervisorReceipt {
  pid: number;
  identity: string;
  processGroupId: number;
  sessionId: number;
}

type ClientLifecycle =
  | "starting"
  | "running"
  | "stopping"
  | "finalizing"
  | "cleanup-failed"
  | "closed";

interface LinuxProcessStat {
  identity: string;
  state: string;
  processGroupId: number;
  sessionId: number;
}

function readLinuxProcessStat(pid: number): LinuxProcessStat | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const source = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = source.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = source.slice(close + 1).trim().split(/\s+/);
    const processGroupId = Number(fields[2]);
    const sessionId = Number(fields[3]);
    const start = fields[19];
    if (!fields[0] || !start
      || !Number.isSafeInteger(processGroupId) || processGroupId <= 0
      || !Number.isSafeInteger(sessionId) || sessionId <= 0) return undefined;
    return {
      identity: `${pid}:${start}`,
      state: fields[0],
      processGroupId,
      sessionId,
    };
  } catch {
    return undefined;
  }
}

function inspectSupervisorSession(
  receipt: OpencodeSupervisorReceipt,
): "gone" | "residual" | "unknown" {
  if (process.platform !== "linux") return "unknown";
  const currentLeader = readLinuxProcessStat(receipt.pid);
  if (currentLeader && currentLeader.identity !== receipt.identity) {
    // The PID/SID number cannot be reused while the old session still has a
    // member. A different starttime therefore proves the captured session is
    // gone; critically, it is never a reason to signal the new process.
    return "gone";
  }
  let entries: string[];
  try { entries = readdirSync("/proc"); }
  catch { return "unknown"; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readLinuxProcessStat(Number(entry));
    if (!stat || stat.state === "Z" || stat.state === "X") continue;
    if (stat.sessionId === receipt.sessionId
      || stat.processGroupId === receipt.processGroupId) return "residual";
  }
  return "gone";
}

export class OpencodeAcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rxBuffer = "";
  private lifecycle: ClientLifecycle = "closed";
  private useGroupSupervisor = false;
  private supervisorReceipt: OpencodeSupervisorReceipt | null = null;
  private pinnedBinary = "";
  private vendorStarted = false;
  private vendorProcessIdValue: number | undefined;
  private vendorExitInfo: OpencodeAcpExitInfo | null = null;
  private nativeExitInfo: OpencodeAcpExitInfo | null = null;
  private finalizationPromise: Promise<void> | null = null;
  private lastCleanupError: Error | null = null;
  private publicExitEmitted = false;
  private supervisorWatchTimer: ReturnType<typeof setInterval> | null = null;
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

  /** Dedicated Linux process group owned by the durable supervisor anchor. */
  get processGroupId(): number | undefined {
    return this.supervisorReceipt?.processGroupId;
  }

  /** Dedicated Linux session. Descendants that change pgrp but not session
   * remain visible to fail-closed launch-root cleanup. */
  get sessionId(): number | undefined {
    return this.supervisorReceipt?.sessionId;
  }

  /** Diagnostic/test receipt only. Lifecycle control must stay on supervisor
   * IPC and must never signal this numeric PID from the parent. */
  get vendorProcessId(): number | undefined {
    return this.vendorProcessIdValue;
  }

  get cleanupConfirmed(): boolean {
    return this.lifecycle === "closed";
  }

  get cleanupError(): Error | null {
    return this.lastCleanupError;
  }

  start(opts: OpencodeAcpClientOptions = {}): void {
    if (this.child) throw new Error("OpencodeAcpClient already started");
    const bin = opts.binary ?? "opencode";
    // NOTE: `opencode acp` v1.17.13 IGNORES --port/--hostname (see
    // Phase 0b U8 finding — flags are accepted for CLI parsing but
    // the server binds to stdio only). Do not pass them here.
    this.pinnedBinary = bin;
    this.useGroupSupervisor = process.platform === "linux";
    this.lifecycle = "starting";
    this.child = spawn(
      this.useGroupSupervisor ? process.execPath : bin,
      this.useGroupSupervisor ? ["-e", OPENCODE_GROUP_SUPERVISOR_SOURCE] : ["acp"],
      {
      cwd: opts.cwd ?? process.cwd(),
      // `spawn()` inherits process.env when `env` is undefined. Use an empty
      // object as the lower-level default so a caller can never accidentally
      // leak agent-node's CommHub/channel/MCP credentials. runtime.ts always
      // supplies the exact allowlisted environment built in child-env.ts.
      env: opts.env ?? {},
      stdio: this.useGroupSupervisor
        ? ["pipe", "pipe", "pipe", "ipc"]
        : ["pipe", "pipe", "pipe"],
      // Linux supervisor pid=pgid=sid is the stable identity anchor. OpenCode
      // itself is launched only after its marker is durable.
      detached: this.useGroupSupervisor,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    if (this.useGroupSupervisor) {
      this.child.on("message", (message) => this.onSupervisorMessage(message));
      this.child.on("disconnect", () => this.onSupervisorDisconnect());
    } else {
      this.lifecycle = "running";
      this.vendorStarted = true;
    }
    this.child.on("exit", (code, signal) => {
      void this.finalizeExit(code, signal);
    });
    this.child.on("error", (err) => {
      // A spawn failure may emit `error` without `exit`. Finalize first so
      // stop() and any handshake request cannot hang forever. EventEmitter's
      // special `error` event throws when unobserved, so surface it only when
      // the caller explicitly subscribed (runtime.ts does).
      void this.finalizeExit(null, null, err);
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
  }

  /** Wait for and independently validate the supervisor identity. OpenCode is
   * still not spawned when this resolves. */
  async prepare(timeoutMs = 5_000): Promise<OpencodeSupervisorReceipt | undefined> {
    if (!this.useGroupSupervisor) return undefined;
    if (this.supervisorReceipt) return this.supervisorReceipt;
    await this.waitForInternalEvent("supervisorReady", timeoutMs);
    if (!this.supervisorReceipt) throw new Error("OpenCode supervisor exited before ready receipt");
    return this.supervisorReceipt;
  }

  /** Launch OpenCode only after runtime.ts has fsync'd the receipt-bound
   * launch marker. */
  async activate(timeoutMs = 5_000): Promise<void> {
    if (!this.useGroupSupervisor) return;
    if (this.vendorStarted && this.lifecycle === "running") return;
    await this.prepare(timeoutMs);
    if (!isAbsolute(this.pinnedBinary)) {
      throw new Error("OpenCode supervisor requires an absolute pinned binary path");
    }
    await this.sendSupervisor({ v: 1, type: "launch", binary: this.pinnedBinary });
    if (!this.vendorStarted) await this.waitForInternalEvent("childStarted", timeoutMs);
    if (!this.vendorStarted || this.lifecycle !== "running") {
      throw this.lastCleanupError ?? new Error("OpenCode supervisor failed before child start");
    }
  }

  async request<R = unknown, P = unknown>(method: string, params?: P, timeoutMs = 30_000): Promise<R> {
    if (!this.child || this.lifecycle !== "running") {
      throw this.lastCleanupError ?? new Error("OpencodeAcpClient not ready or already exited");
    }
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
    if (!this.child || this.lifecycle !== "running") {
      throw this.lastCleanupError ?? new Error("OpencodeAcpClient not ready or already exited");
    }
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

  /**
   * Stop through the supervisor's exact IPC channel. The parent never sends a
   * negative-PGID signal and never SIGKILLs the anchor. A stopped/wedged
   * supervisor therefore times out while retaining the whole owner tree.
   */
  async stop(signal: NodeJS.Signals = "SIGTERM", timeoutMs = 5_000): Promise<void> {
    if (!this.child || this.lifecycle === "closed") return;
    if (!this.useGroupSupervisor) {
      if (this.lifecycle !== "finalizing") this.lifecycle = "stopping";
      this.child.kill(signal);
      await this.waitForPublicExit(timeoutMs);
      return;
    }

    if (this.nativeExitInfo) {
      await this.retryFinalization();
      if (this.lifecycle === "closed") return;
      throw this.lastCleanupError ?? new Error("OpenCode supervisor cleanup remains unconfirmed");
    }

    this.lastCleanupError = null;
    this.lifecycle = "stopping";
    await this.sendSupervisor({
      v: 1,
      type: "stop",
      mode: signal === "SIGKILL" ? "force" : "graceful",
      signal: signal === "SIGINT" ? "SIGINT" : "SIGTERM",
    });
    await this.waitForPublicExit(timeoutMs);
  }

  /**
   * Whether the child process is alive AND still accepting requests.
   * Used by runtime.ts's crash-restart detector.
   */
  get isRunning(): boolean {
    return this.child !== null
      && (this.lifecycle === "starting"
        || this.lifecycle === "running"
        || this.lifecycle === "stopping");
  }

  private async finalizeExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    cause?: Error,
  ): Promise<void> {
    if (this.nativeExitInfo || this.lifecycle === "closed") return;
    this.nativeExitInfo = { code, signal, ...(cause ? { cause } : {}) };
    if (this.supervisorWatchTimer) clearInterval(this.supervisorWatchTimer);
    this.supervisorWatchTimer = null;
    this.lifecycle = "finalizing";
    const err = cause ?? new Error(`opencode acp exited (code=${code} signal=${signal})`);
    this.rejectPending(err);

    if (!this.useGroupSupervisor || !this.supervisorReceipt) {
      this.completeCleanExit(this.vendorExitInfo ?? this.nativeExitInfo);
      return;
    }
    await this.retryFinalization().catch(() => {
      // Native exit handlers cannot surface an async rejection. The separate
      // cleanupError event and retained lifecycle state are the fail-closed
      // public result; an explicit stop() retry still receives the error.
    });
  }

  private async retryFinalization(): Promise<void> {
    if (this.lifecycle === "closed") return;
    if (!this.nativeExitInfo || !this.supervisorReceipt) {
      throw this.lastCleanupError ?? new Error("OpenCode supervisor is still live");
    }
    if (this.finalizationPromise) return this.finalizationPromise;
    this.lifecycle = "finalizing";
    this.finalizationPromise = (async () => {
      const deadline = Date.now() + 1_500;
      let state: "gone" | "residual" | "unknown" = "unknown";
      do {
        state = inspectSupervisorSession(this.supervisorReceipt!);
        if (state === "gone") {
          this.lastCleanupError = null;
          this.completeCleanExit(this.vendorExitInfo ?? this.nativeExitInfo!);
          return;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      } while (Date.now() < deadline);
      throw new Error(
        state === "unknown"
          ? "cannot verify that the OpenCode supervisor session is empty"
          : `OpenCode supervisor exited with live session ${this.supervisorReceipt!.sessionId} members`,
      );
    })().catch((error: any) => {
      this.lifecycle = "cleanup-failed";
      this.lastCleanupError = error instanceof Error ? error : new Error(String(error));
      this.emit("cleanupError", this.lastCleanupError);
      throw this.lastCleanupError;
    }).finally(() => {
      this.finalizationPromise = null;
    });
    return this.finalizationPromise;
  }

  private completeCleanExit(info: OpencodeAcpExitInfo): void {
    if (this.publicExitEmitted) return;
    this.lifecycle = "closed";
    this.lastCleanupError = null;
    this.publicExitEmitted = true;
    if (this.supervisorWatchTimer) clearInterval(this.supervisorWatchTimer);
    this.supervisorWatchTimer = null;
    this.emit("exit", info);
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
  }

  private onSupervisorMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.v !== 1 || typeof value.type !== "string") return;
    if (value.type === "supervisor-ready") {
      const pid = value.pid;
      const processGroupId = value.processGroupId;
      const sessionId = value.sessionId;
      const identity = value.identity;
      const expectedPid = this.child?.pid;
      const stat = typeof pid === "number" ? readLinuxProcessStat(pid) : undefined;
      if (!Number.isSafeInteger(pid) || pid !== expectedPid
        || typeof identity !== "string"
        || processGroupId !== pid || sessionId !== pid
        || !stat || stat.identity !== identity
        || stat.processGroupId !== processGroupId || stat.sessionId !== sessionId
        || stat.state === "Z" || stat.state === "X") {
        this.lastCleanupError = new Error("invalid OpenCode supervisor identity receipt");
        this.emit("supervisorFatal", this.lastCleanupError);
        this.child?.disconnect?.();
        return;
      }
      this.supervisorReceipt = {
        pid,
        identity,
        processGroupId: processGroupId as number,
        sessionId: sessionId as number,
      };
      // Bun can defer ChildProcess exit/disconnect while a surviving vendor
      // still holds inherited fd0/1/2. Procfs identity polling detects an
      // externally killed anchor without relying on those shared pipes.
      this.supervisorWatchTimer = setInterval(() => {
        if (this.nativeExitInfo || this.lifecycle === "closed") return;
        const current = readLinuxProcessStat(pid);
        if (!current || current.identity !== identity) {
          void this.finalizeExit(
            null,
            null,
            new Error("OpenCode supervisor identity disappeared before native exit event"),
          );
        }
      }, 50);
      this.emit("supervisorReady");
      return;
    }
    if (value.type === "child-started") {
      if (!Number.isSafeInteger(value.childPid) || (value.childPid as number) <= 0) {
        this.lastCleanupError = new Error("invalid OpenCode child-started receipt");
        this.emit("supervisorFatal", this.lastCleanupError);
        return;
      }
      this.vendorStarted = true;
      this.vendorProcessIdValue = value.childPid as number;
      this.lifecycle = "running";
      this.emit("childStarted");
      return;
    }
    if (value.type === "vendor-exit") {
      this.vendorExitInfo = {
        code: typeof value.code === "number" ? value.code : null,
        signal: typeof value.signal === "string" ? value.signal as NodeJS.Signals : null,
      };
      return;
    }
    if (value.type === "cleanup-failed") {
      const error = new Error(
        `OpenCode supervisor retained its owner tree: ${String(value.reason ?? "cleanup failed")}`,
      );
      this.lifecycle = "cleanup-failed";
      this.lastCleanupError = error;
      this.rejectPending(error);
      this.emit("cleanupError", error);
      return;
    }
    if (value.type === "fatal") {
      const error = new Error(
        `OpenCode supervisor ${String(value.phase ?? "fatal")}: ${String(value.message ?? "unknown error")}`,
      );
      this.lastCleanupError = error;
      this.rejectPending(error);
      this.emit("supervisorFatal", error);
    }
  }

  private onSupervisorDisconnect(): void {
    const receipt = this.supervisorReceipt;
    if (!this.useGroupSupervisor || !receipt || this.nativeExitInfo) return;
    // Bun may defer ChildProcess `exit` until inherited fd0/1/2 close. The
    // private IPC descriptor is not inherited by OpenCode, so disconnect is
    // the prompt supervisor-death signal. Poll the captured starttime before
    // finalizing; never infer identity from a bare numeric PID.
    const deadline = Date.now() + 2_000;
    const poll = () => {
      if (this.nativeExitInfo) return;
      const current = readLinuxProcessStat(receipt.pid);
      if (!current || current.identity !== receipt.identity) {
        void this.finalizeExit(
          null,
          null,
          new Error("OpenCode supervisor IPC disconnected before native exit event"),
        );
        return;
      }
      if (Date.now() >= deadline) {
        const error = new Error("OpenCode supervisor IPC disconnected while its identity remains live");
        this.lifecycle = "cleanup-failed";
        this.lastCleanupError = error;
        this.rejectPending(error);
        this.emit("cleanupError", error);
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  }

  private async sendSupervisor(message: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || !child.connected || typeof child.send !== "function") {
      throw this.lastCleanupError ?? new Error("OpenCode supervisor IPC channel is closed");
    }
    await new Promise<void>((resolve, reject) => {
      child.send(message, (error) => error ? reject(error) : resolve());
    });
  }

  private async waitForInternalEvent(event: string, timeoutMs: number): Promise<void> {
    const predicate = event === "supervisorReady"
      ? () => this.supervisorReceipt !== null
      : () => this.vendorStarted;
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off(event, onReady);
        this.off("supervisorFatal", onFatal);
        this.off("exit", onExit);
        this.off("cleanupError", onFatal);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onFatal = (error: Error) => { cleanup(); reject(error); };
      const onExit = () => {
        cleanup();
        reject(this.lastCleanupError ?? new Error(`opencode acp exited before ${event}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for OpenCode ${event} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.once(event, onReady);
      this.once("supervisorFatal", onFatal);
      this.once("cleanupError", onFatal);
      this.once("exit", onExit);
      if (predicate()) onReady();
    });
  }

  private async waitForPublicExit(timeoutMs: number): Promise<void> {
    if (this.lifecycle === "closed") return;
    if (this.lifecycle === "cleanup-failed" && this.lastCleanupError) throw this.lastCleanupError;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("exit", onExit);
        this.off("cleanupError", onFailure);
      };
      const onExit = () => { cleanup(); resolve(); };
      const onFailure = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(
          `OpenCode supervisor stop timed out after ${timeoutMs}ms; owner tree retained`,
        ));
      }, timeoutMs);
      this.once("exit", onExit);
      this.once("cleanupError", onFailure);
      if (this.lifecycle === "closed") onExit();
      else if (this.lifecycle === "cleanup-failed" && this.lastCleanupError) {
        onFailure(this.lastCleanupError);
      }
    });
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
      if (this.child && this.lifecycle === "running") {
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
