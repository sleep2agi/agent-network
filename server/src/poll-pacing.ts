/**
 * #3001 —— get_task 的轮询节奏提示（Hub 侧）。
 *
 * 为什么放在 Hub 而不是只改 agent-node 的提示词：
 * 提示词在 `agent-node/src/cli.ts` 里，改完要发 agent-node + CLI 配对版本，
 * 而且**只有升级过的节点才会变**。而 `get_task` 是 Hub 提供的 MCP 工具 ——
 * 在响应里加一句话，所有节点下一次调用就能看到，不需要任何客户端升级。
 *
 * 现场（TMW微软欧，2026-10-29 16:00Z → 10-30 01:00Z）：
 *
 *     每小时 get_task：256 / 565 / 647 / 703 / 770 / 855 / 893 / 972 / 736
 *     ⇒ 约 13 次/分钟、连续 8 小时、合计约 6000 次
 *
 * 每次 `get_task` 都是一整轮 LLM 调用。这 6000 次没有推进任何工作，
 * 只是在问「好没好」。而子任务的最终结果本来就会通过 parent_task_id 自动 chain 回上游。
 *
 * 设计取舍：
 * · **不返回错误、不改状态**，只在同一个响应里多一个 `pacing` 字段 ——
 *   调用方即使完全忽略它也照常工作（信息不缺，行为不破）。
 * · 阈值 4 次/60 秒：正常的「隔几分钟看一眼」永远碰不到；
 *   只有真正在连环打的才会看到这句提示。
 * · 计数按 (调用方, task_id) 分开，避免把「同时等多个子任务」误判成连环打。
 */

export type PollPacing = {
  calls_last_60s: number;
  recommended_interval_seconds: number;
  note: string;
};

export const WHOAMI_PACING_NOTE =
  "org_whoami 只需要在「不确定自己是谁/团队变了」时查。实测有节点以约 4–6 次/分钟连续查询、" +
  "同时窗口内没接到任何任务 —— 这些调用没有推进工作。建议隔 60 秒以上再看。";

export const POLL_PACING_NOTE =
  "每次 get_task 都是一整轮 LLM 调用。子任务的最终结果会通过 parent_task_id 自动 chain 回上游，" +
  "所以不必连续轮询 —— 建议隔 60 秒以上再看。";

export const POLL_WINDOW_MS = 60_000;
export const POLL_NUDGE_THRESHOLD = 4;
export const POLL_RECOMMENDED_SECONDS = 60;

/** 两类轮询的阈值与文案。分开是因为「正常频率」差一个数量级。 */
export const PACE_KINDS = {
  /** 等子任务：正常是「隔几分钟看一眼」，1 分钟内 4 次以上基本就是连环打。 */
  task_poll: { threshold: POLL_NUDGE_THRESHOLD, note: POLL_PACING_NOTE },
  /** 身份查询：p50 约 2.3 次/分钟是设计频率，1 分钟内 8 次以上才提示。 */
  identity_poll: { threshold: 8, note: WHOAMI_PACING_NOTE },
} as const;

export type PaceKind = keyof typeof PACE_KINDS;

export type PollPacer = {
  /** 记一次调用；超过阈值时返回提示，否则返回 null。 */
  record(key: string, kind?: PaceKind): PollPacing | null;
  /** 仅测试用：当前记录的 key 数。 */
  size(): number;
};

export function createPollPacer(opts: {
  windowMs?: number;
  threshold?: number;
  maxKeys?: number;
  now?: () => number;
} = {}): PollPacer {
  const windowMs = opts.windowMs ?? POLL_WINDOW_MS;
  const defaultThreshold = opts.threshold ?? POLL_NUDGE_THRESHOLD;
  const maxKeys = opts.maxKeys ?? 2000;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number[]>();

  function prune(ts: number[], cutoff: number): number[] {
    // 时间戳按升序追加，从头部删到窗口内为止。
    let i = 0;
    while (i < ts.length && ts[i] <= cutoff) i++;
    return i === 0 ? ts : ts.slice(i);
  }

  return {
    record(key: string, kind: PaceKind = "task_poll"): PollPacing | null {
      // 显式传了 threshold（测试用）就压过 kind 表
      const spec = opts.threshold !== undefined
        ? { threshold: defaultThreshold, note: PACE_KINDS[kind].note }
        : PACE_KINDS[kind];
      const t = now();
      const cutoff = t - windowMs;
      const prev = seen.get(key);
      const ts = prune(prev ?? [], cutoff);
      ts.push(t);
      seen.set(key, ts);

      // 无上限的 Map 就是一条内存泄漏 —— 调用方是外部输入，不能假设它只查自己的任务。
      if (seen.size > maxKeys) {
        for (const k of seen.keys()) {
          if (seen.size <= maxKeys) break;
          const keep = prune(seen.get(k) ?? [], cutoff);
          if (keep.length === 0) seen.delete(k);
          else seen.set(k, keep);
        }
        // 光靠过期回收不够：如果所有 key 都在窗口内（例如有人用几百个 task_id 乱打），
        // 过期一条也删不掉，长度仍然无界 —— 这里再按插入顺序硬砍到上限。
        while (seen.size > maxKeys) {
          const oldest = seen.keys().next();
          if (oldest.done) break;
          seen.delete(oldest.value);
        }
      }

      if (ts.length <= spec.threshold) return null;
      return {
        calls_last_60s: ts.length,
        recommended_interval_seconds: POLL_RECOMMENDED_SECONDS,
        note: spec.note,
      };
    },
    size(): number {
      return seen.size;
    },
  };
}

/** 进程级单例：Hub 只需要看「最近一分钟这位调用方问了多少次」。 */
export const pollPacer = createPollPacer();
