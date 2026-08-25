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

export interface SideThreadRecord {
  id: string;
  requestKey: string;
  nodeId: string;
  sourceThreadId: string;
  derivedThreadId: string;
  boundary: ExactBoundary;
  runtime: string;
  runtimeVersion: string;
  state: SideThreadState;
  activeAttemptId?: string;
  attempts: SideThreadAttempt[];
  createdAt: number;
}

export interface SideThreadAttempt {
  id: string;
  requestKey: string;
  turnId?: string;
  state: "starting" | "running" | "completed" | "failed" | "cancelled";
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
}

export interface SideThreadRuntimeAdapter {
  capability(): SideThreadCapability;
  fork(input: {
    sideThreadId: string;
    sourceThreadId: string;
    boundary: ExactBoundary;
  }): Promise<{ derivedThreadId: string }>;
  start(input: {
    sideThreadId: string;
    attemptId: string;
    derivedThreadId: string;
    prompt: string;
  }): Promise<{ turnId: string }>;
  cancel(input: { derivedThreadId: string; turnId: string }): Promise<void>;
  archive(input: { derivedThreadId: string }): Promise<void>;
  delete(input: { derivedThreadId: string }): Promise<void>;
  subscribe(listener: (event: SideThreadTerminalEvent) => void): () => void;
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
  sourceThreadId?: string;
  derivedThreadId?: string;
  turnId?: string;
  reason?: string;
  at: number;
}

export interface SideThreadServiceOptions {
  adapter: SideThreadRuntimeAdapter;
  audit?: (entry: SideThreadAuditEntry) => void;
  now?: () => number;
  id?: () => string;
}

/**
 * Runtime-neutral lifecycle owner. No Hub/App transport is wired in PR1.
 * Returned records are snapshots so callers cannot mutate registry identity.
 */
export class SideThreadService {
  private readonly records = new Map<string, SideThreadRecord>();
  private readonly createByKey = new Map<string, { fingerprint: string; operation: Promise<SideThreadRecord> }>();
  private readonly attemptByKey = new Map<string, { fingerprint: string; operation: Promise<SideThreadAttempt> }>();
  private readonly unsubscribe: () => void;
  private closed = false;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly opts: SideThreadServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.id = opts.id ?? randomUUID;
    this.unsubscribe = opts.adapter.subscribe((event) => this.onTerminal(event));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
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
    const existing = this.createByKey.get(input.requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new SideThreadConflictError("idempotency key reused with different create input");
      return cloneRecord(await existing.operation);
    }
    const operation = this.createOnce(input);
    this.createByKey.set(input.requestKey, { fingerprint, operation });
    try { return cloneRecord(await operation); }
    catch (error) { this.createByKey.delete(input.requestKey); throw error; }
  }

  private async createOnce(input: {
    requestKey: string; nodeId: string; sourceThreadId: string; boundary: ExactBoundary;
  }): Promise<SideThreadRecord> {
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
    const sideThreadId = this.id();
    const forked = await this.opts.adapter.fork({
      sideThreadId, sourceThreadId: input.sourceThreadId, boundary: input.boundary,
    });
    requireIdentity(forked.derivedThreadId, "derivedThreadId");
    if (forked.derivedThreadId === input.sourceThreadId) {
      throw new SideThreadConflictError("runtime returned the source thread as the derived thread");
    }
    const record: SideThreadRecord = {
      id: sideThreadId, requestKey: input.requestKey, nodeId: input.nodeId,
      sourceThreadId: input.sourceThreadId, derivedThreadId: forked.derivedThreadId,
      boundary: input.boundary, runtime: capability.runtime,
      runtimeVersion: capability.runtimeVersion, state: "ready", attempts: [],
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
    const record = this.mustGet(input.sideThreadId);
    if (record.state === "archived" || record.state === "purged") {
      throw new SideThreadConflictError(`cannot start attempt from ${record.state}`);
    }
    if (record.activeAttemptId) throw new SideThreadConflictError("side thread already has an active attempt");
    const attempt: SideThreadAttempt = {
      id: this.id(), requestKey: input.requestKey, state: "starting", createdAt: this.now(),
    };
    record.attempts.push(attempt);
    record.activeAttemptId = attempt.id;
    record.state = "running";
    try {
      const started = await this.opts.adapter.start({
        sideThreadId: record.id, attemptId: attempt.id,
        derivedThreadId: record.derivedThreadId, prompt: input.prompt,
      });
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
      attempt.state = "failed";
      attempt.error = safeError(error);
      record.activeAttemptId = undefined;
      record.state = "failed";
      throw error;
    }
  }

  async cancel(sideThreadId: string): Promise<void> {
    this.assertOpen();
    const record = this.mustGet(sideThreadId);
    const attempt = record.attempts.find((a) => a.id === record.activeAttemptId);
    if (!attempt?.turnId || attempt.state !== "running") {
      throw new SideThreadConflictError("side thread has no cancellable turn");
    }
    this.audit(record, "cancel_requested", { attemptId: attempt.id, derivedThreadId: record.derivedThreadId, turnId: attempt.turnId });
    await this.opts.adapter.cancel({ derivedThreadId: record.derivedThreadId, turnId: attempt.turnId });
  }

  async archive(sideThreadId: string): Promise<void> {
    this.assertOpen();
    const record = this.mustGet(sideThreadId);
    if (record.activeAttemptId) throw new SideThreadConflictError("cannot archive a running side thread");
    if (record.state === "purged") throw new SideThreadConflictError("cannot archive a purged side thread");
    if (record.state === "archived") return;
    await this.opts.adapter.archive({ derivedThreadId: record.derivedThreadId });
    record.state = "archived";
    this.audit(record, "archived", { derivedThreadId: record.derivedThreadId });
  }

  async purge(sideThreadId: string): Promise<void> {
    this.assertOpen();
    const record = this.mustGet(sideThreadId);
    if (record.activeAttemptId) throw new SideThreadConflictError("cannot purge a running side thread");
    if (record.state === "purged") return;
    await this.opts.adapter.delete({ derivedThreadId: record.derivedThreadId });
    record.state = "purged";
    this.audit(record, "purged", { derivedThreadId: record.derivedThreadId });
  }

  get(sideThreadId: string): SideThreadRecord | undefined {
    const record = this.records.get(sideThreadId);
    return record ? cloneRecord(record) : undefined;
  }

  private onTerminal(event: SideThreadTerminalEvent): void {
    const record = this.records.get(event.sideThreadId);
    const attempt = record?.attempts.find((a) => a.id === event.attemptId);
    const startingIdentity = attempt?.state === "starting" && !attempt.turnId;
    const owned = !!record && !!attempt && record.derivedThreadId === event.threadId
      && (attempt.turnId === event.turnId || startingIdentity)
      && record.activeAttemptId === attempt.id
      && (attempt.state === "running" || startingIdentity);
    if (!owned) {
      this.opts.audit?.({
        action: "event_dropped", sideThreadId: event.sideThreadId,
        attemptId: event.attemptId, runtime: this.opts.adapter.capability().runtime,
        runtimeVersion: this.opts.adapter.capability().runtimeVersion,
        reason: "ownership-mismatch", at: this.now(),
      });
      return;
    }
    if (!attempt!.turnId) attempt!.turnId = event.turnId;
    attempt!.state = event.status === "completed" ? "completed"
      : event.status === "interrupted" ? "cancelled" : "failed";
    attempt!.result = event.status === "completed" ? event.text : undefined;
    attempt!.error = event.status === "failed" ? safeText(event.error) : undefined;
    record!.activeAttemptId = undefined;
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

  private audit(record: SideThreadRecord, action: SideThreadAuditAction, extra: Partial<SideThreadAuditEntry>): void {
    this.opts.audit?.({ action, sideThreadId: record.id, runtime: record.runtime,
      runtimeVersion: record.runtimeVersion, at: this.now(), ...extra });
  }
}

function requireIdentity(value: string, label: string): void {
  if (!value || value.length > 512 || /[\r\n\0]/.test(value)) throw new SideThreadConflictError(`invalid ${label}`);
}
function requireIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(value)) throw new SideThreadConflictError("invalid idempotency key");
}
function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}
function safeError(error: unknown): string { return safeText(error instanceof Error ? error.message : String(error)) ?? "runtime error"; }
function cloneAttempt(value: SideThreadAttempt): SideThreadAttempt { return { ...value }; }
function cloneRecord(value: SideThreadRecord): SideThreadRecord {
  return { ...value, boundary: { ...value.boundary }, attempts: value.attempts.map(cloneAttempt) };
}
import { randomUUID } from "node:crypto";
