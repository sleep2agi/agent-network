// 2026-10-31 —— unit 事实读取器的契约。
//
// 四条断言对应四条设计约束：
//   ① TTL 是必须的：`daemon-reload` 能在进程运行期间改掉 Restart/Type
//   ② TTL 内不重读（否则每心跳都 spawn 一个 systemctl）
//   ③ 读失败**不写缓存**：否则「暂时读不到」会在 TTL 内看起来像「读到了」
//   ④ 三态不折布尔：读不到 ⇒ unknown，绝不折成 not_supervised

import { describe, expect, test } from "bun:test";
import {
  classifySupervision,
  createUnitFactsCache,
  parseSystemctlShow,
  type UnitFacts,
} from "./systemd-unit-facts";

const facts = (over: Partial<UnitFacts> = {}): UnitFacts => ({
  loadState: "loaded",
  type: "service",
  restart: "always",
  readAt: 0,
  ...over,
});

describe("createUnitFactsCache", () => {
  test("re-reads after TTL — daemon-reload can change Restart without restarting the process", () => {
    let calls = 0;
    let clock = 1_000;
    const cache = createUnitFactsCache(
      () => { calls += 1; return facts({ restart: calls === 1 ? "always" : "no" }); },
      { ttlMs: 30_000, now: () => clock },
    );
    expect(cache.get("a.service")!.restart).toBe("always");
    expect(calls).toBe(1);
    clock += 29_999;
    expect(cache.get("a.service")!.restart).toBe("always"); // 命中缓存
    expect(calls).toBe(1);
    clock += 2; // 越过 TTL
    expect(cache.get("a.service")!.restart).toBe("no"); // 重读看到了变化
    expect(calls).toBe(2);
  });

  test("does not re-read within TTL", () => {
    let calls = 0;
    const cache = createUnitFactsCache(() => { calls += 1; return facts(); }, { ttlMs: 10_000, now: () => 5 });
    cache.get("a"); cache.get("a"); cache.get("a");
    expect(calls).toBe(1);
  });

  test("a failed read is NOT cached — 'cannot read now' must not look like 'read it' for a TTL", () => {
    let calls = 0;
    let fail = true;
    const cache = createUnitFactsCache(() => {
      calls += 1;
      if (fail) throw new Error("systemctl: not found");
      return facts();
    }, { ttlMs: 60_000, now: () => 100 });
    expect(cache.get("a")).toBeNull();
    expect(cache.cacheBuiltAt()).toBeNull(); // 从未成功过
    fail = false;
    expect(cache.get("a")).not.toBeNull();   // 立刻重试并成功，不受 TTL 影响
    expect(calls).toBe(2);
    expect(cache.cacheBuiltAt()).toBe(100);
  });

  test("switching units invalidates the entry (cache key is the unit, not 'the system')", () => {
    let calls = 0;
    const cache = createUnitFactsCache((u) => { calls += 1; return facts({ restart: u }); }, { ttlMs: 60_000, now: () => 1 });
    expect(cache.get("a").restart).toBe("a");
    expect(cache.get("b").restart).toBe("b");
    expect(calls).toBe(2);
  });
});

describe("classifySupervision", () => {
  test("loaded + service + Restart≠no ⇒ supervised", () => {
    expect(classifySupervision(facts()).kind).toBe("supervised");
  });

  test("Restart=no / unset / non-service / not-loaded ⇒ not_supervised, each with its own reason", () => {
    expect(classifySupervision(facts({ restart: "no" }))).toMatchObject({ kind: "not_supervised", reason: "restart_no" });
    expect(classifySupervision(facts({ restart: "" }))).toMatchObject({ kind: "not_supervised", reason: "restart_unset" });
    expect(classifySupervision(facts({ type: "oneshot" }))).toMatchObject({ kind: "not_supervised", reason: "type:oneshot" });
    expect(classifySupervision(facts({ loadState: "not-found" }))).toMatchObject({ kind: "not_supervised", reason: "load_state:not-found" });
  });

  test("unreadable / incomplete ⇒ unknown, never folded to not_supervised", () => {
    expect(classifySupervision(null)).toMatchObject({ kind: "unknown", reason: "unit_facts_unavailable" });
    expect(classifySupervision(facts({ loadState: "" }))).toMatchObject({ kind: "unknown", reason: "unit_facts_incomplete" });
    expect(classifySupervision(facts({ type: "" }))).toMatchObject({ kind: "unknown", reason: "unit_facts_incomplete" });
  });
});

describe("parseSystemctlShow", () => {
  test("parses K=V lines and keeps unknowns empty (no invented defaults)", () => {
    const f = parseSystemctlShow("LoadState=loaded\nType=service\nRestart=on-failure\n", 42);
    expect(f).toEqual({ loadState: "loaded", type: "service", restart: "on-failure", readAt: 42 });
  });

  test("missing properties stay empty strings so classify can call them unknown", () => {
    const f = parseSystemctlShow("LoadState=loaded\n", 7);
    expect(f.type).toBe("");
    expect(classifySupervision(f).kind).toBe("unknown");
  });
});
