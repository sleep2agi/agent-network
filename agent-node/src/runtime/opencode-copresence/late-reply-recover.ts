/**
 * #3095 阶段二 —— 节点重启后，把「上次没等到的那一轮」的结果**读回来**。
 *
 * 阶段一（已上线）只做到了「不静默」：重启后发现 pending 记录，给发送方补一条
 * 「结果没回传，去 TUI 看」。但那句话解决不了问题 —— 用户要的是结果本身。
 *
 * 这一版把结果读出来：共享 opencode server（不是 agent-node）持有整段历史，
 * 所以节点重启甚至被 kill -9 之后，那一轮的 assistant 输出仍然能读到
 * （2026-10-30 实测：kill -9 + 重启后从历史里读回了 "DONE persist-3095"）。
 *
 * 两条边界（都必须守住）：
 *   · 只有**执行节点**能做（Hub 侧只认 task.to_node_id；发送方补不了）
 *   · server 自己也重启过时历史可能没了 ⇒ 必须能区分「还没跑完」与「找不到」，
 *     后者降级为阶段一的告知，不能假装成功
 */
import { fetchOpenCodeJson } from "./http.js";

export type TurnEntry = {
  id?: string;
  role?: string;
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  parts?: Array<{ type?: string; text?: string }>;
};

export type TurnResult =
  | { state: "done"; text: string }
  | { state: "pending" }
  | { state: "missing" };

function entryRole(entry: TurnEntry): string {
  return String(entry.role ?? entry.type ?? "");
}

function entryText(entry: TurnEntry): string {
  const parts = entry.content ?? entry.parts ?? [];
  let out = "";
  for (const part of parts) {
    if (part && typeof part.text === "string") out += part.text;
  }
  return out.trim();
}

/**
 * 从「最新的在前」的历史里，取出指定 turn 之后的那条最终回答。
 *
 * 为什么取**最后一条** assistant：实测里同一 turn 之后会出现多条 assistant
 * （先是 prompt 回显，再是最终答案），最终答案在时间序的最后一条。
 *
 * 为什么区分 pending / missing：
 *   · missing  = 历史里根本没有这个 turn ⇒ server 重启过、或历史被裁剪 ⇒ 只能告知丢失
 *   · pending  = turn 在，但后面还没有 assistant 输出 ⇒ 还在跑，应继续等
 * 把两者混成一种，就会把「还在跑」误报成「丢了」。
 */
export function extractTurnResult(entries: readonly TurnEntry[], turnId: string): TurnResult {
  const index = entries.findIndex((e) => e.id === turnId);
  if (index < 0) return { state: "missing" };
  // 最新在前 ⇒ 取 [0, index) 再反转，得到「这个 turn 之后」的时间序
  const newer = entries.slice(0, index).reverse();
  const assistantTexts = newer
    .filter((e) => entryRole(e) === "assistant")
    .map(entryText)
    .filter((t) => t.length > 0);
  const last = assistantTexts.at(-1);
  if (last) return { state: "done", text: last };
  return { state: "pending" };
}

/** 读该会话最近的一段历史（最新在前）。失败返回 null，由调用方降级。 */
export async function readSessionEntries(
  url: string,
  password: string,
  sessionId: string,
  limit = 40,
): Promise<TurnEntry[] | null> {
  try {
    const body = await fetchOpenCodeJson(
      url,
      password,
      `/api/session/${sessionId}/message?order=desc&limit=${limit}`,
      {},
      8_000,
    );
    const data = (body as { data?: unknown })?.data;
    return Array.isArray(data) ? (data as TurnEntry[]) : null;
  } catch {
    return null;
  }
}
