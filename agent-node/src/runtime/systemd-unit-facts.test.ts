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
  respawnsOnExit75,
  type UnitFacts,
} from "./systemd-unit-facts";

const facts = (over: Partial<UnitFacts> = {}): UnitFacts => ({
  loadState: "loaded",
  type: "service",
  restart: "always",
  successExitStatus: "",
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

// 2026-10-31 —— exit 75 会不会被重新拉起：由 Restart= 与 SuccessExitStatus= 共同决定。
// 对方实测：`systemctl show -p Restart` 对「unit 不存在」也输出 no + rc=0 ⇒
// 「不存在」与「Restart=no」同输出同成功码 ⇒ 三态的产出者是 LoadState，不是 Restart。
describe("respawnsOnExit75", () => {
  test("always ⇒ true regardless of SuccessExitStatus", () => {
    expect(respawnsOnExit75("always", "")).toBe(true);
    expect(respawnsOnExit75("always", "75")).toBe(true);
  });

  test("no ⇒ false", () => {
    expect(respawnsOnExit75("no", "")).toBe(false);
    expect(respawnsOnExit75("no", "75")).toBe(false);
  });

  test("on-failure ⇒ restarts 75 unless 75 is listed as a success exit", () => {
    expect(respawnsOnExit75("on-failure", "")).toBe(true);
    expect(respawnsOnExit75("on-failure", "75")).toBe(false);
    expect(respawnsOnExit75("on-failure", "0 75")).toBe(false);
    expect(respawnsOnExit75("on-failure", "0 70")).toBe(true);
  });

  test("on-success ⇒ restarts 75 only if listed", () => {
    expect(respawnsOnExit75("on-success", "75")).toBe(true);
    expect(respawnsOnExit75("on-success", "")).toBe(false);
  });

  test("other Restart= values are NOT guessed into a boolean", () => {
    for (const v of ["on-abnormal", "on-abort", "on-watchdog", "", "on-abnormal "]) {
      expect(respawnsOnExit75(v, "")).toBeNull();
    }
  });

  test("the [unprintable] literal for unset SuccessExitStatus is not parsed as a number", () => {
    // systemd 对未设置打的是字面量，不是 0 ⇒ 解析它不能产生「75 在列表里」的错觉
    expect(respawnsOnExit75("on-failure", "[unprintable]")).toBe(true);
  });
});

describe("classifySupervision — exit75 视角", () => {
  test("Restart=on-failure + SuccessExitStatus=75 ⇒ supervised 但 exit75 **不**(会被当成成功退出)", () => {
    const r = classifySupervision(facts({ restart: "on-failure", successExitStatus: "75" }));
    expect(r.kind).toBe("supervised");
    if (r.kind === "supervised") expect(r.respawnsOnExit75).toBe(false);
  });

  test("Restart=on-failure without the list ⇒ exit75 会重启", () => {
    const r = classifySupervision(facts({ restart: "on-failure" }));
    if (r.kind === "supervised") expect(r.respawnsOnExit75).toBe(true);
  });

  test("RestartPreventExitStatus is NOT the knob — unset prints [unprintable], we don't read it", () => {
    // 只断言我们的输入里根本没有这个字段：读它等于查错旋钮。
    const f = facts();
    expect("restartPreventExitStatus" in f).toBe(false);
  });
});

describe("parseSystemctlShow", () => {
  test("parses K=V lines and keeps unknowns empty (no invented defaults)", () => {
    const f = parseSystemctlShow(
      "LoadState=loaded\nType=service\nRestart=on-failure\nSuccessExitStatus=0 75\n",
      42,
    );
    expect(f).toEqual({
      loadState: "loaded",
      type: "service",
      restart: "on-failure",
      successExitStatus: "0 75",
      readAt: 42,
    });
  });

  test("missing properties stay empty strings so classify can call them unknown", () => {
    const f = parseSystemctlShow("LoadState=loaded\n", 7);
    expect(f.type).toBe("");
    expect(classifySupervision(f).kind).toBe("unknown");
  });
});
