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

export const DEFAULT_COMPENSATION_POLL_MS = 15_000;
export const MIN_COMPENSATION_POLL_MS = 2_500;
export const MAX_COMPENSATION_POLL_MS = 5 * 60_000;
export const MAX_CURSOR_KEYS = 2_000;

export type PollTrigger = "startup" | "sse-reconnect" | "idle" | "timer";

export interface InboxObservation {
  id: string;
  task_id?: string | null;
  meta?: { client_request_id?: string } | null;
  meta_json?: string | null;
}

export interface OutboundTaskObservation {
  task_id: string;
  status: string;
  result?: unknown;
  completed_at?: string | null;
}

interface CursorState {
  version: 1;
  consumed_task_ids: string[];
  consumed_client_request_ids: string[];
  surfaced_outbound_terminal_ids: string[];
  last_success_at: string | null;
}

export interface CompensationPollAdapters {
  getInbox(): Promise<InboxObservation[]>;
  listOutbound(): Promise<OutboundTaskObservation[]>;
  scheduleInboxDrain(): void;
  onOutboundTerminal(task: OutboundTaskObservation): void | Promise<void>;
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
    version: 1,
    consumed_task_ids: [],
    consumed_client_request_ids: [],
    surfaced_outbound_terminal_ids: [],
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
    version: 1,
    consumed_task_ids: boundedStrings(input.consumed_task_ids),
    consumed_client_request_ids: boundedStrings(input.consumed_client_request_ids),
    surfaced_outbound_terminal_ids: boundedStrings(input.surfaced_outbound_terminal_ids),
    last_success_at: typeof input.last_success_at === "string" ? input.last_success_at : null,
  };
}

function clientRequestId(message: InboxObservation): string | null {
  if (typeof message.meta?.client_request_id === "string") return message.meta.client_request_id;
  if (typeof message.meta_json !== "string") return null;
  try {
    const parsed = JSON.parse(message.meta_json);
    return typeof parsed?.client_request_id === "string" ? parsed.client_request_id : null;
  } catch {
    return null;
  }
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
    return this.state;
  }

  update(mutator: (state: CursorState) => void): void {
    const next = sanitizeState(this.state);
    mutator(next);
    next.consumed_task_ids = boundedStrings(next.consumed_task_ids);
    next.consumed_client_request_ids = boundedStrings(next.consumed_client_request_ids);
    next.surfaced_outbound_terminal_ids = boundedStrings(next.surfaced_outbound_terminal_ids);
    this.write(next);
    this.state = next;
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
      const [inbox, outbound] = await Promise.all([
        adapters.getInbox(),
        adapters.listOutbound(),
      ]);
      if (currentMode === "probing") {
        currentMode = "active";
        adapters.log(`[commhub-compensation] active (${intervalMs}ms; SSE remains primary)`);
      }
      if (inbox.some((message) => !stateHas(message))) {
        adapters.scheduleInboxDrain();
      }
      const surfaced = new Set(store.snapshot().surfaced_outbound_terminal_ids);
      for (const task of outbound) {
        if (!task?.task_id || !TERMINAL.has(task.status) || surfaced.has(task.task_id)) continue;
        // Persist before the observable notification. If the process dies
        // after this point, restart will not repeatedly surface the terminal.
        store.update((state) => state.surfaced_outbound_terminal_ids.push(task.task_id));
        surfaced.add(task.task_id);
        await adapters.onOutboundTerminal(task);
      }
      store.update((state) => { state.last_success_at = new Date(now()).toISOString(); });
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
    wasConsumed: stateHas,
    async idle() { await running; },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
