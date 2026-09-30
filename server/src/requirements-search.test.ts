// requirements-search.ts 的纯函数:任务 ID 匹配(与 App 的 task-short-id.ts matchesTaskId 同一规则)。
import { describe, expect, test } from "bun:test";
import { matchesTaskId, parseListQuery, taskIdQuery } from "./requirements-search.js";

const row = (id: string, seq: number | null) => ({ requirement_id: id, seq });

describe("matchesTaskId", () => {
  test("#N / N match seq exactly (#7 does not hit #70)", () => {
    expect(matchesTaskId(row("req_a", 7), "#7")).toBe(true);
    expect(matchesTaskId(row("req_a", 7), "7")).toBe(true);
    expect(matchesTaskId(row("req_a", 70), "#7")).toBe(false);
    expect(matchesTaskId(row("req_a", null), "#7")).toBe(false);
  });
  test("full id and 8+ char prefix, with or without req_; shorter prefixes do not count", () => {
    const id = "req_0a1b2c3d-4e5f-6789-abcd-ef0123456789";
    expect(matchesTaskId(row(id, 1), id)).toBe(true);
    expect(matchesTaskId(row(id, 1), "0a1b2c3d")).toBe(true);
    expect(matchesTaskId(row(id, 1), "req_0a1b2c3d-4")).toBe(true);
    expect(matchesTaskId(row(id, 1), "0a1b2c3")).toBe(false);
    expect(matchesTaskId(row(id, 1), "")).toBe(false);
  });
  test("taskIdQuery: trim, NFKC (full-width ＃７ → #7), lowercase", () => {
    expect(taskIdQuery(" ＃７ ")).toBe("#7");
    expect(taskIdQuery("REQ_0A1B")).toBe("req_0a1b");
  });
  test("parseListQuery: idQuery only when there are terms", () => {
    const q = (s: string) => parseListQuery(new URLSearchParams(s)) as any;
    expect(q("q=%EF%BC%83%EF%BC%97").idQuery).toBe("#7");
    expect(q("q=%20%20").idQuery).toBe("");
    expect(q("").idQuery).toBe("");
  });
});
