// 2026-10-31 —— 上报快照里的 systemd 三格。
//
// 四条断言：
//   ① 认不出自身 unit ⇒ unknown（不是 not_supervised）
//   ② reader 抛错 ⇒ unknown（读不到 ≠ 不受托管）
//   ③ not-found / Restart=no ⇒ not_supervised，且各带自己的 reason
//   ④ on-failure + SuccessExitStatus=75 ⇒ supervised 但 respawns_on_exit75=false

import { describe, expect, test } from "bun:test";
import { detectOwnUnitName, systemdSupervisionSnapshot } from "./systemd-supervision-snapshot";
import type { UnitFacts } from "./systemd-unit-facts";

const cgroup = (path: string) => `0::${path}\n`;

const facts = (over: Partial<UnitFacts> = {}): UnitFacts => ({
  loadState: "loaded",
  type: "service",
  restart: "always",
  successExitStatus: "",
  readAt: 0,
  ...over,
});

describe("detectOwnUnitName", () => {
  test("finds a .service unit", () => {
    expect(detectOwnUnitName(cgroup("/system.slice/anet-node.service"))).toBe("anet-node.service");
  });
  test("finds a .scope (pm2 / login session) — the name is still usable, the verdict is not decided here", () => {
    expect(detectOwnUnitName(cgroup("/user.slice/user-1000.slice/session-3.scope"))).toBe("session-3.scope");
  });
  test("returns null when no segment looks like a unit", () => {
    expect(detectOwnUnitName(cgroup("/"))).toBeNull();
    expect(detectOwnUnitName("")).toBeNull();
  });
});

describe("systemdSupervisionSnapshot", () => {
  test("unidentifiable unit ⇒ unknown with its own reason (never not_supervised)", () => {
    const s = systemdSupervisionSnapshot({ cgroupText: "0::/\n" });
    expect(s).toEqual({
      systemd_supervision: "unknown",
      systemd_supervision_knob: null,
      systemd_supervision_reason: "missing:own_unit_not_identifiable",
      respawns_on_exit75: null,
    });
  });

  test("reader throwing ⇒ unknown — 'cannot read' must not become 'not supervised'", () => {
    const s = systemdSupervisionSnapshot({
      cgroupText: cgroup("/system.slice/anet-node.service"),
      reader: () => { throw new Error("systemctl: not found"); },
    });
    expect(s.systemd_supervision).toBe("unknown");
    // reason 带 missing: 前缀 —— 它只回答「为什么判不出来」
    expect(s.systemd_supervision_reason).toBe("missing:unit_facts_unavailable");
    expect(s.systemd_supervision_knob).toBeNull();
    expect(s.respawns_on_exit75).toBeNull();
  });

  test("LoadState=not-found ⇒ not_supervised(load_state:not-found)", () => {
    const s = systemdSupervisionSnapshot({
      cgroupText: cgroup("/system.slice/x.service"),
      reader: () => facts({ loadState: "not-found" }),
    });
    expect(s).toMatchObject({
      systemd_supervision: "not_supervised",
      systemd_supervision_knob: "load_state:not-found",
      systemd_supervision_reason: null,
      respawns_on_exit75: false,
    });
  });

  test("Restart=no ⇒ not_supervised(restart_no)", () => {
    const s = systemdSupervisionSnapshot({
      cgroupText: cgroup("/system.slice/x.service"),
      reader: () => facts({ restart: "no" }),
    });
    expect(s).toMatchObject({ systemd_supervision: "not_supervised", systemd_supervision_knob: "restart_no" });
  });

  test("on-failure + SuccessExitStatus=75 ⇒ supervised, but exit75 will NOT respawn", () => {
    const s = systemdSupervisionSnapshot({
      cgroupText: cgroup("/system.slice/x.service"),
      reader: () => facts({ restart: "on-failure", successExitStatus: "0 75" }),
    });
    expect(s.systemd_supervision).toBe("supervised");
    expect(s.respawns_on_exit75).toBe(false);
  });

  test("always ⇒ supervised and exit75 respawns", () => {
    const s = systemdSupervisionSnapshot({
      cgroupText: cgroup("/system.slice/x.service"),
      reader: () => facts({ restart: "always" }),
    });
    expect(s).toMatchObject({ systemd_supervision: "supervised", respawns_on_exit75: true });
  });

  test("unknown Restart= value ⇒ supervised but respawn undecidable (null, not false)", () => {
    const s = systemdSupervisionSnapshot({
      cgroupText: cgroup("/system.slice/x.service"),
      reader: () => facts({ restart: "on-abnormal" }),
    });
    expect(s.systemd_supervision).toBe("supervised");
    expect(s.respawns_on_exit75).toBeNull();
    expect(s.systemd_supervision_knob).toBe("respawn_undecidable");
  });
});
