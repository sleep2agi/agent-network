// 命令解析的三条风险，逐条钉住：
//   ① 正常句子里的 "/q" 不能被当成命令（否则用户的话被吃掉）
//   ② 参数非法时不猜（回用法，而不是默默不动）
//   ③ 只认整条消息是命令，不做前缀匹配
import { describe, expect, test } from "bun:test";
import { parseQueueCommand } from "./feishu-queue-command";

describe("队列命令解析", () => {
  test("/q 与 /queue ⇒ 看队列", () => {
    expect(parseQueueCommand("/q")).toEqual({ kind: "list" });
    expect(parseQueueCommand("  /queue ")).toEqual({ kind: "list" });
  });

  test("/cancel 2 与 /prio 1 ⇒ 带位次", () => {
    expect(parseQueueCommand("/cancel 2")).toEqual({ kind: "cancel", position: 2 });
    expect(parseQueueCommand("/prio 1")).toEqual({ kind: "promote", position: 1 });
  });

  test("/clear ⇒ 只清自己的", () => {
    expect(parseQueueCommand("/clear")).toEqual({ kind: "clear", onlyMine: true });
  });

  test("🔴 正常句子里的 /q 不算命令（否则用户的话被吞掉）", () => {
    expect(parseQueueCommand("帮我看看 /q 这个文件夹")).toEqual({ kind: "none" });
    expect(parseQueueCommand("what is /cancel")).toEqual({ kind: "none" });
  });

  test("参数非法 ⇒ 回用法（不猜位次）", () => {
    expect(parseQueueCommand("/cancel")).toEqual({ kind: "help" });
    expect(parseQueueCommand("/cancel abc")).toEqual({ kind: "help" });
    expect(parseQueueCommand("/prio 0")).toEqual({ kind: "help" });
    expect(parseQueueCommand("/cancel 2.5")).toEqual({ kind: "help" });
  });

  test("以 / 开头但不像队列命令 ⇒ 当普通内容放行（可能是路径）", () => {
    expect(parseQueueCommand("/tmp/report.md 看一下")).toEqual({ kind: "none" });
  });

  test("空消息 ⇒ none", () => {
    expect(parseQueueCommand("")).toEqual({ kind: "none" });
    expect(parseQueueCommand(undefined)).toEqual({ kind: "none" });
  });
});

describe("/steer —— 改口：并进正在跑的那一轮", () => {
  test("/steer 后面带正文 ⇒ 提取原文", () => {
    expect(parseQueueCommand("/steer 改成只改 README")).toEqual({ kind: "steer", text: "改成只改 README" });
  });

  test("空正文 ⇒ 回用法（不猜要改什么）", () => {
    expect(parseQueueCommand("/steer")).toEqual({ kind: "help" });
    expect(parseQueueCommand("/steer   ")).toEqual({ kind: "help" });
  });

  test("正文里的斜杠与换行都要保留（命令后面是自由文本）", () => {
    const r = parseQueueCommand("/steer 先看 /tmp/a.log\n再决定");
    expect(r).toEqual({ kind: "steer", text: "先看 /tmp/a.log\n再决定" });
  });
});
