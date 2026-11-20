import { describe, expect, test, mock } from "bun:test";
import { fetchOpenCodeSessionPage } from "./sessions.js";

// 用 bun 的 fetch 桩：只验证「请求路径/查询参数」与「返回形状校验」，不连真 server。
function stubFetch(body: any, capture?: { url?: string }) {
  (globalThis as any).fetch = async (url: any) => {
    if (capture) capture.url = String(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("#4821 OpenCode sessions 只读取页", () => {
  test("打的是 /api/session（不是 /session 或 /sessions），并透传 cursor/limit", async () => {
    const capture: { url?: string } = {};
    stubFetch({ data: [{ id: "s1" }], cursor: { previous: null, next: "n1" } }, capture);
    const page = await fetchOpenCodeSessionPage("http://127.0.0.1:46663", "pw", { cursor: "c0", limit: 500 });
    expect(capture.url).toContain("/api/session?");
    expect(capture.url).toContain("cursor=c0");
    expect(capture.url).toContain("limit=100"); // 上限夹到 100
    expect(page.cursor?.next).toBe("n1");
  });

  test("空页形状 { data: [], cursor } 原样保留", async () => {
    stubFetch({ data: [], cursor: { previous: null, next: null } });
    const page = await fetchOpenCodeSessionPage("http://x", "pw");
    expect(page.data).toEqual([]);
    expect(page.cursor).toEqual({ previous: null, next: null });
  });

  test("上游形状不对 ⇒ 抛错（不把「读不到」装成「没有」）", async () => {
    stubFetch({ items: [] });
    await expect(fetchOpenCodeSessionPage("http://x", "pw")).rejects.toThrow("opencode_session_bad_shape");
  });
});
