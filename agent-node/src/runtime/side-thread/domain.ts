import { createHash, randomUUID } from "node:crypto";
import { stableOperationId, type OperationMethod } from "./operation-ledger";

export type SideThreadState =
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived"
  | "purged";

export type ExactBoundary =
  | { kind: "through"; turnId: string }
  | { kind: "before"; turnId: string };

export interface SideThreadCapability {
  supported: boolean;
  runtime: string;
  runtimeVersion: string;
  topology: string;
  evidenceRevision: string;
  mode?: "native-exact-fork";
  exactBoundary?: { through: boolean; before: boolean };
  reason?: SideThreadUnsupportedReason;
}

export type SideThreadUnsupportedReason =
  | "runtime"
  | "version"
  | "topology"
  | "experimental-api"
  | "exact-boundary";

export class SideThreadUnsupportedError extends Error {
  readonly code = "SIDE_THREAD_UNSUPPORTED";
  constructor(readonly reason: SideThreadUnsupportedReason, message: string) {
    super(message);
    this.name = "SideThreadUnsupportedError";
  }
}

export class SideThreadConflictError extends Error {
  readonly code = "SIDE_THREAD_CONFLICT";
  constructor(message: string) { super(message); this.name = "SideThreadConflictError"; }
}
export class SideThreadAmbiguousError extends Error {
  readonly code = "SIDE_THREAD_AMBIGUOUS";
  constructor(message: string) { super(message); this.name = "SideThreadAmbiguousError"; }
}

export interface SideThreadRecord {
  id: string;
  requestKey: string;
  nodeId: string;
  sourceThreadId: string;
  derivedThreadId: string;
  boundary: ExactBoundary;
  runtime: string;
  runtimeVersion: string;
  topology: string;
  evidenceRevision: string;
  state: SideThreadState;
  activeAttemptId?: string;
  attempts: SideThreadAttempt[];
  createdAt: number;
}

export interface SideThreadAttempt {
  id: string;
  requestKey: string;
  turnId?: string;
  state: "starting" | "running" | "ambiguous" | "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  createdAt: number;
}

export interface SideThreadTerminalEvent {
  sideThreadId: string;
  attemptId: string;
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  text?: string;
  error?: string;
  /** Adapter proved this turn by the echoed per-attempt client identity. */
  identityBound?: boolean;
}

export interface SideThreadRuntimeOperation {
  nodeId: string;
  operationId: string;
  idempotencyKey: string;
}

export interface SideThreadRuntimeAdapter {
  capability(): SideThreadCapability;
  fork(input: {
    sideThreadId: string;
    sourceThreadId: string;
    boundary: ExactBoundary;
    operation: SideThreadRuntimeOperation;
  }): Promise<{ derivedThreadId: string }>;
  start(input: {
    sideThreadId: string;
    attemptId: string;
    derivedThreadId: string;
    prompt: string;
    operation: SideThreadRuntimeOperation;
  }): Promise<{ turnId: string }>;
  cancel(input: { sideThreadId: string; derivedThreadId: string; turnId: string; operation: SideThreadRuntimeOperation }): Promise<void>;
  archive(input: { sideThreadId: string; derivedThreadId: string; operation: SideThreadRuntimeOperation }): Promise<void>;
  delete(input: { sideThreadId: string; derivedThreadId: string; operation: SideThreadRuntimeOperation }): Promise<void>;
  subscribe(listener: (event: SideThreadTerminalEvent) => void): () => void;
  subscribeDropped?(listener: (reason: string) => void): () => void;
  close?(): void;
  discardFork?(input: { sideThreadId: string; derivedThreadId: string; operation: SideThreadRuntimeOperation }): Promise<void>;
}

export type SideThreadAuditAction =
  | "created"
  | "attempt_started"
  | "attempt_terminal"
  | "cancel_requested"
  | "archived"
  | "purged"
  | "event_dropped";

export interface SideThreadAuditEntry {
  action: SideThreadAuditAction;
  sideThreadId: string;
  attemptId?: string;
  runtime: string;
  runtimeVersion: string;
  topology: string;
  evidenceRevision: string;
  sourceThreadId?: string;
  derivedThreadId?: string;
  turnId?: string;
  reason?: string;
  at: number;
}

export interface SideThreadServiceOptions {
  adapter: SideThreadRuntimeAdapter;
  audit?: (entry: SideThreadAuditEntry) => void | Promise<void>;
  now?: () => number;
  id?: () => string;
}

/**
 * Runtime-neutral lifecycle owner. No Hub/App transport is wired in PR1.
 * Returned records are snapshots so callers cannot mutate registry identity.
 */
export class SideThreadService {
  private readonly records = new Map<string, SideThreadRecord>();
  private readonly createByKey = new Map<string, { fingerprint: string; sideThreadId: string; operation: Promise<SideThreadRecord> }>();
  private readonly createIdentityByKey = new Map<string, { fingerprint: string; sideThreadId: string }>();
  private readonly attemptByKey = new Map<string, { fingerprint: string; operation: Promise<SideThreadAttempt> }>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeDropped: () => void;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly cancelRequested = new Set<string>();
  private closed = false;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly opts: SideThreadServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.id = opts.id ?? randomUUID;
    this.unsubscribe = opts.adapter.subscribe((event) => this.onTerminal(event));
    this.unsubscribeDropped = opts.adapter.subscribeDropped?.((reason) => this.auditDropped(reason)) ?? (() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeDropped();
    this.opts.adapter.close?.();
    await Promise.allSettled([...this.pending]);
  }

  capability(): SideThreadCapability { return this.opts.adapter.capability(); }

  async create(input: {
    requestKey: string;
    nodeId: string;
    sourceThreadId: string;
    boundary: ExactBoundary;
  }): Promise<SideThreadRecord> {
    this.assertOpen();
    requireIdempotencyKey(input.requestKey);
    requireIdentity(input.nodeId, "nodeId");
    requireIdentity(input.sourceThreadId, "sourceThreadId");
    requireIdentity(input.boundary.turnId, "boundary.turnId");
    const fingerprint = JSON.stringify([input.nodeId, input.sourceThreadId, input.boundary.kind, input.boundary.turnId]);
    const identity = this.createIdentityByKey.get(input.requestKey);
    if (identity && identity.fingerprint !== fingerprint) throw new SideThreadConflictError("idempotency key reused with different create input");
    const existing = this.createByKey.get(input.requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new SideThreadConflictError("idempotency key reused with different create input");
      return cloneRecord(await existing.operation);
    }
    const sideThreadId = identity?.sideThreadId ?? this.id();
    this.createIdentityByKey.set(input.requestKey, { fingerprint, sideThreadId });
    const operation = this.createOnce(input, sideThreadId);
    this.createByKey.set(input.requestKey, { fingerprint, sideThreadId, operation });
    try { return cloneRecord(await operation); }
    catch (error) {
      this.createByKey.delete(input.requestKey);
      if (!(error instanceof SideThreadAmbiguousError)) this.createIdentityByKey.delete(input.requestKey);
      throw error;
    }
  }

  private async createOnce(input: {
    requestKey: string; nodeId: string; sourceThreadId: string; boundary: ExactBoundary;
  }, sideThreadId: string): Promise<SideThreadRecord> {
    const capability = this.opts.adapter.capability();
    if (!capability.supported || capability.mode !== "native-exact-fork") {
      throw new SideThreadUnsupportedError(
        capability.reason ?? "exact-boundary",
        `side thread unsupported: ${capability.reason ?? "native exact-boundary fork unavailable"}`,
      );
    }
    if (!capability.exactBoundary?.[input.boundary.kind]) {
      throw new SideThreadUnsupportedError(
        input.boundary.kind === "before" ? "experimental-api" : "exact-boundary",
        `side thread boundary '${input.boundary.kind}' is unsupported`,
      );
    }
    const forked = await this.opts.adapter.fork({
      sideThreadId, sourceThreadId: input.sourceThreadId, boundary: input.boundary,
      operation: runtimeOperation(input.nodeId, sideThreadId, "fork", input.requestKey),
    });
    requireIdentity(forked.derivedThreadId, "derivedThreadId");
    this.assertOpen();
    try { this.assertCapability(capability, input.boundary.kind); }
    catch (error) {
      await this.opts.adapter.discardFork?.({
        sideThreadId, derivedThreadId: forked.derivedThreadId,
        operation: runtimeOperation(input.nodeId, sideThreadId, "delete", `discard-${input.requestKey}`),
      }).catch(() => {});
      throw error;
    }
    if (forked.derivedThreadId === input.sourceThreadId) {
      throw new SideThreadConflictError("runtime returned the source thread as the derived thread");
    }
    if ([...this.records.values()].some((record) => record.derivedThreadId === forked.derivedThreadId)) {
      throw new SideThreadConflictError("runtime returned a derived thread already owned by another side thread");
    }
    const record: SideThreadRecord = {
      id: sideThreadId, requestKey: input.requestKey, nodeId: input.nodeId,
      sourceThreadId: input.sourceThreadId, derivedThreadId: forked.derivedThreadId,
      boundary: input.boundary, runtime: capability.runtime,
      runtimeVersion: capability.runtimeVersion, topology: capability.topology,
      evidenceRevision: capability.evidenceRevision,
      state: "ready", attempts: [],
      createdAt: this.now(),
    };
    this.records.set(record.id, record);
    this.audit(record, "created", { sourceThreadId: record.sourceThreadId, derivedThreadId: record.derivedThreadId });
    return record;
  }

  async startAttempt(input: {
    sideThreadId: string; requestKey: string; prompt: string;
  }): Promise<SideThreadAttempt> {
    this.assertOpen();
    requireIdempotencyKey(input.requestKey);
    if (!input.prompt.trim()) throw new SideThreadConflictError("prompt must not be empty");
    const key = `${input.sideThreadId}\0${input.requestKey}`;
    const fingerprint = JSON.stringify([input.sideThreadId, input.prompt]);
    const existing = this.attemptByKey.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new SideThreadConflictError("idempotency key reused with different attempt input");
      return cloneAttempt(await existing.operation);
    }
    const operation = this.startOnce(input);
    this.attemptByKey.set(key, { fingerprint, operation });
    try { return cloneAttempt(await operation); }
    catch (error) { this.attemptByKey.delete(key); throw error; }
  }

  private async startOnce(input: { sideThreadId: string; requestKey: string; prompt: string }): Promise<SideThreadAttempt> {
    return this.withLock(input.sideThreadId, async () => {
    const record = this.mustGet(input.sideThreadId);
    this.assertAttestation(record);
    if (record.state === "archived" || record.state === "purged") {
      throw new SideThreadConflictError(`cannot start attempt from ${record.state}`);
    }
    const active = record.attempts.find((candidate) => candidate.id === record.activeAttemptId);
    if (active && (active.requestKey !== input.requestKey || active.state !== "ambiguous")) {
      throw new SideThreadConflictError("side thread already has an active attempt");
    }
    const attempt: SideThreadAttempt = active ?? {
      id: this.id(), requestKey: input.requestKey, state: "starting", createdAt: this.now(),
    };
    if (!active) { record.attempts.push(attempt); record.activeAttemptId = attempt.id; }
    else { attempt.state = "starting"; attempt.error = undefined; }
    record.state = "running";
    try {
      const started = await this.opts.adapter.start({
        sideThreadId: record.id, attemptId: attempt.id,
        derivedThreadId: record.derivedThreadId, prompt: input.prompt,
        operation: runtimeOperation(record.nodeId, record.id, "start", input.requestKey),
      });
      this.assertOpen();
      this.assertAttestation(record);
      requireIdentity(started.turnId, "turnId");
      if (attempt.turnId && attempt.turnId !== started.turnId) {
        throw new SideThreadConflictError("runtime attempt identity changed during start");
      }
      attempt.turnId = started.turnId;
      if (attempt.state !== "starting") return attempt;
      attempt.state = "running";
      this.audit(record, "attempt_started", { attemptId: attempt.id, derivedThreadId: record.derivedThreadId, turnId: attempt.turnId });
      return attempt;
    } catch (error) {
      if (error instanceof SideThreadAmbiguousError) {
        attempt.state = "ambiguous";
        attempt.error = safeError(error);
        record.state = "running";
        throw error;
      }
      if (attempt.state === "starting" || attempt.state === "running") {
        attempt.state = "failed";
        attempt.error = safeError(error);
        record.activeAttemptId = undefined;
        record.state = "failed";
      }
      throw error;
    }
    });
  }

  async cancel(sideThreadId: string): Promise<void> {
    this.assertOpen();
    return this.withLock(sideThreadId, async () => {
    const record = this.mustGet(sideThreadId);
    this.assertAttestation(record);
    const attempt = record.attempts.find((a) => a.id === record.activeAttemptId);
    if (!attempt?.turnId || attempt.state !== "running") {
      throw new SideThreadConflictError("side thread has no cancellable turn");
    }
    if (this.cancelRequested.has(attempt.id)) return;
    this.cancelRequested.add(attempt.id);
    this.audit(record, "cancel_requested", { attemptId: attempt.id, derivedThreadId: record.derivedThreadId, turnId: attempt.turnId });
    const idempotencyKey = `cancel-${attempt.id}`;
    try { await this.opts.adapter.cancel({ sideThreadId: record.id, derivedThreadId: record.derivedThreadId, turnId: attempt.turnId,
      operation: runtimeOperation(record.nodeId, record.id, "interrupt", idempotencyKey) }); }
    catch (error) { this.cancelRequested.delete(attempt.id); throw error; }
    this.assertOpen();
    });
  }

  async archive(sideThreadId: string): Promise<void> {
    this.assertOpen();
    return this.withLock(sideThreadId, async () => {
    const record = this.mustGet(sideThreadId);
    this.assertAttestation(record);
    if (record.activeAttemptId) throw new SideThreadConflictError("cannot archive a running side thread");
    if (record.state === "purged") throw new SideThreadConflictError("cannot archive a purged side thread");
    if (record.state === "archived") return;
    await this.opts.adapter.archive({ sideThreadId: record.id, derivedThreadId: record.derivedThreadId,
      operation: runtimeOperation(record.nodeId, record.id, "archive", `archive-${record.id}`) });
    this.assertOpen();
    if (record.state === "purged") throw new SideThreadConflictError("purge won archive race");
    record.state = "archived";
    this.audit(record, "archived", { derivedThreadId: record.derivedThreadId });
    });
  }

  async purge(sideThreadId: string): Promise<void> {
    this.assertOpen();
    return this.withLock(sideThreadId, async () => {
    const record = this.mustGet(sideThreadId);
    this.assertAttestation(record);
    if (record.activeAttemptId) throw new SideThreadConflictError("cannot purge a running side thread");
    if (record.state === "purged") return;
    await this.opts.adapter.delete({ sideThreadId: record.id, derivedThreadId: record.derivedThreadId,
      operation: runtimeOperation(record.nodeId, record.id, "delete", `purge-${record.id}`) });
    this.assertOpen();
    record.state = "purged";
    this.audit(record, "purged", { derivedThreadId: record.derivedThreadId });
    });
  }

  get(sideThreadId: string): SideThreadRecord | undefined {
    const record = this.records.get(sideThreadId);
    return record ? cloneRecord(record) : undefined;
  }

  private onTerminal(event: SideThreadTerminalEvent): void {
    const record = this.records.get(event.sideThreadId);
    const attempt = record?.attempts.find((a) => a.id === event.attemptId);
    const reconciling = attempt?.state === "ambiguous" && !attempt.turnId && event.identityBound === true;
    const owned = !!record && !!attempt && record.derivedThreadId === event.threadId
      && (attempt.turnId === event.turnId || reconciling)
      && record.activeAttemptId === attempt.id
      && (attempt.state === "running" || reconciling);
    if (!owned) {
      this.emitAudit(redactAudit({
        action: "event_dropped", sideThreadId: event.sideThreadId,
        attemptId: event.attemptId, runtime: this.opts.adapter.capability().runtime,
        runtimeVersion: this.opts.adapter.capability().runtimeVersion,
        topology: this.opts.adapter.capability().topology,
        evidenceRevision: this.opts.adapter.capability().evidenceRevision,
        reason: "ownership-mismatch", at: this.now(),
      }) as SideThreadAuditEntry);
      return;
    }
    if (!attempt!.turnId) attempt!.turnId = event.turnId;
    if (!attempt!.turnId) attempt!.turnId = event.turnId;
    attempt!.state = event.status === "completed" ? "completed"
      : event.status === "interrupted" ? "cancelled" : "failed";
    attempt!.result = event.status === "completed" ? event.text : undefined;
    attempt!.error = event.status === "failed" ? safeText(event.error) : undefined;
    record!.activeAttemptId = undefined;
    this.cancelRequested.delete(attempt!.id);
    record!.state = attempt!.state === "cancelled" ? "cancelled" : attempt!.state;
    this.audit(record!, "attempt_terminal", {
      attemptId: attempt!.id, derivedThreadId: record!.derivedThreadId,
      turnId: attempt!.turnId, reason: event.status,
    });
  }

  private mustGet(id: string): SideThreadRecord {
    const record = this.records.get(id);
    if (!record) throw new SideThreadConflictError("unknown side thread");
    return record;
  }

  private assertOpen(): void {
    if (this.closed) throw new SideThreadConflictError("side thread service is closed");
  }

  private assertAttestation(record: SideThreadRecord): void {
    const cap = this.opts.adapter.capability();
    if (!cap.supported || cap.mode !== "native-exact-fork" || cap.runtime !== record.runtime
      || cap.runtimeVersion !== record.runtimeVersion || cap.topology !== record.topology
      || cap.evidenceRevision !== record.evidenceRevision || !cap.exactBoundary?.[record.boundary.kind]) {
      throw new SideThreadUnsupportedError(cap.reason ?? "exact-boundary", "immutable capability attestation no longer matches");
    }
  }
  private assertCapability(expected: SideThreadCapability, boundary: ExactBoundary["kind"]): void {
    const fresh = this.opts.adapter.capability();
    if (!fresh.supported || fresh.mode !== "native-exact-fork" || !fresh.exactBoundary?.[boundary]
      || fresh.runtime !== expected.runtime || fresh.runtimeVersion !== expected.runtimeVersion
      || fresh.topology !== expected.topology || fresh.evidenceRevision !== expected.evidenceRevision) {
      throw new SideThreadUnsupportedError(fresh.reason ?? "exact-boundary", "capability changed while creating side thread");
    }
  }

  private withLock<T>(sideThreadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sideThreadId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => next);
    this.locks.set(sideThreadId, tail);
    const running = previous.then(() => { this.assertOpen(); return operation(); })
      .finally(() => { release(); if (this.locks.get(sideThreadId) === tail) this.locks.delete(sideThreadId); });
    this.pending.add(running);
    void running.then(() => this.pending.delete(running), () => this.pending.delete(running));
    return running;
  }

  private auditDropped(reason: string): void {
    this.emitAudit({ action: "event_dropped", sideThreadId: "unowned", runtime: this.opts.adapter.capability().runtime,
      runtimeVersion: this.opts.adapter.capability().runtimeVersion, topology: this.opts.adapter.capability().topology,
      evidenceRevision: this.opts.adapter.capability().evidenceRevision, reason: safeDroppedReason(reason), at: this.now() });
  }

  private audit(record: SideThreadRecord, action: SideThreadAuditAction, extra: Partial<SideThreadAuditEntry>): void {
    this.emitAudit({ action, sideThreadId: record.id, runtime: record.runtime,
      runtimeVersion: record.runtimeVersion, topology: record.topology,
      evidenceRevision: record.evidenceRevision, at: this.now(), ...redactAudit(extra) });
  }
  private emitAudit(entry: SideThreadAuditEntry): void {
    try { void Promise.resolve(this.opts.audit?.(entry)).catch(() => {}); } catch { /* audit is non-throwing */ }
  }
}

function requireIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new SideThreadConflictError(`invalid ${label}`);
}
function requireIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(value)) throw new SideThreadConflictError("invalid idempotency key");
}
function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}
function safeError(error: unknown): string { return safeText(error instanceof Error ? error.message : String(error)) ?? "runtime error"; }
function safeDroppedReason(reason: string): string {
  return new Set([
    "identity-ownership-mismatch", "identity-turn-mismatch", "unowned-agent-message",
    "unowned-delta", "terminal-buffer-full", "unowned-terminal",
  ]).has(reason) ? reason : "runtime-event-rejected";
}
function cloneAttempt(value: SideThreadAttempt): SideThreadAttempt { return { ...value }; }
function cloneRecord(value: SideThreadRecord): SideThreadRecord {
  return { ...value, boundary: { ...value.boundary }, attempts: value.attempts.map(cloneAttempt) };
}
function auditHash(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`; }
function redactAudit(extra: Partial<SideThreadAuditEntry>): Partial<SideThreadAuditEntry> {
  const copy = { ...extra };
  for (const key of ["sourceThreadId", "derivedThreadId", "turnId"] as const) {
    if (copy[key]) copy[key] = auditHash(copy[key]!);
  }
  return copy;
}
function runtimeOperation(nodeId: string, sideThreadId: string, method: OperationMethod, idempotencyKey: string): SideThreadRuntimeOperation {
  return { nodeId, operationId: stableOperationId(sideThreadId, method, idempotencyKey), idempotencyKey };
}
