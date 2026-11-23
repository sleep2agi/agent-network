// 停止指令不能排在它要停的那一轮后面。
// 2026-11-23 真机（antigravity）：12 步任务跑到一半发停止，任务照样跑完，停止指令在回合结束后
// 1 秒才被处理。原因是只有 OpenCode 共存模式会在收到通知时并发去取 control 行，其余运行时都
// 落在串行的工作通道里。这里的用例都从「回合还在跑」出发，不直接调处理函数。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createControlLane, createHandledIds, isControlRow } from "./control-lane";

const row = (id: string, type?: string) => ({ id, type });
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("control lane", () => {
  test("a control row is handled while the turn is still running", async () => {
    const order: string[] = [];
    const turn = deferred();
    // 串行工作通道：正被一个长回合占着。
    const workLane = (async () => { order.push("turn:start"); await turn.promise; order.push("turn:end"); })();

    const kick = createControlLane({
      fetchInbox: async () => [row("task-1", "task"), row("stop-1", "control")],
      handle: async (r) => { order.push(`stop:${r.id}`); },
      warn: () => {},
    });
    await kick();
    expect(order).toEqual(["turn:start", "stop:stop-1"]);
    turn.resolve();
    await workLane;
    expect(order).toEqual(["turn:start", "stop:stop-1", "turn:end"]);
  });

  test("only control rows are touched; tasks and messages stay for the work lane", async () => {
    const seen: string[] = [];
    const kick = createControlLane({
      fetchInbox: async () => [row("a"), row("b", "message"), row("c", "control"), row("d", "task"), row("e", "control")],
      handle: async (r) => { seen.push(r.id); },
      warn: () => {},
    });
    await kick();
    expect(seen).toEqual(["c", "e"]);
    expect(isControlRow(row("x"))).toBe(false);
  });

  test("a burst of notifications costs at most two fetches and loses none", async () => {
    let fetches = 0;
    const gate = deferred();
    const inbox = [[row("s1", "control")], [row("s2", "control")]];
    const handled: string[] = [];
    const kick = createControlLane({
      fetchInbox: async () => { const batch = inbox[fetches] ?? []; fetches++; if (fetches === 1) await gate.promise; return batch; },
      handle: async (r) => { handled.push(r.id); },
      warn: () => {},
    });
    const first = kick();
    await Promise.all([kick(), kick(), kick(), kick()]); // arrive while the first pass is fetching
    gate.resolve();
    await first;
    expect(fetches).toBe(2);
    expect(handled).toEqual(["s1", "s2"]);
  });

  test("one failing row or a failed fetch never throws out of the lane", async () => {
    const warnings: string[] = [];
    const handled: string[] = [];
    const kick = createControlLane({
      fetchInbox: async () => [row("bad", "control"), row("good", "control")],
      handle: async (r) => { if (r.id === "bad") throw new Error("boom"); handled.push(r.id); },
      warn: (m) => warnings.push(m),
    });
    await kick();
    expect(handled).toEqual(["good"]);
    expect(warnings.join("\n")).toContain("boom");

    const failing = createControlLane({ fetchInbox: async () => { throw new Error("hub down"); }, handle: async () => {}, warn: (m) => warnings.push(m) });
    await failing();
    expect(warnings.join("\n")).toContain("hub down");
    await failing(); // 失败后还能再跑，不会卡在 running 状态
    expect(warnings.filter((m) => m.includes("hub down")).length).toBe(2);
  });

  test("handled ids are remembered, bounded, and refreshed on re-add", () => {
    const ids = createHandledIds(3);
    for (const id of ["a", "b", "c"]) ids.add(id);
    ids.add("a"); // refresh: a 变成最新
    ids.add("d"); // 挤掉最老的 b
    expect([ids.has("a"), ids.has("b"), ids.has("c"), ids.has("d")]).toEqual([true, false, true, true]);
    expect(ids.size).toBe(3);
  });
});

describe("cli.ts 接线", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  const sse = src.slice(src.indexOf('if (ev.type === "new_message" && RUNTIME === "opencode" && opencodeMode === "copresence")'));
  const general = sse.slice(sse.indexOf('} else if (["new_task", "new_message", "broadcast"].includes(ev.type)) {'), sse.indexOf('if (ev.type === "new_reply")'));

  test("every runtime kicks the control lane when the Hub announces a control message", () => {
    expect(general).toContain("scheduleWorkInboxDrain();");
    expect(general).toContain("if ((ev as any).control) void drainControlNow();");
  });

  test("the lane fetches by priority with a deep page, not the work lane's human-first page", () => {
    const lane = src.slice(src.indexOf("const drainControlNow = createControlLane"), src.indexOf("async function processInbox()"));
    expect(lane).toContain('callCommHub("get_inbox", { alias: await liveAlias(), limit: 100 })');
    expect(lane).toContain("handle: processControlInstruction");
    expect(lane).not.toContain("human_first");
  });

  const handler = src.slice(src.indexOf("async function processControlInstruction"), src.indexOf("const handledControlIds = createHandledIds()"));
  test("a row already handled is only re-acked, never run or answered twice", () => {
    const guard = handler.slice(handler.indexOf("if (handledControlIds.has(msg.id))"), handler.indexOf("inflightMessageIds.add(msg.id)"));
    expect(guard).toContain("await ackMessage(msg.id)");
    expect(guard).toContain("return;");
    expect(guard).not.toContain("sendReply");
    // 先记「已处理」，再回执、再 ack：回执或 ack 失败也不会导致重做一次停止。
    expect(handler.indexOf("handledControlIds.add(msg.id)")).toBeLessThan(handler.indexOf("await sendReply("));
    expect(handler.indexOf("handledControlIds.add(msg.id)")).toBeGreaterThan(handler.indexOf("log(`[control] interrupt"));
  });

  test("grok in ACP mode uses the ACP cancel; modes without a stop path say so", () => {
    expect(handler).toContain('(RUNTIME === "antigravity" || (RUNTIME === "grok" && GROK_EXECUTION_MODE === "acp"))');
    expect(handler).toContain('reason: "not_supported"');
    expect(src).toContain('const acpInterrupt = RUNTIME === "antigravity" || (RUNTIME === "grok" && GROK_EXECUTION_MODE === "acp");');
  });
});
