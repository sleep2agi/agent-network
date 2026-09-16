// #1900(2026-09-16):node-server 每个 new_task 事件只 get_inbox(limit 5) 一次,节点忙时攒下 >5 条就要
// 等下一个事件才投,表现为「一批旧消息迟到」。这里把「取一页 → 处理 → 再取」抽成纯逻辑:
// 直到一页取不满(或空)为止,并对每页设上限防止 hub 异常时无限循环。
export interface InboxPage<T> { ok?: boolean; messages?: T[] }

export interface DrainOptions<T extends { id: string }> {
  fetchPage: (limit: number) => Promise<InboxPage<T> | undefined | null>;
  handle: (msg: T) => Promise<void>;
  pageSize?: number;
  maxPages?: number;
}

export interface DrainResult { delivered: number; pages: number; stoppedBy: "empty" | "short-page" | "max-pages" | "no-progress" | "fetch-error" }

export async function drainInbox<T extends { id: string }>(opts: DrainOptions<T>): Promise<DrainResult> {
  const pageSize = opts.pageSize ?? 5;
  const maxPages = opts.maxPages ?? 20;
  const seen = new Set<string>();
  let delivered = 0;
  for (let page = 1; page <= maxPages; page++) {
    let res: InboxPage<T> | undefined | null;
    try { res = await opts.fetchPage(pageSize); } catch { return { delivered, pages: page, stoppedBy: "fetch-error" }; }
    const msgs = (res?.ok ? res.messages : undefined) ?? [];
    if (msgs.length === 0) return { delivered, pages: page, stoppedBy: "empty" };
    // 如果 hub 一直回同一批(比如 ack 没生效),不要空转
    const fresh = msgs.filter((m) => !seen.has(m.id));
    if (fresh.length === 0) return { delivered, pages: page, stoppedBy: "no-progress" };
    for (const m of fresh) { seen.add(m.id); await opts.handle(m); delivered++; }
    if (msgs.length < pageSize) return { delivered, pages: page, stoppedBy: "short-page" };
  }
  return { delivered, pages: maxPages, stoppedBy: "max-pages" };
}
