// #4821 —— 列出 OpenCode V2 server 上的 sessions（只读）。
//
// 事实来源（真机实测 2026-11-20，通信客户端欧）：端点是 **GET /api/session**（`/session`、`/sessions`
// 返回的是 Web UI HTML，200 但不是 API），分页 `?cursor=`，空列表是 `{ data: [], cursor: {...} }`
// 而不是裸 `[]`，`time.{created,updated,idle,viewed}` 是 epoch ms。
//
// 这里只做「取一页并原样返回」，投影（字段/时间格式）在 Hub 侧做 —— 节点不该决定对外形状。

import { fetchOpenCodeJson } from "./http.js";

export type OpenCodeSessionPage = {
  data: unknown[];
  cursor: { previous?: string | null; next?: string | null } | null;
};

export async function fetchOpenCodeSessionPage(
  serverUrl: string,
  password: string,
  opts: { cursor?: string | null; limit?: number; timeoutMs?: number } = {},
): Promise<OpenCodeSessionPage> {
  const qs = new URLSearchParams();
  // cursor 对我们是 opaque：原样透传，不解析、不重编码（真机上它是 base64-ish 的串）。
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0) qs.set("limit", String(Math.min(opts.limit, 100)));
  const path = `/api/session${qs.toString() ? `?${qs.toString()}` : ""}`;
  const raw = await fetchOpenCodeJson(serverUrl, password, path, {}, opts.timeoutMs ?? 8_000);
  // 上游形状变化不能把「读不到」变成「没有」：不是 {data:[…]} 就报错，由调用方映射成 server_unreachable。
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).data)) {
    throw new Error("opencode_session_bad_shape");
  }
  const cur = (raw as any).cursor;
  return {
    data: (raw as any).data as unknown[],
    cursor: cur && typeof cur === "object" ? { previous: cur.previous ?? null, next: cur.next ?? null } : null,
  };
}
