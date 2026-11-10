// 队列的三件事必须能用假的行为钉住，否则"可操作"只是一句形容词：
//   ① 能看见（list 的位置与等待时长）
//   ② 能改（promote 真的提前；取消的真的不跑）
//   ③ 能撤（cancel 幂等；正在跑的不受影响）
import { describe, expect, test } from "bun:test";
import { TurnQueue } from "./feishu-turn-queue";

const mk = () => new TurnQueue<string>({ now: () => 1000 });

describe("TurnQueue —— 可看见", () => {
  test("list 给出 1 起的位次与等待时长", () => {
    let t = 1000;
    const q = new TurnQueue<string>({ now: () => t });
    q.push({ sender: "a", payload: "first" });
    t = 1500;
    q.push({ sender: "b", payload: "second" });
    const snap = q.list();
    expect(snap.map((e) => [e.position, e.sender, e.waitedMs])).toEqual([
      [1, "a", 500],
      [2, "b", 0],
    ]);
  });

  test("空闲时 current() 为 null；size 只算未开始的", () => {
    const q = mk();
    expect(q.current()).toBeNull();
    q.push({ sender: "a", payload: "x" });
    expect(q.size).toBe(1);
  });
});

describe("TurnQueue —— 能改优先级", () => {
  test("high 入队插到 normal 前面（high 之间保持 FIFO）", () => {
    const q = mk();
    q.push({ sender: "a", payload: "n1" });
    q.push({ sender: "b", payload: "h1", priority: "high" });
    q.push({ sender: "c", payload: "h2", priority: "high" });
    q.push({ sender: "d", payload: "n2" });
    expect(q.list().map((e) => e.id)).toEqual(["q2", "q3", "q1", "q4"]);
  });

  test("promote 把 normal 提到 high 区尾部（不越过已有的 high）", () => {
    const q = mk();
    q.push({ sender: "a", payload: "n1" }); // q1
    q.push({ sender: "b", payload: "h1", priority: "high" }); // q2
    q.push({ sender: "c", payload: "n2" }); // q3
    expect(q.promote("q3")).toBe(true);
    expect(q.list().map((e) => e.id)).toEqual(["q2", "q3", "q1"]);
    expect(q.list()[1].priority).toBe("high");
  });

  test("promote 不存在的 id ⇒ false（幂等，不抛）", () => {
    expect(mk().promote("nope")).toBe(false);
  });
});

describe("TurnQueue —— 能撤", () => {
  test("cancel 掉的条目不会被执行", async () => {
    const q = mk();
    const ran: string[] = [];
    q.push({ sender: "a", payload: "keep" });
    const drop = q.push({ sender: "b", payload: "drop" });
    expect(q.cancel(drop)).toBe(true);
    await q.drain(async (e) => { ran.push(e.payload); });
    expect(ran).toEqual(["keep"]);
  });

  test("cancel 幂等：同一 id 第二次返回 false", () => {
    const q = mk();
    const id = q.push({ sender: "a", payload: "x" });
    expect(q.cancel(id)).toBe(true);
    expect(q.cancel(id)).toBe(false);
  });

  test("🔴 正在跑的那条撤不掉（cancel 只对未开始生效）—— 那属于「打断」，不是「撤回」", async () => {
    const q = mk();
    q.push({ sender: "a", payload: "running" });
    let cancelledDuringRun = true;
    await q.drain(async () => {
      cancelledDuringRun = q.cancel("q1"); // 它已经在跑了
      expect(q.current()?.id).toBe("q1");
    });
    expect(cancelledDuringRun).toBe(false);
  });

  test("clear 支持按条件撤（例如只撤某个人的）", () => {
    const q = mk();
    q.push({ sender: "alice", payload: "a1" });
    q.push({ sender: "bob", payload: "b1" });
    q.push({ sender: "alice", payload: "a2" });
    expect(q.clear((e) => e.sender === "alice")).toBe(2);
    expect(q.list().map((e) => e.sender)).toEqual(["bob"]);
  });
});

describe("TurnQueue —— 串行语义不变", () => {
  test("同时只跑一条；顺序按队列", async () => {
    const q = mk();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    for (const p of ["a", "b", "c"]) q.push({ sender: "s", payload: p });
    await q.drain(async (e) => {
      active += 1; maxActive = Math.max(maxActive, active);
      events.push(`start:${e.payload}`);
      await new Promise((r) => setTimeout(r, 1));
      events.push(`end:${e.payload}`);
      active -= 1;
    });
    expect(maxActive).toBe(1);
    expect(events.filter((x) => x.startsWith("start")).map((x) => x.split(":")[1])).toEqual(["a", "b", "c"]);
  });

  test("一条抛错不中断队列（后面的照跑）", async () => {
    const q = mk();
    const ran: string[] = [];
    const errors: string[] = [];
    q.push({ sender: "s", payload: "boom" });
    q.push({ sender: "s", payload: "ok" });
    await q.drain(async (e) => {
      if (e.payload === "boom") throw new Error("x");
      ran.push(e.payload);
    }, (err) => { errors.push(String((err as Error).message)); });
    expect(ran).toEqual(["ok"]);
    expect(errors).toEqual(["x"]);
  });

  test("drain 运行中入队的条目会被同一次 drain 接着跑", async () => {
    const q = mk();
    const ran: string[] = [];
    q.push({ sender: "s", payload: "a" });
    await q.drain(async (e) => {
      ran.push(e.payload);
      if (e.payload === "a") q.push({ sender: "s", payload: "b" }); // 运行中追加
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(ran).toEqual(["a", "b"]);
  });
});

describe("队列上限：满了就明确拒绝", () => {
  test("未满 ⇒ 空串（正常入队，不加提示）", async () => {
    const { queueFullNotice } = await import("./feishu-turn-queue");
    expect(queueFullNotice(0)).toBe("");
    expect(queueFullNotice(19, 20)).toBe("");
  });

  test("到上限 ⇒ 明说「没有排上」，不许给「会被处理」的错觉", async () => {
    const { queueFullNotice } = await import("./feishu-turn-queue");
    const t = queueFullNotice(20, 20);
    expect(t).toContain("没有排上");
    expect(t).toContain("20");
  });

  test("超过上限同样拒绝（>= 恒定）", async () => {
    const { queueFullNotice } = await import("./feishu-turn-queue");
    expect(queueFullNotice(25, 20)).toContain("没有排上");
  });
});
