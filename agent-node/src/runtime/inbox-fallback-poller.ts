export const DEFAULT_INBOX_FALLBACK_POLL_MS = 45_000;
export const MIN_INBOX_FALLBACK_POLL_MS = 5_000;
export const MAX_INBOX_FALLBACK_POLL_MS = 5 * 60_000;
export const DEFAULT_EMPTY_SUMMARY_EVERY = 20;

export type FallbackPollTrigger = "startup" | "sse-reconnect" | "idle" | "timer";

export interface FallbackInboxMessage {
  id: string;
  type?: string;
  from_session?: string;
  task_id?: string | null;
  meta?: Record<string, unknown> | null;
  meta_json?: string | null;
}

export interface ActionableInboxSummary {
  work: number;
  informational: number;
  skippedInflight: number;
  skippedSelfReply: number;
}

export interface InboxFallbackPollAdapters {
  getInbox(): Promise<FallbackInboxMessage[]>;
  scheduleWorkDrain(): void;
  scheduleInformationalDrain?(): void;
  isSuspended?(): boolean;
  isInflight(id: string): boolean;
  selfAlias?(): string;
  splitOpencodeInformational?: boolean;
  isSteer?(msg: FallbackInboxMessage): boolean;
  log(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  random?(): number;
  setTimer?(callback: () => void, delayMs: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface InboxFallbackPoller {
  start(): void;
  trigger(reason: FallbackPollTrigger): void;
  noteConnected(): void;
  idle(): Promise<void>;
  stop(): void;
}

export function resolveInboxFallbackPollMs(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_INBOX_FALLBACK_POLL_MS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return DEFAULT_INBOX_FALLBACK_POLL_MS;
  return Math.min(MAX_INBOX_FALLBACK_POLL_MS, Math.max(MIN_INBOX_FALLBACK_POLL_MS, value));
}

export function classifyFallbackInboxMessages(
  messages: readonly FallbackInboxMessage[],
  options: {
    isInflight: (id: string) => boolean;
    selfAlias?: string;
    splitOpencodeInformational?: boolean;
    isSteer?: (msg: FallbackInboxMessage) => boolean;
  },
): ActionableInboxSummary {
  let work = 0;
  let informational = 0;
  let skippedInflight = 0;
  let skippedSelfReply = 0;

  for (const msg of messages) {
    if (!msg || typeof msg.id !== "string" || !msg.id) continue;
    if (options.isInflight(msg.id)) {
      skippedInflight++;
      continue;
    }
    const type = msg.type || "task";
    if (type === "reply" && options.selfAlias && msg.from_session === options.selfAlias) {
      skippedSelfReply++;
      continue;
    }
    if (type === "message" && options.splitOpencodeInformational && !options.isSteer?.(msg)) {
      informational++;
      continue;
    }
    work++;
  }

  return { work, informational, skippedInflight, skippedSelfReply };
}

/**
 * Low-frequency fallback inbox poller for runtimes that do not run
 * `commhub-poll-compensator` (every runtime except `codex-app-server`).
 *
 * SSE remains the low-latency primary wake path. This poller catches dropped
 * SSE frames or silent half-open streams without overlapping
 * `codex-app-server`'s existing compensation loop or re-entering inflight rows.
 */
export function createInboxFallbackPoller(options: {
  intervalMs?: number;
  jitterMs?: number;
  emptySummaryEvery?: number;
  adapters: InboxFallbackPollAdapters;
}): InboxFallbackPoller {
  const intervalMs = typeof options.intervalMs === "number" && Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : DEFAULT_INBOX_FALLBACK_POLL_MS;
  const jitterMs = typeof options.jitterMs === "number" && Number.isFinite(options.jitterMs) && options.jitterMs >= 0
    ? options.jitterMs
    : Math.min(10_000, Math.round(intervalMs * 0.2));
  const emptySummaryEvery = typeof options.emptySummaryEvery === "number" && Number.isInteger(options.emptySummaryEvery) && options.emptySummaryEvery >= 0
    ? options.emptySummaryEvery
    : DEFAULT_EMPTY_SUMMARY_EVERY;
  const adapters = options.adapters;
  const random = adapters.random ?? Math.random;
  const setTimer = adapters.setTimer ?? ((callback, delay) => {
    const handle = setTimeout(callback, delay);
    handle.unref?.();
    return handle;
  });
  const clearTimer = adapters.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  let started = false;
  let stopped = false;
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let dirty = false;
  let failureCount = 0;
  let consecutiveEmptyPolls = 0;

  const withJitter = (baseMs: number): number => {
    if (jitterMs <= 0) return baseMs;
    const sample = Math.min(0.999999, Math.max(0, random()));
    return baseMs + Math.floor(sample * jitterMs);
  };

  const arm = (delayMs: number): void => {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      trigger("timer");
    }, withJitter(delayMs));
  };

  const pollOnce = async (reason: FallbackPollTrigger): Promise<void> => {
    if (stopped) return;
    if (adapters.isSuspended?.()) {
      adapters.debug(`[inbox-fallback] ${reason} poll skipped: inbox suspended (#507)`);
      arm(intervalMs);
      return;
    }
    try {
      const messages = await adapters.getInbox();
      if (stopped) return;
      failureCount = 0;
      const summary = classifyFallbackInboxMessages(messages, {
        isInflight: adapters.isInflight,
        selfAlias: adapters.selfAlias?.(),
        splitOpencodeInformational: adapters.splitOpencodeInformational,
        isSteer: adapters.isSteer,
      });

      if (summary.work > 0) {
        consecutiveEmptyPolls = 0;
        adapters.log(
          `[inbox-fallback] ${reason} poll found ${summary.work} pending task(s) `
          + `(total=${messages.length}, inflight=${summary.skippedInflight}); scheduling work drain`,
        );
        adapters.scheduleWorkDrain();
      }
      if (summary.informational > 0) {
        consecutiveEmptyPolls = 0;
        adapters.log(
          `[inbox-fallback] ${reason} poll found ${summary.informational} informational message(s); `
          + `scheduling informational drain`,
        );
        adapters.scheduleInformationalDrain?.();
      }
      if (summary.work === 0 && summary.informational === 0) {
        consecutiveEmptyPolls++;
        adapters.debug(
          `[inbox-fallback] ${reason} poll ok; inbox=${messages.length} actionable=0 inflight=${summary.skippedInflight}`,
        );
        if (emptySummaryEvery > 0 && consecutiveEmptyPolls % emptySummaryEvery === 0) {
          adapters.log(
            `[inbox-fallback] heartbeat: ${consecutiveEmptyPolls} consecutive empty poll(s) `
            + `(last inbox=${messages.length}, inflight=${summary.skippedInflight})`,
          );
        }
      }
      arm(intervalMs);
    } catch (error) {
      if (stopped) return;
      failureCount++;
      const delay = Math.min(MAX_INBOX_FALLBACK_POLL_MS, intervalMs * (2 ** Math.min(failureCount, 5)));
      adapters.warn(
        `[inbox-fallback] ${reason} poll failed; retry in ${delay}ms: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      arm(delay);
    }
  };

  const trigger = (reason: FallbackPollTrigger): void => {
    if (stopped) return;
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
      } while (dirty && !stopped);
    })().finally(() => {
      running = null;
    });
  };

  return {
    start() {
      if (stopped || started) return;
      started = true;
      adapters.log(`[inbox-fallback] active (${intervalMs}ms; SSE remains primary)`);
      // Startup already schedules an immediate inbox drain; arm the timer for
      // the next fallback interval instead of double-fetching at t=0.
      arm(intervalMs);
    },
    trigger,
    noteConnected() {
      if (stopped || !started) return;
      // SSE reconnect already schedules an immediate work drain. Reset any
      // failure backoff and re-arm on the normal fallback cadence.
      if (failureCount > 0) {
        failureCount = 0;
        arm(intervalMs);
      }
    },
    async idle() {
      await running;
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
