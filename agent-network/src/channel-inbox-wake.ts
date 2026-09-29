// 2026-09-29:claude-code 裸节点的 channel(node-server)只在 new_task / broadcast 上拉 inbox。
// 两种投递因此一直躺在 inbox 里,直到别的推送顺带把它们捎进去(生产上 6–36 分钟):
//   1. 对端用 send_reply 回给本节点 —— hub 推的是 new_reply,channel 不认;agent-node 早就认了
//      (agent-node/src/peer-reply-inbox.ts routePeerReplySse)。
//   2. hub 那边判错「没人在听」而没推门铃(scheduler 按 node_id 找会话,本节点的会话行 node_id 为空)。
// 这里放两样东西:认哪些事件要拉 inbox;以及一个单飞的拉取器 + 定时兜底,
// 让任何一次漏推最多晚一个周期。

/** SSE event types that mean "there is something new in your inbox". */
export const INBOX_WAKE_EVENTS: ReadonlySet<string> = new Set(["new_task", "broadcast", "new_reply"]);

export function isInboxWakeEvent(type: unknown): boolean {
  return typeof type === "string" && INBOX_WAKE_EVENTS.has(type);
}

/**
 * Single-flight runner: at most one drain runs at a time, and wakeups that
 * arrive mid-drain collapse into exactly one rerun. Two concurrent drains
 * would both fetch the same unacked rows and inject each task twice.
 */
export function createSingleFlight(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let dirty = false;
  const loop = async (): Promise<void> => {
    try {
      do {
        dirty = false;
        await run();
      } while (dirty);
    } finally {
      current = null;
    }
  };
  return () => {
    if (current) {
      dirty = true;
      return current;
    }
    current = loop();
    return current;
  };
}

export const DEFAULT_INBOX_POLL_MS = 60_000;

/** ANET_CHANNEL_INBOX_POLL_MS: poll period in ms; "0" disables the safety net. */
export function inboxPollIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_INBOX_POLL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INBOX_POLL_MS;
  return Math.floor(n);
}

/**
 * Periodically run the drain so a missed push costs at most one period.
 * Returns a stop function. The timer never keeps the process alive.
 */
export function startInboxSafetyNet(opts: {
  intervalMs: number;
  drain: () => Promise<void>;
  onError?: (error: unknown) => void;
}): () => void {
  if (opts.intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    opts.drain().catch((error) => opts.onError?.(error));
  }, opts.intervalMs);
  (timer as any)?.unref?.();
  return () => clearInterval(timer);
}
