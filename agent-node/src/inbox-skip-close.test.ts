import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  classifyInboundSkip,
  closeLowValueTask,
  closeSkippedTask,
  formatCloseOutcome,
  OWN_PREFIX_CLOSE_REASON,
  SELF_TASK_CLOSE_REASON,
  type HubToolCall,
  type InboundSkipInput,
} from "./inbox-skip-close";

const ALIAS = "node-a";

function verdict(over: Partial<InboundSkipInput>): string | null {
  return classifyInboundSkip({
    alias: ALIAS,
    from: "peer-b",
    content: "please do the thing",
    msgType: "task",
    imBridge: false,
    now: 100_000,
    cooldownMs: 5000,
    isLowValue: (t) => t.trim().toLowerCase() === "ok",
    ...over,
  });
}

/** Fake Hub: records every tool call and models the task rows + inbox it touches. */
function fakeHub(seed: Array<{ task_id: string; from: string; to: string; content: string }> = []) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const tasks = new Map<string, { status: string; result?: string; from: string; to: string; content: string }>();
  const inbox: Array<{ id: string; task_id: string; type: string; from: string; to: string; content: string }> = [];
  let seq = 0;
  for (const t of seed) {
    tasks.set(t.task_id, { status: "delivered", from: t.from, to: t.to, content: t.content });
    inbox.push({ id: `in-${++seq}`, task_id: t.task_id, type: "task", from: t.from, to: t.to, content: t.content });
  }
  const call: HubToolCall = async (tool, args) => {
    calls.push({ tool, args });
    const id = String(args.task_id ?? args.task ?? "");
    const row = tasks.get(id);
    const open = row && ["created", "delivered", "acked", "running"].includes(row.status);
    switch (tool) {
      case "cancel_task":
        if (!open) return { ok: false, task_id: id, cancelled: false };
        row!.status = "cancelled";
        row!.result = String(args.reason);
        return { ok: true, task_id: id, cancelled: true };
      case "report_completion":
        // Hub: replied by task_id, no inbox row for the sender.
        if (open) { row!.status = "replied"; row!.result = String(args.result); }
        return { ok: true, completion_id: "c1" };
      case "send_task": {
        const tid = `t-${++seq}`;
        tasks.set(tid, { status: "delivered", from: ALIAS, to: String(args.alias), content: String(args.task) });
        inbox.push({ id: `in-${seq}`, task_id: tid, type: "task", from: ALIAS, to: String(args.alias), content: String(args.task) });
        return { ok: true, task_id: tid };
      }
      case "send_reply":
        if (open) { row!.status = "replied"; row!.result = String(args.text); }
        inbox.push({ id: `in-${++seq}`, task_id: `r-${seq}`, type: "reply", from: ALIAS, to: row?.from ?? "", content: String(args.text) });
        return { ok: true };
      default:
        throw new Error(`unexpected tool ${tool}`);
    }
  };
  return { call, calls, tasks, inbox };
}

describe("classifyInboundSkip (#519)", () => {
  test("a task from this node's own alias is the self reply-loop guard", () => {
    expect(verdict({ from: ALIAS })).toBe("self");
  });

  test("a Feishu-bridge row under the node's own alias still runs", () => {
    expect(verdict({ from: ALIAS, imBridge: true })).toBeNull();
  });

  test("a task echoing this node's reply prefix is own-prefix", () => {
    expect(verdict({ content: `[${ALIAS}] done` })).toBe("own-prefix");
  });

  test("ordinary peer tasks, even short or rapid, run", () => {
    expect(verdict({})).toBeNull();
    expect(verdict({ content: "ok" })).toBeNull();
    expect(verdict({ lastReplyAt: 99_000 })).toBeNull();
  });

  test("non-actionable chatter keeps cooldown and low-value filters", () => {
    expect(verdict({ msgType: "message", lastReplyAt: 99_000 })).toBe("cooldown");
    expect(verdict({ msgType: "message", content: "ok" })).toBe("low-value-inbound");
    expect(verdict({ msgType: "message", from: "hub", lastReplyAt: 99_000 })).toBeNull();
  });
});

describe("closeSkippedTask (#519)", () => {
  test("a skipped self-sent task is cancelled with an explicit reason, never left acked", async () => {
    const hub = fakeHub([{ task_id: "t-self", from: ALIAS, to: ALIAS, content: "wake up" }]);
    const out = await closeSkippedTask(hub.call, { taskId: "t-self", msgType: "task", reason: "self" });
    expect(out).toEqual({ kind: "closed", tool: "cancel_task" });
    expect(hub.calls).toEqual([{ tool: "cancel_task", args: { task_id: "t-self", reason: SELF_TASK_CLOSE_REASON } }]);
    expect(hub.tasks.get("t-self")!.status).toBe("cancelled");
    expect(hub.tasks.get("t-self")!.result).toContain("self-sent task");
    expect(hub.tasks.get("t-self")!.result).toContain("reply-loop guard");
    expect(hub.tasks.get("t-self")!.result).toContain("scheduled task");
  });

  test("own-prefix echoes are cancelled with their own reason", async () => {
    const hub = fakeHub([{ task_id: "t-echo", from: "peer-b", to: ALIAS, content: `[${ALIAS}] done` }]);
    const out = await closeSkippedTask(hub.call, { taskId: "t-echo", msgType: "task", reason: "own-prefix" });
    expect(out.kind).toBe("closed");
    expect(hub.tasks.get("t-echo")!.result).toBe(OWN_PREFIX_CLOSE_REASON);
  });

  test("closing writes nothing to any inbox — it cannot wake the sender", async () => {
    const hub = fakeHub([{ task_id: "t-self", from: ALIAS, to: ALIAS, content: "wake up" }]);
    const before = hub.inbox.length;
    await closeSkippedTask(hub.call, { taskId: "t-self", msgType: "task", reason: "self" });
    expect(hub.inbox.length).toBe(before);
    expect(hub.calls.map((c) => c.tool)).not.toContain("send_reply");
    expect(hub.calls.map((c) => c.tool)).not.toContain("send_task");
  });

  test("rows without a task, and filter reasons that are not loop guards, make no Hub call", async () => {
    const hub = fakeHub();
    for (const [msgType, reason] of [["message", "self"], ["reply", "self"], ["task", "cooldown"], ["task", "low-value-inbound"]]) {
      expect((await closeSkippedTask(hub.call, { taskId: "t1", msgType, reason })).kind).toBe("not-applicable");
    }
    expect((await closeSkippedTask(hub.call, { taskId: "", msgType: "task", reason: "self" })).kind).toBe("not-applicable");
    expect(hub.calls).toEqual([]);
  });

  test("an already-terminal task reports not-closed; a Hub error never throws", async () => {
    const hub = fakeHub([{ task_id: "t-done", from: ALIAS, to: ALIAS, content: "x" }]);
    hub.tasks.get("t-done")!.status = "replied";
    expect((await closeSkippedTask(hub.call, { taskId: "t-done", msgType: "task", reason: "self" })).kind).toBe("not-closed");
    const boom: HubToolCall = async () => { throw new Error("hub down"); };
    const out = await closeSkippedTask(boom, { taskId: "t1", msgType: "task", reason: "self" });
    expect(out.kind).toBe("error");
    expect(formatCloseOutcome("t1", out)).toContain("hub down");
  });
});

describe("closeLowValueTask (#519)", () => {
  test("a low-value result closes the task as replied via report_completion, without an inbox reply", async () => {
    const hub = fakeHub([{ task_id: "t-lv", from: "peer-b", to: ALIAS, content: "ping" }]);
    const before = hub.inbox.length;
    const out = await closeLowValueTask(hub.call, { alias: ALIAS, taskId: "t-lv", msgType: "task", result: "done." });
    expect(out).toEqual({ kind: "closed", tool: "report_completion" });
    expect(hub.calls.length).toBe(1);
    expect(hub.calls[0].tool).toBe("report_completion");
    expect(hub.calls[0].args.alias).toBe(ALIAS);
    expect(hub.calls[0].args.task).toBe("t-lv");
    expect(hub.tasks.get("t-lv")!.status).toBe("replied");
    expect(hub.tasks.get("t-lv")!.result).toContain("done.");
    expect(hub.tasks.get("t-lv")!.result).toContain("low-value reply withheld");
    expect(hub.inbox.length).toBe(before);
  });

  test("an empty result still satisfies report_completion's non-empty result", async () => {
    const hub = fakeHub([{ task_id: "t-empty", from: "peer-b", to: ALIAS, content: "ping" }]);
    await closeLowValueTask(hub.call, { alias: ALIAS, taskId: "t-empty", msgType: "task", result: "  " });
    expect(String(hub.calls[0].args.result)).toStartWith("(empty reply)");
  });

  test("reply rows carry no task and are left alone", async () => {
    const hub = fakeHub();
    expect((await closeLowValueTask(hub.call, { alias: ALIAS, taskId: "t1", msgType: "reply", result: "ok" })).kind).toBe("not-applicable");
    expect(hub.calls).toEqual([]);
  });
});

describe("self-loop scenario (#519): the guard still holds", () => {
  // A model that answers every task AND sends itself another one — the chain
  // the reply-loop guard exists to stop. Drive the inbox the way processInbox
  // does: filter, then either close (skip) or run the turn.
  async function drain(hub: ReturnType<typeof fakeHub>, maxSteps: number): Promise<number> {
    let steps = 0;
    while (steps < maxSteps) {
      const msg = hub.inbox.shift();
      if (!msg) return steps;
      steps++;
      if (msg.to !== ALIAS) continue; // delivered elsewhere
      if (msg.type === "reply" && msg.from === ALIAS) continue; // processInbox returns early for self replies
      const skip = verdict({ from: msg.from, content: msg.content, msgType: msg.type });
      if (skip) {
        await closeSkippedTask(hub.call, { taskId: msg.task_id, msgType: msg.type, reason: skip });
        continue;
      }
      // "turn": reply, then wake myself again
      await hub.call("send_reply", { task_id: msg.task_id, text: `[${ALIAS}] working` });
      await hub.call("send_task", { alias: ALIAS, task: "keep going" });
    }
    return steps;
  }

  test("a self-chaining model stops after one self task, and that task is closed", async () => {
    const hub = fakeHub([{ task_id: "t-root", from: "peer-b", to: ALIAS, content: "start" }]);
    const steps = await drain(hub, 50);
    expect(steps).toBeLessThan(50);
    const selfTasks = [...hub.tasks.entries()].filter(([, t]) => t.from === ALIAS && t.to === ALIAS);
    expect(selfTasks.length).toBe(1);
    expect(selfTasks[0][1].status).toBe("cancelled");
    expect(hub.calls.filter((c) => c.tool === "send_task").length).toBe(1);
    // nothing this node was sent is left open
    const open = [...hub.tasks.values()].filter((t) => t.to === ALIAS && ["delivered", "acked"].includes(t.status));
    expect(open).toEqual([]);
  });
});

describe("cli.ts wiring (#519)", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

  test("the inbound filter delegates to classifyInboundSkip", () => {
    const fn = src.slice(src.indexOf("function shouldSkipMessage("), src.indexOf("// ── Inbox + SSE ──"));
    expect(fn).toContain("classifyInboundSkip({");
    expect(fn).toContain("imBridge: isIMBridgeMessage(msg)");
  });

  test("the skipped path closes the task after acking it", () => {
    const at = src.indexOf('await ackAndRecordConsumed(msg, "skipped");');
    const close = src.indexOf("closeSkippedTask(hubToolCall, { taskId: logicalTaskId, msgType, reason: skip })", at);
    expect(at).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(at);
    expect(src.slice(at, close)).not.toContain("return;");
  });

  test("the low-value path closes the task after acking it", () => {
    const at = src.indexOf('await ackAndRecordConsumed(msg, "low-value");');
    const close = src.indexOf("closeLowValueTask(hubToolCall, { alias: ALIAS, taskId: logicalTaskId, msgType, result })", at);
    expect(at).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(at);
    expect(src.slice(at, close)).not.toContain("return;");
  });
});
