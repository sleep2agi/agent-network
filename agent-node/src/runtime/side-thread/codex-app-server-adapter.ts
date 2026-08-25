import type { EventEmitter } from "node:events";
import {
  SideThreadConflictError,
  SideThreadUnsupportedError,
  type ExactBoundary,
  type SideThreadCapability,
  type SideThreadRuntimeAdapter,
  type SideThreadTerminalEvent,
} from "./domain";

export interface SideThreadCodexClient extends EventEmitter {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export interface CodexSideThreadAdapterOptions {
  client: SideThreadCodexClient;
  runtimeVersion: string;
  topology: "owned-stdio" | "owned-websocket" | "shared-websocket";
  evidenceRevision: string;
  experimentalApi: boolean;
  identityTimeoutMs?: number;
}

interface Execution {
  sideThreadId: string;
  attemptId: string;
  threadId: string;
  clientUserMessageId: string;
  responseTurnId?: string;
  turnId?: string;
  text: string;
  resolveIdentity: (turnId: string) => void;
  rejectIdentity: (error: Error) => void;
  identityTimer: ReturnType<typeof setTimeout>;
  pendingTerminal?: unknown;
}

/** Native exact-boundary adapter proven only by PR0's 0.148.0 owned probe. */
export class CodexAppServerSideThreadAdapter implements SideThreadRuntimeAdapter {
  private readonly listeners = new Set<(event: SideThreadTerminalEvent) => void>();
  private readonly droppedListeners = new Set<(reason: string) => void>();
  private readonly derivedThreads = new Map<string, string>();
  private readonly byClientId = new Map<string, Execution>();
  private readonly byTurn = new Map<string, Execution>();
  private readonly earlyTerminals = new Map<string, unknown>();
  private closed = false;

  constructor(private readonly opts: CodexSideThreadAdapterOptions) {
    opts.client.on("item/started", this.onItem);
    opts.client.on("item/completed", this.onItem);
    opts.client.on("item/agentMessage/delta", this.onDelta);
    opts.client.on("turn/completed", this.onCompleted);
  }

  capability(): SideThreadCapability {
    if (this.opts.runtimeVersion !== "0.148.0") return unsupported("version", this.opts);
    if (this.opts.topology !== "owned-stdio") return unsupported("topology", this.opts);
    if (this.opts.evidenceRevision !== "test1190-wire-v2") return unsupported("exact-boundary", this.opts);
    return {
      supported: true, runtime: "codex-app-server", runtimeVersion: this.opts.runtimeVersion,
      topology: this.opts.topology, evidenceRevision: this.opts.evidenceRevision,
      mode: "native-exact-fork",
      exactBoundary: { through: true, before: this.opts.experimentalApi },
    };
  }

  async fork(input: { sideThreadId: string; sourceThreadId: string; boundary: ExactBoundary }): Promise<{ derivedThreadId: string }> {
    this.assertOpen();
    this.assertSupported();
    if (!this.capability().exactBoundary?.[input.boundary.kind]) {
      throw new SideThreadUnsupportedError(
        input.boundary.kind === "before" ? "experimental-api" : "exact-boundary",
        `Codex boundary '${input.boundary.kind}' is unsupported`,
      );
    }
    const params: Record<string, unknown> = {
      threadId: input.sourceThreadId,
      ephemeral: false,
      // No approval/sandbox/cwd/instruction override: native fork inherits
      // source policy. PR1 must not turn BTW into a privilege escalation.
      ...(input.boundary.kind === "through"
        ? { lastTurnId: input.boundary.turnId }
        : { beforeTurnId: input.boundary.turnId }),
    };
    const response = await this.opts.client.request<{ thread?: { id?: string } }>("thread/fork", params);
    this.assertOpen();
    const derivedThreadId = response?.thread?.id;
    if (!derivedThreadId || derivedThreadId === input.sourceThreadId) {
      throw new SideThreadConflictError("Codex returned an invalid derived thread identity");
    }
    if (this.derivedThreads.has(derivedThreadId)) throw new SideThreadConflictError("Codex reused a derived thread identity");
    this.derivedThreads.set(derivedThreadId, input.sideThreadId);
    return { derivedThreadId };
  }

  async start(input: { sideThreadId: string; attemptId: string; derivedThreadId: string; prompt: string }): Promise<{ turnId: string }> {
    this.assertOpen();
    this.assertOwnedThread(input.derivedThreadId, input.sideThreadId);
    const clientUserMessageId = `anet-side:${input.sideThreadId}:${input.attemptId}`;
    if (this.byClientId.has(clientUserMessageId)) throw new SideThreadConflictError("duplicate Codex attempt identity");
    let resolveIdentity!: (turnId: string) => void;
    let rejectIdentity!: (error: Error) => void;
    const identity = new Promise<string>((resolve, reject) => { resolveIdentity = resolve; rejectIdentity = reject; });
    void identity.catch(() => {});
    const execution: Execution = {
      sideThreadId: input.sideThreadId, attemptId: input.attemptId,
      threadId: input.derivedThreadId, clientUserMessageId,
      text: "", resolveIdentity, rejectIdentity,
      identityTimer: setTimeout(() => {
        this.dropExecution(execution);
        rejectIdentity(new SideThreadConflictError("Codex did not echo the attempt identity"));
      }, this.opts.identityTimeoutMs ?? 10_000),
    };
    this.byClientId.set(clientUserMessageId, execution);
    try {
      let response: { turn?: { id?: string }; turnId?: string } | undefined;
      try {
        const request = this.opts.client.request<{ turn?: { id?: string }; turnId?: string }>("turn/start", {
        threadId: input.derivedThreadId,
        clientUserMessageId,
        input: [{ type: "text", text: input.prompt }],
        });
        const abortOnIdentityFailure = identity.then(
          () => new Promise<never>(() => {}),
          (error) => Promise.reject(error),
        );
        response = await Promise.race([request, abortOnIdentityFailure]);
      } catch (error) {
        // The response can be lost after app-server accepted the turn. The
        // echoed client id is authoritative and makes retrying unsafe.
        if (!execution.turnId) throw error;
      }
      this.assertOpen();
      execution.responseTurnId = response?.turn?.id;
      if (!execution.responseTurnId && !execution.turnId) throw new SideThreadConflictError("Codex returned an invalid turn identity");
      // Response identity alone is not authoritative: Codex automatic goal
      // continuation can replace it. Wait for the echoed client id.
      const turnId = await identity;
      if (execution.pendingTerminal) {
        const pending = execution.pendingTerminal;
        execution.pendingTerminal = undefined;
        setTimeout(() => this.onCompleted(pending), 0);
      }
      return { turnId };
    } catch (error) {
      this.dropExecution(execution);
      throw error;
    }
  }

  async cancel(input: { derivedThreadId: string; turnId: string }): Promise<void> {
    this.assertOpen();
    this.assertOwnedThread(input.derivedThreadId);
    const execution = this.byTurn.get(turnKey(input.derivedThreadId, input.turnId));
    if (!execution) throw new SideThreadConflictError("refusing to cancel an unowned Codex turn");
    await this.opts.client.request("turn/interrupt", { threadId: input.derivedThreadId, turnId: input.turnId });
  }

  async archive(input: { derivedThreadId: string }): Promise<void> {
    this.assertOpen();
    this.assertOwnedThread(input.derivedThreadId);
    await this.opts.client.request("thread/archive", { threadId: input.derivedThreadId });
  }

  async delete(input: { derivedThreadId: string }): Promise<void> {
    this.assertOpen();
    this.assertOwnedThread(input.derivedThreadId);
    if ([...this.byTurn.values(), ...this.byClientId.values()].some((x) => x.threadId === input.derivedThreadId)) {
      throw new SideThreadConflictError("refusing to delete a thread with an active owned turn");
    }
    await this.opts.client.request("thread/delete", { threadId: input.derivedThreadId });
    this.derivedThreads.delete(input.derivedThreadId);
  }

  subscribe(listener: (event: SideThreadTerminalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeDropped(listener: (reason: string) => void): () => void {
    this.droppedListeners.add(listener);
    return () => this.droppedListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.client.off("item/started", this.onItem);
    this.opts.client.off("item/completed", this.onItem);
    this.opts.client.off("item/agentMessage/delta", this.onDelta);
    this.opts.client.off("turn/completed", this.onCompleted);
    for (const execution of this.byClientId.values()) {
      clearTimeout(execution.identityTimer);
      execution.rejectIdentity(new SideThreadConflictError("Codex side-thread adapter closed"));
    }
    this.byClientId.clear();
    this.byTurn.clear();
    this.earlyTerminals.clear();
    this.listeners.clear();
    this.droppedListeners.clear();
  }

  private readonly onItem = (params: unknown): void => {
    const p = params as { threadId?: string; turnId?: string; item?: { type?: string; clientId?: string; text?: string } };
    if (!p?.threadId || !p.turnId || !p.item) return;
    const clientId = p.item.clientId;
    if (p.item.type === "userMessage" && clientId) {
      const execution = this.byClientId.get(clientId);
      if (!execution || execution.threadId !== p.threadId) { this.dropped("identity-ownership-mismatch"); return; }
      if (execution.turnId && execution.turnId !== p.turnId) { this.dropped("identity-turn-mismatch"); return; }
      execution.turnId = p.turnId;
      this.byTurn.set(turnKey(p.threadId, p.turnId), execution);
      clearTimeout(execution.identityTimer);
      execution.resolveIdentity(p.turnId);
      const early = this.earlyTerminals.get(turnKey(p.threadId, p.turnId));
      if (early) { this.earlyTerminals.delete(turnKey(p.threadId, p.turnId)); execution.pendingTerminal = early; }
      return;
    }
    if (p.item.type === "agentMessage" && typeof p.item.text === "string") {
      const execution = this.byTurn.get(turnKey(p.threadId, p.turnId));
      if (execution) execution.text = p.item.text; else this.dropped("unowned-agent-message");
    }
  };

  private readonly onDelta = (params: unknown): void => {
    const p = params as { threadId?: string; turnId?: string; delta?: string };
    if (!p?.threadId || !p.turnId || typeof p.delta !== "string") return;
    const execution = this.byTurn.get(turnKey(p.threadId, p.turnId));
    if (execution) execution.text += p.delta; else this.dropped("unowned-delta");
  };

  private readonly onCompleted = (params: unknown): void => {
    const p = params as { threadId?: string; turn?: { id?: string; status?: string; error?: { message?: string } | string } };
    const turnId = p?.turn?.id;
    if (!p?.threadId || !turnId) return;
    const execution = this.byTurn.get(turnKey(p.threadId, turnId));
    if (!execution) {
      const starting = [...this.byClientId.values()].some((x) => x.threadId === p.threadId);
      if (starting && this.earlyTerminals.size < 64) this.earlyTerminals.set(turnKey(p.threadId, turnId), params);
      else this.dropped(starting ? "terminal-buffer-full" : "unowned-terminal");
      return;
    }
    const status = p.turn?.status;
    const event: SideThreadTerminalEvent = {
      sideThreadId: execution.sideThreadId, attemptId: execution.attemptId,
      threadId: execution.threadId, turnId,
      status: status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed",
      text: status === "completed" ? execution.text : undefined,
      error: status !== "completed" && status !== "interrupted"
        ? typeof p.turn?.error === "string" ? p.turn.error : p.turn?.error?.message
        : undefined,
    };
    this.dropExecution(execution);
    for (const listener of this.listeners) listener(event);
  };

  private dropExecution(execution: Execution): void {
    clearTimeout(execution.identityTimer);
    this.byClientId.delete(execution.clientUserMessageId);
    if (execution.turnId) this.byTurn.delete(turnKey(execution.threadId, execution.turnId));
  }

  private assertSupported(): void {
    const capability = this.capability();
    if (!capability.supported) {
      throw new SideThreadUnsupportedError(
        capability.reason ?? "runtime",
        `Codex side thread unsupported: ${capability.reason}`,
      );
    }
  }
  private assertOpen(): void { if (this.closed) throw new SideThreadConflictError("Codex side-thread adapter closed"); }
  private assertOwnedThread(threadId: string, sideThreadId?: string): void {
    this.assertSupported();
    const owner = this.derivedThreads.get(threadId);
    if (!owner || (sideThreadId && owner !== sideThreadId)) throw new SideThreadConflictError("refusing operation on an unowned Codex thread");
  }
  private dropped(reason: string): void { for (const listener of this.droppedListeners) listener(reason); }
}

function unsupported(reason: "version" | "topology" | "exact-boundary", opts: CodexSideThreadAdapterOptions): SideThreadCapability {
  return {
    supported: false, runtime: "codex-app-server", runtimeVersion: opts.runtimeVersion,
    topology: opts.topology, evidenceRevision: opts.evidenceRevision, reason,
  };
}
function turnKey(threadId: string, turnId: string): string { return `${threadId}\0${turnId}`; }
