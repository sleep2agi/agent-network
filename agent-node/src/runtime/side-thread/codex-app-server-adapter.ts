import type { EventEmitter } from "node:events";
import {
  SideThreadConflictError,
  SideThreadAmbiguousError,
  SideThreadUnsupportedError,
  type ExactBoundary,
  type SideThreadCapability,
  type SideThreadRuntimeAdapter,
  type SideThreadRuntimeOperation,
  type SideThreadTerminalEvent,
} from "./domain";
import { operationHash, stableOperationId, type OperationLedger, type OperationMethod, type SideThreadOperation } from "./operation-ledger";
import type { ForkLeaseStore } from "./fork-lease";

export interface SideThreadCodexClient extends EventEmitter {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export interface CodexSideThreadAdapterOptions {
  client: SideThreadCodexClient;
  runtimeVersion: string;
  topology: "owned-stdio" | "owned-websocket" | "shared-websocket";
  evidenceRevision: string;
  experimentalApi: boolean;
  nodeId: string;
  operationLedger: OperationLedger;
  forkLeaseStore: ForkLeaseStore;
  identityTimeoutMs?: number;
  now?: () => number;
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
  readyForTerminal: boolean;
  identityAmbiguous: boolean;
}

/** Native exact-boundary adapter proven only by PR0's 0.148.0 owned probe. */
export class CodexAppServerSideThreadAdapter implements SideThreadRuntimeAdapter {
  private readonly listeners = new Set<(event: SideThreadTerminalEvent) => void>();
  private readonly droppedListeners = new Set<(reason: string) => void>();
  private readonly derivedThreads = new Map<string, string>();
  private readonly byClientId = new Map<string, Execution>();
  private readonly byTurn = new Map<string, Execution>();
  private readonly pendingStartThreads = new Set<string>();
  private readonly earlyTerminals = new Map<string, unknown>();
  private closed = false;
  private readonly closedSignal: Promise<never>;
  private rejectClosed!: (error: Error) => void;

  constructor(private readonly opts: CodexSideThreadAdapterOptions) {
    this.closedSignal = new Promise<never>((_resolve, reject) => { this.rejectClosed = reject; });
    void this.closedSignal.catch(() => {});
    opts.client.on("item/started", this.onItem);
    opts.client.on("item/completed", this.onItem);
    opts.client.on("item/agentMessage/delta", this.onDelta);
    opts.client.on("turn/completed", this.onCompleted);
  }

  capability(): SideThreadCapability {
    if (this.opts.runtimeVersion !== "0.148.0") return unsupported("version", this.opts);
    if (this.opts.topology !== "owned-stdio") return unsupported("topology", this.opts);
    if (!this.opts.forkLeaseStore.claimSupported()) return unsupported("topology", this.opts);
    if (this.opts.evidenceRevision !== "test1190-wire-v2") return unsupported("exact-boundary", this.opts);
    return {
      supported: true, runtime: "codex-app-server", runtimeVersion: this.opts.runtimeVersion,
      topology: this.opts.topology, evidenceRevision: this.opts.evidenceRevision,
      mode: "native-exact-fork",
      exactBoundary: { through: true, before: this.opts.experimentalApi === true },
    };
  }

  async fork(input: { sideThreadId: string; sourceThreadId: string; boundary: ExactBoundary; operation?: SideThreadRuntimeOperation }): Promise<{ derivedThreadId: string }> {
    this.assertOpen();
    this.assertSupported();
    if (!this.capability().exactBoundary?.[input.boundary.kind]) {
      throw new SideThreadUnsupportedError(
        input.boundary.kind === "before" ? "experimental-api" : "exact-boundary",
        `Codex boundary '${input.boundary.kind}' is unsupported`,
      );
    }
    const identity = input.operation ?? this.defaultOperation(input.sideThreadId, "fork", `fork-${input.sideThreadId}`);
    let claim;
    try { claim = await this.opts.forkLeaseStore.claim(identity.nodeId, input.sourceThreadId); }
    catch (error) {
      if (error instanceof Error && error.message === "runtime operation executor is already claimed") {
        throw new SideThreadAmbiguousError("Codex fork is already executing; refusing duplicate thread/fork");
      }
      throw error;
    }
    try { return await this.forkClaimed(input, identity); }
    finally { await claim.release(); }
  }

  private async forkClaimed(input: { sideThreadId: string; sourceThreadId: string; boundary: ExactBoundary; operation?: SideThreadRuntimeOperation },
    identity: SideThreadRuntimeOperation): Promise<{ derivedThreadId: string }> {
    this.assertOpen();
    const operation = this.operation(identity, input.sideThreadId, "fork", input.sourceThreadId,
      JSON.stringify([input.sourceThreadId, input.boundary.kind, input.boundary.turnId]));
    const existing = this.existing(operation);
    if (existing && existing.state !== "prepared") return this.reconcileFork({ ...input, operation: identity }, existing);
    if (!existing) this.put(operation);
    const sourceThreadHash = operationHash(input.sourceThreadId);
    let lease = this.opts.forkLeaseStore.acquire({
      version: 1, nodeId: identity.nodeId, sourceThreadHash,
      sideThreadId: input.sideThreadId, operationId: identity.operationId,
      fingerprint: operation.fingerprint, snapshotThreadIdHashes: operation.result?.snapshotThreadIdHashes ?? [],
      state: "snapshot", updatedAt: this.now(),
    });
    if (lease.state !== "snapshot") return this.reconcileFork({ ...input, operation: identity }, this.mustOperation(operation));
    let current = this.mustOperation(operation);
    let authoritativeSnapshot = current.result?.snapshotThreadIdHashes;
    if (authoritativeSnapshot) {
      if (lease.snapshotThreadIdHashes.length > 0
        && JSON.stringify(lease.snapshotThreadIdHashes) !== JSON.stringify(authoritativeSnapshot)) {
        throw new SideThreadConflictError("fork snapshot authority mismatch");
      }
      if (JSON.stringify(lease.snapshotThreadIdHashes) !== JSON.stringify(authoritativeSnapshot)) {
        lease = { ...lease, snapshotThreadIdHashes: [...authoritativeSnapshot], updatedAt: this.now() };
        this.opts.forkLeaseStore.put(lease);
      }
    } else if (lease.snapshotThreadIdHashes.length > 0) {
      // Recovery for the old two-write ordering: the lease fsync completed but
      // the operation snapshot did not. The already-durable lease is the only
      // safe pre-send authority; never re-list and adopt an older fork.
      authoritativeSnapshot = [...lease.snapshotThreadIdHashes];
      current = { ...current, result: { ...current.result, snapshotThreadIdHashes: authoritativeSnapshot }, updatedAt: this.now() };
      this.put(current);
    } else {
      const snapshot = await this.listThreads();
      authoritativeSnapshot = snapshot.map((thread) => operationHash(thread.id));
      // Persist the operation authority first. A crash before the lease update
      // is recovered from this record; a crash before this write is pre-send.
      current = { ...current, result: { ...current.result, snapshotThreadIdHashes: authoritativeSnapshot }, updatedAt: this.now() };
      this.put(current);
      lease = { ...lease, snapshotThreadIdHashes: [...authoritativeSnapshot], updatedAt: this.now() };
      this.opts.forkLeaseStore.put(lease);
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
    const sent = { ...this.mustOperation(operation), state: "sent" as const, updatedAt: this.now() };
    this.put(sent);
    lease = { ...lease, state: "sent", updatedAt: this.now() }; this.opts.forkLeaseStore.put(lease);
    let response: { thread?: { id?: string } };
    try { response = await this.rpc<{ thread?: { id?: string } }>("thread/fork", params); }
    catch (error) {
      const ambiguous = { ...sent, state: "ambiguous" as const, updatedAt: this.now() };
      this.put(ambiguous); this.opts.forkLeaseStore.put({ ...lease, state: "ambiguous", updatedAt: this.now() });
      return this.reconcileFork({ ...input, operation: identity }, ambiguous, error);
    }
    this.assertOpen();
    const derivedThreadId = response?.thread?.id;
    if (!derivedThreadId || derivedThreadId === input.sourceThreadId) {
      throw new SideThreadConflictError("Codex returned an invalid derived thread identity");
    }
    if (this.derivedThreads.has(derivedThreadId)) throw new SideThreadConflictError("Codex reused a derived thread identity");
    this.derivedThreads.set(derivedThreadId, input.sideThreadId);
    this.put({ ...sent, state: "accepted", result: { ...sent.result, derivedThreadIdHash: operationHash(derivedThreadId) }, updatedAt: this.now() });
    this.opts.forkLeaseStore.release(identity.nodeId, input.sourceThreadId, identity.operationId);
    return { derivedThreadId };
  }

  async start(input: { sideThreadId: string; attemptId: string; derivedThreadId: string; prompt: string; operation?: SideThreadRuntimeOperation }): Promise<{ turnId: string }> {
    this.assertOpen();
    this.assertOwnedThread(input.derivedThreadId, input.sideThreadId);
    const clientUserMessageId = `anet-side:${input.sideThreadId}:${input.attemptId}`;
    const identity = input.operation ?? this.defaultOperation(input.sideThreadId, "start", `start-${input.attemptId}`);
    this.pendingStartThreads.add(input.derivedThreadId);
    let claim;
    try { claim = await this.opts.forkLeaseStore.claimOperation(identity.nodeId, input.sideThreadId, identity.operationId); }
    catch (error) {
      this.pendingStartThreads.delete(input.derivedThreadId);
      if (error instanceof Error && error.message === "runtime operation executor is already claimed") {
        throw new SideThreadAmbiguousError("Codex start is already executing; refusing duplicate turn/start");
      }
      throw error;
    }
    try { return await this.startClaimed(input, identity, clientUserMessageId); }
    catch (error) {
      if (this.closed && error instanceof SideThreadConflictError) {
        throw new SideThreadAmbiguousError("Codex start closed before its durable outcome was observed");
      }
      throw error;
    }
    finally { this.pendingStartThreads.delete(input.derivedThreadId); await claim.release(); }
  }

  private async startClaimed(input: { sideThreadId: string; attemptId: string; derivedThreadId: string; prompt: string; operation?: SideThreadRuntimeOperation },
    identity: SideThreadRuntimeOperation, clientUserMessageId: string): Promise<{ turnId: string }> {
    this.assertOpen();
    const operation = this.operation(identity, input.sideThreadId, "start", input.derivedThreadId,
      JSON.stringify([input.sideThreadId, input.attemptId, input.derivedThreadId, operationHash(input.prompt)]));
    const prior = this.existing(operation);
    if (prior && prior.state !== "prepared") return this.reconcileStart({ ...input, operation: identity }, clientUserMessageId, prior);
    if (!prior) this.put(operation);
    if (this.byClientId.has(clientUserMessageId)) return this.reconcileStart({ ...input, operation: identity }, clientUserMessageId, this.mustOperation(operation));
    let resolveIdentity!: (turnId: string) => void;
    let rejectIdentity!: (error: Error) => void;
    const identityEcho = new Promise<string>((resolve, reject) => { resolveIdentity = resolve; rejectIdentity = reject; });
    void identityEcho.catch(() => {});
    const execution: Execution = {
      sideThreadId: input.sideThreadId, attemptId: input.attemptId,
      threadId: input.derivedThreadId, clientUserMessageId,
      text: "", resolveIdentity, rejectIdentity,
      readyForTerminal: false,
      identityAmbiguous: false,
      identityTimer: setTimeout(() => {
        execution.identityAmbiguous = true;
        rejectIdentity(new SideThreadAmbiguousError("Codex accepted turn/start but did not echo identity; reconciliation required"));
      }, this.opts.identityTimeoutMs ?? 10_000),
    };
    this.byClientId.set(clientUserMessageId, execution);
    const sent = { ...this.mustOperation(operation), state: "sent" as const, updatedAt: this.now() };
    this.put(sent);
    try {
      let response: { turn?: { id?: string }; turnId?: string } | undefined;
      try {
        const request = this.rpc<{ turn?: { id?: string }; turnId?: string }>("turn/start", {
        threadId: input.derivedThreadId,
        clientUserMessageId,
        input: [{ type: "text", text: input.prompt }],
        });
        const abortOnIdentityFailure = identityEcho.then(
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
      const turnId = await identityEcho;
      execution.readyForTerminal = true;
      if (execution.pendingTerminal) {
        const pending = execution.pendingTerminal;
        execution.pendingTerminal = undefined;
        setTimeout(() => this.onCompleted(pending), 0);
      }
      this.put({ ...sent, state: "accepted", result: { turnIdHash: operationHash(turnId) }, updatedAt: this.now() });
      return { turnId };
    } catch (error) {
      const current = this.mustOperation(operation);
      if (current.state === "sent") this.put({ ...current, state: "ambiguous", updatedAt: this.now() });
      if (!(error instanceof SideThreadAmbiguousError) && !execution.turnId) execution.identityAmbiguous = true;
      throw error instanceof SideThreadAmbiguousError ? error
        : new SideThreadAmbiguousError("Codex start outcome is ambiguous; refusing a duplicate turn/start");
    }
  }

  async cancel(input: { sideThreadId?: string; derivedThreadId: string; turnId: string; operation?: SideThreadRuntimeOperation }): Promise<void> {
    this.assertOpen();
    this.assertOwnedThread(input.derivedThreadId);
    const execution = this.byTurn.get(turnKey(input.derivedThreadId, input.turnId));
    if (!execution) throw new SideThreadConflictError("refusing to cancel an unowned Codex turn");
    const sideThreadId = input.sideThreadId ?? execution.sideThreadId;
    await this.durableMutation(sideThreadId, "interrupt", input.operation ?? this.defaultOperation(sideThreadId, "interrupt", `cancel-${execution.attemptId}`), input.derivedThreadId,
      JSON.stringify([input.derivedThreadId, input.turnId]), "turn/interrupt",
      { threadId: input.derivedThreadId, turnId: input.turnId });
  }

  async archive(input: { sideThreadId?: string; derivedThreadId: string; operation?: SideThreadRuntimeOperation }): Promise<void> {
    this.assertOpen();
    this.assertOwnedThread(input.derivedThreadId);
    const sideThreadId = input.sideThreadId ?? this.derivedThreads.get(input.derivedThreadId)!;
    await this.durableMutation(sideThreadId, "archive", input.operation ?? this.defaultOperation(sideThreadId, "archive", `archive-${sideThreadId}`), input.derivedThreadId,
      JSON.stringify([input.derivedThreadId]), "thread/archive", { threadId: input.derivedThreadId });
  }

  async delete(input: { sideThreadId?: string; derivedThreadId: string; operation?: SideThreadRuntimeOperation }): Promise<void> {
    this.assertOpen();
    this.assertOwnedThread(input.derivedThreadId);
    if (this.pendingStartThreads.has(input.derivedThreadId)
      || [...this.byTurn.values(), ...this.byClientId.values()].some((x) => x.threadId === input.derivedThreadId)) {
      throw new SideThreadConflictError("refusing to delete a thread with an active owned turn");
    }
    const sideThreadId = input.sideThreadId ?? this.derivedThreads.get(input.derivedThreadId)!;
    await this.durableMutation(sideThreadId, "delete", input.operation ?? this.defaultOperation(sideThreadId, "delete", `purge-${sideThreadId}`), input.derivedThreadId,
      JSON.stringify([input.derivedThreadId]), "thread/delete", { threadId: input.derivedThreadId });
    this.derivedThreads.delete(input.derivedThreadId);
  }
  async discardFork(input: { sideThreadId: string; derivedThreadId: string; operation?: SideThreadRuntimeOperation }): Promise<void> {
    if (this.derivedThreads.get(input.derivedThreadId) !== input.sideThreadId) return;
    const identity = input.operation ?? this.defaultOperation(input.sideThreadId, "delete", `discard-${input.sideThreadId}`);
    await this.durableMutation(input.sideThreadId, "delete", identity, input.derivedThreadId,
      JSON.stringify([input.derivedThreadId, "discard"]), "thread/delete", { threadId: input.derivedThreadId });
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
    this.rejectClosed(new SideThreadConflictError("Codex side-thread adapter closed"));
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
    this.pendingStartThreads.clear();
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
      if (execution.identityAmbiguous) execution.readyForTerminal = true;
      const early = this.earlyTerminals.get(turnKey(p.threadId, p.turnId));
      if (early) {
        this.earlyTerminals.delete(turnKey(p.threadId, p.turnId));
        execution.pendingTerminal = early;
        if (execution.readyForTerminal) setTimeout(() => this.onCompleted(early), 0);
      }
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
      const starting = this.pendingStartThreads.has(p.threadId)
        || [...this.byClientId.values()].some((x) => x.threadId === p.threadId);
      if (starting && this.earlyTerminals.size < 64) this.earlyTerminals.set(turnKey(p.threadId, turnId), params);
      else this.dropped(starting ? "terminal-buffer-full" : "unowned-terminal");
      return;
    }
    const status = p.turn?.status;
    if (!execution.readyForTerminal) { execution.pendingTerminal = params; return; }
    const event: SideThreadTerminalEvent = {
      sideThreadId: execution.sideThreadId, attemptId: execution.attemptId,
      threadId: execution.threadId, turnId,
      status: status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed",
      text: status === "completed" ? execution.text : undefined,
      error: status !== "completed" && status !== "interrupted"
        ? typeof p.turn?.error === "string" ? p.turn.error : p.turn?.error?.message
        : undefined,
      identityBound: true,
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
  private rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.assertOpen();
    return Promise.race([this.opts.client.request<T>(method, params), this.closedSignal]);
  }
  private now(): number { return this.opts.now?.() ?? Date.now(); }
  private defaultOperation(sideThreadId: string, method: OperationMethod, idempotencyKey: string): SideThreadRuntimeOperation {
    return { nodeId: this.opts.nodeId, operationId: stableOperationId(sideThreadId, method, idempotencyKey), idempotencyKey };
  }
  private operation(identity: SideThreadRuntimeOperation, sideThreadId: string, method: OperationMethod, target: string, fingerprint: string): SideThreadOperation {
    if (identity.operationId.length === 0 || identity.idempotencyKey.length === 0 || identity.nodeId.length === 0) {
      throw new SideThreadConflictError("missing persistent operation identity");
    }
    if (identity.nodeId !== this.opts.nodeId) throw new SideThreadConflictError("persistent operation node ownership mismatch");
    return { version: 1, nodeId: identity.nodeId, sideThreadId, opId: identity.operationId,
      idempotencyKey: identity.idempotencyKey, method, targetHash: operationHash(target),
      fingerprint: operationHash(fingerprint), state: "prepared", updatedAt: this.now() };
  }
  private existing(expected: SideThreadOperation): SideThreadOperation | undefined {
    const existing = this.opts.operationLedger.get(expected.nodeId, expected.sideThreadId, expected.opId);
    if (!existing) return undefined;
    for (const key of ["idempotencyKey", "method", "targetHash", "fingerprint"] as const) {
      if (existing[key] !== expected[key]) throw new SideThreadConflictError(`persistent operation ${key} mismatch`);
    }
    return existing;
  }
  private mustOperation(expected: SideThreadOperation): SideThreadOperation {
    const operation = this.existing(expected);
    if (!operation) throw new SideThreadConflictError("persistent operation disappeared");
    return operation;
  }
  private put(operation: SideThreadOperation): void { this.opts.operationLedger.put(operation); }
  private async reconcileFork(input: { sideThreadId: string; sourceThreadId: string; boundary: ExactBoundary; operation: SideThreadRuntimeOperation },
    prior: SideThreadOperation, cause?: unknown): Promise<{ derivedThreadId: string }> {
    const expected = this.operation(input.operation, input.sideThreadId, "fork", input.sourceThreadId,
      JSON.stringify([input.sourceThreadId, input.boundary.kind, input.boundary.turnId]));
    if (prior.state === "sent") {
      prior = { ...prior, state: "ambiguous", updatedAt: this.now() };
      this.put(prior);
    }
    let candidate: RuntimeThread | undefined;
    try {
      const threads = await this.listThreads();
      if (prior.result?.derivedThreadIdHash) {
        candidate = threads.find((thread) => operationHash(thread.id) === prior.result!.derivedThreadIdHash);
        if (candidate && candidate.forkedFromId !== input.sourceThreadId) {
          candidate = await this.readThread(candidate.id);
          if (candidate.forkedFromId !== input.sourceThreadId) candidate = undefined;
        }
      } else {
        const reconciling = prior.state === "reconciling" ? prior
          : { ...prior, state: "reconciling" as const, updatedAt: this.now() };
        if (reconciling !== prior) this.put(reconciling);
        const snapshot = new Set(prior.result?.snapshotThreadIdHashes ?? []);
        const unseen = threads.filter((thread) => thread.id !== input.sourceThreadId && !snapshot.has(operationHash(thread.id)));
        const inspected = await Promise.all(unseen.map((thread) => thread.forkedFromId ? thread : this.readThread(thread.id)));
        const candidates = inspected.filter((thread) => thread.forkedFromId === input.sourceThreadId);
        if (candidates.length !== 1) {
          this.put({ ...reconciling, state: "ambiguous", result: { ...reconciling.result,
            classification: candidates.length === 0 ? "no-candidate" : "multiple-candidates" }, updatedAt: this.now() });
          throw new SideThreadAmbiguousError(`Codex fork outcome has ${candidates.length} candidates; refusing duplicate thread/fork`);
        }
        candidate = candidates[0];
        prior = reconciling;
      }
      if (!candidate) throw new SideThreadAmbiguousError("accepted Codex fork is not visible; refusing duplicate thread/fork");
      if (candidate.id === input.sourceThreadId) throw new SideThreadConflictError("reconciled fork reused source thread");
      this.registerDerived(candidate.id, input.sideThreadId);
      if (prior.state === "accepted" || prior.state === "ambiguous" || prior.state === "reconciling") {
        if (prior.state === "ambiguous") { prior = { ...prior, state: "reconciling", updatedAt: this.now() }; this.put(prior); }
        this.put({ ...prior, state: "reconciled", result: { ...prior.result,
          derivedThreadIdHash: operationHash(candidate.id), classification: "unique-candidate" }, updatedAt: this.now() });
      }
      this.opts.forkLeaseStore.release(input.operation.nodeId, input.sourceThreadId, input.operation.operationId);
      return { derivedThreadId: candidate.id };
    } catch (error) {
      if (error instanceof SideThreadAmbiguousError || error instanceof SideThreadConflictError) throw error;
      const current = this.mustOperation(expected);
      if (current.state === "reconciling") this.put({ ...current, state: "ambiguous", updatedAt: this.now() });
      throw new SideThreadAmbiguousError(`Codex fork reconciliation failed; refusing duplicate thread/fork${cause ? " after response loss" : ""}`);
    }
  }
  private async reconcileStart(input: { sideThreadId: string; attemptId: string; derivedThreadId: string; prompt: string; operation: SideThreadRuntimeOperation },
    clientUserMessageId: string, prior: SideThreadOperation): Promise<{ turnId: string }> {
    const live = this.byClientId.get(clientUserMessageId);
    let turnId = live?.turnId;
    let matchedTurn: RuntimeTurn | undefined;
    let current = prior;
    if (current.state === "sent") { current = { ...current, state: "ambiguous", updatedAt: this.now() }; this.put(current); }
    if (!turnId) {
      if (current.state === "ambiguous") { current = { ...current, state: "reconciling", updatedAt: this.now() }; this.put(current); }
      try {
        const thread = await this.readThread(input.derivedThreadId);
        const matches = (thread.turns ?? []).filter((turn) => turnHasClientId(turn, clientUserMessageId));
        if (prior.result?.turnIdHash) {
          matchedTurn = matches.find((turn) => operationHash(turn.id) === prior.result!.turnIdHash);
          turnId = matchedTurn?.id;
        } else if (matches.length === 1) { matchedTurn = matches[0]; turnId = matchedTurn.id; }
      } catch { /* the durable ambiguity below is authoritative */ }
    }
    if (!turnId) {
      if (current.state === "reconciling") this.put({ ...current, state: "ambiguous", updatedAt: this.now() });
      throw new SideThreadAmbiguousError("Codex start outcome cannot be uniquely reconciled; refusing duplicate turn/start");
    }
    if (current.state === "ambiguous") { current = { ...current, state: "reconciling", updatedAt: this.now() }; this.put(current); }
    if (current.state === "accepted" || current.state === "reconciling") {
      this.put({ ...current, state: "reconciled", result: { ...current.result, turnIdHash: operationHash(turnId) }, updatedAt: this.now() });
    }
    if (!live) this.restoreExecution(input, clientUserMessageId, turnId, matchedTurn);
    return { turnId };
  }
  private restoreExecution(input: { sideThreadId: string; attemptId: string; derivedThreadId: string },
    clientUserMessageId: string, turnId: string, turn?: RuntimeTurn): void {
    const key = turnKey(input.derivedThreadId, turnId);
    const owned = this.byTurn.get(key);
    if (owned && (owned.sideThreadId !== input.sideThreadId || owned.attemptId !== input.attemptId)) {
      throw new SideThreadConflictError("reconciled Codex turn is already owned by another attempt");
    }
    let resolveIdentity!: (value: string) => void; let rejectIdentity!: (error: Error) => void;
    const identity = new Promise<string>((resolve, reject) => { resolveIdentity = resolve; rejectIdentity = reject; });
    void identity.catch(() => {}); resolveIdentity(turnId);
    const identityTimer = setTimeout(() => {}, 0); clearTimeout(identityTimer);
    const execution: Execution = {
      sideThreadId: input.sideThreadId, attemptId: input.attemptId, threadId: input.derivedThreadId,
      clientUserMessageId, responseTurnId: turnId, turnId, text: turnText(turn),
      resolveIdentity, rejectIdentity, identityTimer, readyForTerminal: true, identityAmbiguous: false,
    };
    this.byClientId.set(clientUserMessageId, execution); this.byTurn.set(key, execution);
    if (turn?.status && turn.status !== "inProgress") {
      setTimeout(() => this.onCompleted({ threadId: input.derivedThreadId, turn: {
        id: turnId, status: turn.status, error: turn.error,
      } }), 0);
    }
  }
  private async listThreads(): Promise<RuntimeThread[]> {
    const all: RuntimeThread[] = []; let cursor: string | undefined;
    do {
      const response = await this.rpc<{ data?: RuntimeThread[]; threads?: RuntimeThread[]; nextCursor?: string | null }>("thread/list",
        { limit: 100, ...(cursor ? { cursor } : {}) });
      const page = response?.data ?? response?.threads;
      if (!Array.isArray(page) || page.some((thread) => !thread?.id)) throw new SideThreadConflictError("Codex returned an invalid thread/list snapshot");
      all.push(...page); cursor = response.nextCursor ?? undefined;
      if (all.length > 10_000) throw new SideThreadConflictError("Codex thread/list snapshot exceeded bound");
    } while (cursor);
    return all;
  }
  private async readThread(threadId: string): Promise<RuntimeThread> {
    const response = await this.rpc<{ thread?: RuntimeThread }>("thread/read", { threadId, includeTurns: true });
    if (!response?.thread?.id || response.thread.id !== threadId) throw new SideThreadConflictError("Codex returned an invalid thread/read result");
    return response.thread;
  }
  private registerDerived(threadId: string, sideThreadId: string): void {
    const owner = this.derivedThreads.get(threadId);
    if (owner && owner !== sideThreadId) throw new SideThreadConflictError("Codex reused a derived thread identity");
    this.derivedThreads.set(threadId, sideThreadId);
  }
  private async durableMutation(sideThreadId: string, method: "interrupt" | "archive" | "delete", identity: SideThreadRuntimeOperation,
    target: string, fingerprint: string, rpcMethod: string, params: unknown): Promise<void> {
    let claim;
    try { claim = await this.opts.forkLeaseStore.claimOperation(identity.nodeId, sideThreadId, identity.operationId); }
    catch (error) {
      if (error instanceof Error && error.message === "runtime operation executor is already claimed") {
        throw new SideThreadAmbiguousError(`Codex ${method} is already executing; refusing duplicate RPC`);
      }
      throw error;
    }
    try { await this.durableMutationClaimed(sideThreadId, method, identity, target, fingerprint, rpcMethod, params); }
    finally { await claim.release(); }
  }
  private async durableMutationClaimed(sideThreadId: string, method: "interrupt" | "archive" | "delete", identity: SideThreadRuntimeOperation,
    target: string, fingerprint: string, rpcMethod: string, params: unknown): Promise<void> {
    const operation = this.operation(identity, sideThreadId, method, target, fingerprint);
    const prior = this.existing(operation);
    if (prior) {
      if (prior.state === "accepted" || prior.state === "reconciled") return;
      if (prior.state !== "prepared") throw new SideThreadAmbiguousError(`Codex ${method} outcome is ambiguous; refusing duplicate RPC`);
    } else this.put(operation);
    const sent = { ...this.mustOperation(operation), state: "sent" as const, updatedAt: this.now() };
    this.put(sent);
    try {
      await this.rpc(rpcMethod, params);
      this.put({ ...sent, state: "accepted", updatedAt: this.now() });
    } catch {
      this.put({ ...sent, state: "ambiguous", updatedAt: this.now() });
      throw new SideThreadAmbiguousError(`Codex ${method} outcome is ambiguous; refusing duplicate RPC`);
    }
  }
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
interface RuntimeTurn { id: string; items?: unknown[]; status?: string; error?: { message?: string } | string; [key: string]: unknown }
interface RuntimeThread { id: string; forkedFromId?: string; turns?: RuntimeTurn[]; [key: string]: unknown }
function turnHasClientId(turn: RuntimeTurn, clientId: string): boolean {
  return (turn.items ?? []).some((item) => {
    const value = item as { clientId?: string; client_id?: string };
    return value?.clientId === clientId || value?.client_id === clientId;
  });
}
function turnText(turn?: RuntimeTurn): string {
  return (turn?.items ?? []).map((item) => {
    const value = item as { type?: string; text?: string };
    return value?.type === "agentMessage" && typeof value.text === "string" ? value.text : "";
  }).join("");
}
