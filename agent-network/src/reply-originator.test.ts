import { describe, expect, test } from "bun:test";
import { decideReplyAlias, replyAliasArgs } from "./reply-originator.js";

const map = new Map<string, string>();
const lookup = (id: string) => map.get(id);

describe("#1185 / f015d9d6 — send_reply 的 alias 决策", () => {
  test("命中：把记住的发起方显式发出去", () => {
    map.set("t1", "admin-user");
    expect(decideReplyAlias("t1", lookup)).toEqual({ kind: "known", alias: "admin-user" });
    expect(replyAliasArgs(decideReplyAlias("t1", lookup))).toEqual({ alias: "admin-user" });
  });

  test("🔴 未命中：省略 alias，且【绝不】发出字面量 hub", () => {
    const d = decideReplyAlias("t-unknown", lookup);
    expect(d).toEqual({ kind: "derive" });
    const args = replyAliasArgs(d);
    // 判据落在「键不存在」上，不是「值不是 hub」——发 alias:undefined 与省略不同，
    // 前者过不了服务端那句 `typeof alias === "string" && alias.trim()` 之外的意图检查。
    expect("alias" in args).toBe(false);
    expect(args).toEqual({});
    // 这一行是这个 bug 的直接回归钉：旧写法在这里会给出 "hub"。
    expect((args as { alias?: string }).alias).not.toBe("hub");
  });

  test("未命中的两个触发条件产出同一个决策（重启清空 / 推送尚未到达）", () => {
    // 1. 进程重启：Map 是空的
    const emptyMap = new Map<string, string>();
    expect(decideReplyAlias("t-after-restart", (id) => emptyMap.get(id))).toEqual({ kind: "derive" });
    // 2. 推送迟到：任务已存在于 hub，但本会话还没被推送过，所以没写进 Map
    expect(decideReplyAlias("t-push-pending", lookup)).toEqual({ kind: "derive" });
  });

  test("推送到达后（Map 被写上）同一个 task_id 转为 known —— 复现「重试就成功」", () => {
    expect(decideReplyAlias("t-late", lookup)).toEqual({ kind: "derive" });
    map.set("t-late", "admin-user");            // SSE 落地时 node-server 会做的事
    expect(decideReplyAlias("t-late", lookup)).toEqual({ kind: "known", alias: "admin-user" });
  });

  test("空串/空白视为未命中，不当成合法 alias 发出去", () => {
    map.set("t-empty", "");
    map.set("t-blank", "   ");
    expect(decideReplyAlias("t-empty", lookup)).toEqual({ kind: "derive" });
    expect(decideReplyAlias("t-blank", lookup)).toEqual({ kind: "derive" });
  });

  test("没有 task_id 可推导时保持历史行为：发给 hub", () => {
    expect(decideReplyAlias(undefined, lookup)).toEqual({ kind: "hub", alias: "hub" });
    expect(decideReplyAlias(null, lookup)).toEqual({ kind: "hub", alias: "hub" });
    expect(decideReplyAlias("", lookup)).toEqual({ kind: "hub", alias: "hub" });
    expect(replyAliasArgs(decideReplyAlias(null, lookup))).toEqual({ alias: "hub" });
  });
});
