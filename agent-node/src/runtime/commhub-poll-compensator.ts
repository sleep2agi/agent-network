import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { authenticatedDashboardRequestId } from "../inbox-dispatch.js";

export const DEFAULT_COMPENSATION_POLL_MS = 15_000;
export const MIN_COMPENSATION_POLL_MS = 2_500;
export const MAX_COMPENSATION_POLL_MS = 5 * 60_000;
export const MAX_CURSOR_KEYS = 2_000;

export type PollTrigger = "startup" | "sse-reconnect" | "idle" | "timer";

export interface InboxObservation {
  id: string;
  type?: string;
  task_id?: string | null;
  meta?: Record<string, unknown> | null;
  meta_json?: string | null;
}

export interface OutboundTaskObservation {
  task_id: string;
  terminal_seq?: number;
  status: string;
  result?: unknown;
  completed_at?: string | null;
}

export interface OutboundPollPage {
  tasks: OutboundTaskObservation[];
  hasMore: boolean;
}

interface CursorState {
  version: 3;
  consumed_task_ids: string[];
  consumed_client_request_ids: string[];
  surfaced_outbound_terminal_ids: string[];
  outbound_deliveries: Array<{ task_id: string; idempotency_key: string; state: "pending" | "delivering" | "delivered"; lease_until?: number }>;
  outbound_terminal_watermark: number;
  inbound_lifecycle: Array<{ task_id: string; state: "delivered" | "submitted" | "consumed" | "completed" }>;
  last_success_at: string | null;
}

export interface CompensationPollAdapters {
  getInbox(): Promise<InboxObservation[]>;
  listOutbound(afterTerminalSeq: number): Promise<OutboundPollPage>;
  scheduleInboxDrain(): void;
  onOutboundTerminal(task: OutboundTaskObservation, idempotencyKey: string): void | Promise<void>;
  log(message: string): void;
  warn(message: string): void;
  now?(): number;
  setTimer?(callback: () => void, delayMs: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface CompensationPoller {
  readonly mode: "probing" | "active" | "realtime-only";
  trigger(trigger: PollTrigger): void;
  recordConsumed(message: InboxObservation): void;
  recordLifecycle(taskId: string, state: "delivered" | "submitted" | "consumed" | "completed"): void;
  wasConsumed(message: InboxObservation): boolean;
  idle(): Promise<void>;
  stop(): void;
}

const TERMINAL = new Set(["replied", "failed", "cancelled", "expired"]);

export function resolveCompensationPollMs(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_COMPENSATION_POLL_MS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return DEFAULT_COMPENSATION_POLL_MS;
  return Math.min(MAX_COMPENSATION_POLL_MS, Math.max(MIN_COMPENSATION_POLL_MS, value));
}

function emptyState(): CursorState {
  return {
    version: 3,
    consumed_task_ids: [],
    consumed_client_request_ids: [],
    surfaced_outbound_terminal_ids: [],
    outbound_deliveries: [],
    outbound_terminal_watermark: 0,
    inbound_lifecycle: [],
    last_success_at: null,
  };
}

function boundedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.length > 0 && item.length <= 512,
  ))].slice(-MAX_CURSOR_KEYS);
}

function sanitizeState(value: unknown): CursorState {
  if (!value || typeof value !== "object") return emptyState();
  const input = value as Partial<CursorState>;
  return {
    version: 3,
    consumed_task_ids: boundedStrings(input.consumed_task_ids),
    consumed_client_request_ids: boundedStrings(input.consumed_client_request_ids),
    surfaced_outbound_terminal_ids: boundedStrings(input.surfaced_outbound_terminal_ids),
    outbound_deliveries: Array.isArray(input.outbound_deliveries)
      ? input.outbound_deliveries.filter((item): item is CursorState["outbound_deliveries"][number] =>
          !!item && typeof item.task_id === "string" && typeof item.idempotency_key === "string"
          && ["pending", "delivering", "delivered"].includes(item.state),
        ).slice(-MAX_CURSOR_KEYS)
      : boundedStrings(input.surfaced_outbound_terminal_ids).map((task_id) => ({
          task_id,
          idempotency_key: `commhub-terminal:${task_id}`,
          state: "delivered" as const,
        })),
    outbound_terminal_watermark: Number.isSafeInteger(input.outbound_terminal_watermark)
      && Number(input.outbound_terminal_watermark) >= 0 ? Number(input.outbound_terminal_watermark) : 0,
    inbound_lifecycle: Array.isArray(input.inbound_lifecycle)
      ? input.inbound_lifecycle.filter((item): item is CursorState["inbound_lifecycle"][number] =>
          !!item && typeof item.task_id === "string"
          && ["delivered", "submitted", "consumed", "completed"].includes(item.state),
        ).slice(-MAX_CURSOR_KEYS)
      : boundedStrings(input.consumed_task_ids).map((task_id) => ({ task_id, state: "consumed" as const })),
    last_success_at: typeof input.last_success_at === "string" ? input.last_success_at : null,
  };
}

function clientRequestId(message: InboxObservation): string | null {
  return authenticatedDashboardRequestId(message);
}

function logicalTaskId(message: InboxObservation): string {
  return typeof message.task_id === "string" && message.task_id ? message.task_id : message.id;
}

function isUnsupportedCapability(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown; appLevel?: unknown } | null;
  const text = String(value?.message ?? error ?? "");
  return value?.code === -32601 || value?.code === -32602
    || /unknown tool|tool .+ not found|method not found|-3260[12]/i.test(text);
}

class CursorStore {
  private state: CursorState;

  constructor(private readonly path: string) {
    this.state = this.read();
  }

  snapshot(): CursorState {
    this.state = this.read();
    return this.state;
  }

  update(mutator: (state: CursorState) => void): void {
    this.withLock(() => {
      const next = this.read();
      mutator(next);
      next.consumed_task_ids = boundedStrings(next.consumed_task_ids);
      next.consumed_client_request_ids = boundedStrings(next.consumed_client_request_ids);
      next.surfaced_outbound_terminal_ids = boundedStrings(next.surfaced_outbound_terminal_ids);
      // Only unresolved callback attempts are retained. Delivered rows are
      // represented by the monotonic watermark and are safe to garbage collect.
      next.outbound_deliveries = next.outbound_deliveries
        .filter((item) => item.state !== "delivered")
        .slice(-MAX_CURSOR_KEYS);
      next.inbound_lifecycle = next.inbound_lifecycle.slice(-MAX_CURSOR_KEYS);
      this.write(next);
      this.state = next;
    });
  }

  claimOutbound(taskId: string, idempotencyKey: string, at: number, leaseMs: number): boolean {
    return this.withLock(() => {
      const next = this.read();
      const row = next.outbound_deliveries.find((item) => item.task_id === taskId);
      if (row?.state === "delivered" || (row?.state === "delivering" && (row.lease_until ?? 0) > at)) return false;
      if (row) { row.state = "delivering"; row.lease_until = at + leaseMs; }
      else next.outbound_deliveries.push({ task_id: taskId, idempotency_key: idempotencyKey, state: "delivering", lease_until: at + leaseMs });
      this.write(next);
      this.state = next;
      return true;
    }, false);
  }

  private withLock<T>(operation: () => T, busyValue?: T): T {
    const lockPath = `${this.path}.lock`;
    let fd: number;
    try { fd = openSync(lockPath, "wx", 0o600); }
    catch { if (arguments.length > 1) return busyValue as T; throw new Error("compensation cursor is locked"); }
    try { return operation(); }
    finally { closeSync(fd); try { unlinkSync(lockPath); } catch {} }
  }

  private read(): CursorState {
    if (!existsSync(this.path)) return emptyState();
    try {
      const parsed = sanitizeState(JSON.parse(readFileSync(this.path, "utf8")));
      chmodSync(this.path, 0o600);
      return parsed;
    } catch {
      return emptyState();
    }
  }

  private write(state: CursorState): void {
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "wx", 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
    } finally {
      if (fd !== null) closeSync(fd);
      try { unlinkSync(tmp); } catch {}
    }
  }
}

export function createCommHubPollCompensator(options: {
  cursorPath: string;
  intervalMs?: number;
  adapters: CompensationPollAdapters;
}): CompensationPoller {
  const intervalMs = resolveCompensationPollMs(options.intervalMs);
  const adapters = options.adapters;
  const store = new CursorStore(options.cursorPath);
  let currentMode: CompensationPoller["mode"] = "probing";
  let running: Promise<void> | null = null;
  let dirty = false;
  let stopped = false;
  let timer: unknown = null;
  let failureCount = 0;
  let warnedRealtimeOnly = false;
  const now = adapters.now ?? Date.now;
  const deliveryLeaseMs = Math.max(30_000, intervalMs * 2);
  const setTimer = adapters.setTimer ?? ((callback, delay) => {
    const handle = setTimeout(callback, delay);
    handle.unref?.();
    return handle;
  });
  const clearTimer = adapters.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  const stateHas = (message: InboxObservation): boolean => {
    const snapshot = store.snapshot();
    const taskId = logicalTaskId(message);
    const requestId = clientRequestId(message);
    return snapshot.consumed_task_ids.includes(taskId)
      || (!!requestId && snapshot.consumed_client_request_ids.includes(requestId));
  };

  const recordConsumed = (message: InboxObservation): void => {
    const taskId = logicalTaskId(message);
    const requestId = clientRequestId(message);
    store.update((state) => {
      state.consumed_task_ids.push(taskId);
      if (requestId) state.consumed_client_request_ids.push(requestId);
      const row = state.inbound_lifecycle.find((item) => item.task_id === taskId);
      if (row) row.state = "completed";
      else state.inbound_lifecycle.push({ task_id: taskId, state: "completed" });
    });
  };

  const lifecycleRank = { delivered: 0, submitted: 1, consumed: 2, completed: 3 } as const;
  const recordLifecycle = (taskId: string, lifecycle: keyof typeof lifecycleRank): void => {
    if (!taskId) return;
    store.update((state) => {
      const row = state.inbound_lifecycle.find((item) => item.task_id === taskId);
      if (!row) state.inbound_lifecycle.push({ task_id: taskId, state: lifecycle });
      else if (lifecycleRank[lifecycle] > lifecycleRank[row.state]) row.state = lifecycle;
      if (lifecycleRank[lifecycle] >= lifecycleRank.consumed) state.consumed_task_ids.push(taskId);
    });
  };

  const arm = (delayMs: number): void => {
    if (stopped || currentMode === "realtime-only") return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      trigger("timer");
    }, delayMs);
  };

  const pollOnce = async (triggerReason: PollTrigger): Promise<void> => {
    try {
      // list_tasks is the capability handshake as well as the durable outbox
      // read. A Hub without it cannot promise the full inbox+outbox contract.
      const startWatermark = store.snapshot().outbound_terminal_watermark;
      const [inbox, outboundPage] = await Promise.all([
        adapters.getInbox(),
        adapters.listOutbound(startWatermark),
      ]);
      const outbound = outboundPage.tasks;
      if (currentMode === "probing") {
        currentMode = "active";
        adapters.log(`[commhub-compensation] active (${intervalMs}ms; SSE remains primary)`);
      }
      if (inbox.some((message) => !stateHas(message))) {
        adapters.scheduleInboxDrain();
      }
      for (const task of outbound) {
        if (!task?.task_id || !TERMINAL.has(task.status)) continue;
        if (!Number.isSafeInteger(task.terminal_seq) || Number(task.terminal_seq) <= 0) {
          throw Object.assign(new Error("Hub terminal sequence missing"), { code: -32602 });
        }
        const terminalSeq = Number(task.terminal_seq);
        const latest = store.snapshot();
        if (terminalSeq <= latest.outbound_terminal_watermark) continue;
        const existing = store.snapshot().outbound_deliveries.find((item) => item.task_id === task.task_id);
        // v2 migration: a legacy delivered marker is authoritative for this
        // task. Bind it to the Hub sequence without invoking the callback.
        if (existing?.state === "delivered") {
          store.update((state) => {
            state.outbound_terminal_watermark = Math.max(state.outbound_terminal_watermark, terminalSeq);
          });
          continue;
        }
        const idempotencyKey = existing?.idempotency_key ?? `commhub-terminal:${task.task_id}`;
        // Preserve a contiguous watermark across processes. If the head event
        // is leased elsewhere, later events must wait rather than leapfrog it.
        if (!store.claimOutbound(task.task_id, idempotencyKey, now(), deliveryLeaseMs)) break;
        try {
          await adapters.onOutboundTerminal(task, idempotencyKey);
        } catch (error) {
          store.update((state) => {
            const row = state.outbound_deliveries.find((item) => item.task_id === task.task_id);
            if (row) { row.state = "pending"; row.lease_until = 0; }
          });
          throw error;
        }
        store.update((state) => {
          const row = state.outbound_deliveries.find((item) => item.task_id === task.task_id);
          if (row) { row.state = "delivered"; row.lease_until = 0; }
          state.outbound_terminal_watermark = Math.max(state.outbound_terminal_watermark, terminalSeq);
        });
      }
      store.update((state) => { state.last_success_at = new Date(now()).toISOString(); });
      if (outboundPage.hasMore) dirty = true;
      failureCount = 0;
      adapters.log(`[commhub-compensation] ${triggerReason} poll ok; inbox=${inbox.length} outbound=${outbound.length}`);
      arm(intervalMs);
    } catch (error) {
      if (isUnsupportedCapability(error)) {
        currentMode = "realtime-only";
        if (!warnedRealtimeOnly) {
          warnedRealtimeOnly = true;
          adapters.warn("[commhub-compensation] Hub lacks durable inbox/outbox polling capability; realtime-only mode (SSE/turn-steer only)");
        }
        return;
      }
      failureCount++;
      const delay = Math.min(MAX_COMPENSATION_POLL_MS, intervalMs * (2 ** Math.min(failureCount, 5)));
      adapters.warn(`[commhub-compensation] poll failed; retry in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
      arm(delay);
    }
  };

  const trigger = (reason: PollTrigger): void => {
    if (stopped || currentMode === "realtime-only") return;
    if (running) {
      dirty = true;
      return;
    }
    running = (async () => {
      let nextReason = reason;
      do {
        dirty = false;
        await pollOnce(nextReason);
        nextReason = "idle";
      } while (dirty && !stopped && currentMode !== "realtime-only");
    })().finally(() => { running = null; });
  };

  return {
    get mode() { return currentMode; },
    trigger,
    recordConsumed,
    recordLifecycle,
    wasConsumed: stateHas,
    async idle() { await running; },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
