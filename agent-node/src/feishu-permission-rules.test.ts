// permission 规则与分类的三条不变式：
//   ① off 一个都不设（默认不改变行为）
//   ② 只把危险工具设 ask，只读工具显式 allow（否则每轮几十次往返，节点"变慢"却无法归因）
//   ③ 观测模式不拦，但必须能算出"切 enforce 后会拒什么"
import { describe, expect, test } from "bun:test";
import { classifyPermission, observeVerdict, permissionRulesFor } from "./feishu-permission-rules";

describe("启动规则", () => {
  test("off ⇒ 完全不设（默认=今天的行为）", () => {
    expect(permissionRulesFor("off")).toEqual({});
  });

  test("observe 与 enforce 规则相同（先观测后执法，规则不该变）", () => {
    expect(permissionRulesFor("observe")).toEqual(permissionRulesFor("enforce"));
  });

  test("危险工具 ask，只读工具显式 allow", () => {
    const r = permissionRulesFor("enforce");
    for (const t of ["bash", "edit", "write", "patch"]) expect(r[t]).toBe("ask");
    for (const t of ["read", "glob", "grep"]) expect(r[t]).toBe("allow");
  });
});

describe("请求分类", () => {
  test("shell / write / network / read 各自归类", () => {
    expect(classifyPermission("bash").kind).toBe("shell");
    expect(classifyPermission("edit").kind).toBe("write");
    expect(classifyPermission("webfetch").kind).toBe("network");
    expect(classifyPermission("read").kind).toBe("read");
  });

  test("认不出/空 ⇒ other，不猜", () => {
    expect(classifyPermission("something_new").kind).toBe("other");
    expect(classifyPermission(undefined).kind).toBe("other");
    expect(classifyPermission("").action).toBe("");
  });
});

describe("观测模式的判定（决定切 enforce 后会不会拒）", () => {
  test("guest：动手/联网会被拒，只读放行", () => {
    expect(observeVerdict("guest", "bash")).toBe("deny");
    expect(observeVerdict("guest", "edit")).toBe("deny");
    expect(observeVerdict("guest", "webfetch")).toBe("deny");
    expect(observeVerdict("guest", "read")).toBe("allow");
  });

  test("member / admin：一律放行（观测期不该产生噪音）", () => {
    for (const role of ["member", "admin"] as const) {
      expect(observeVerdict(role, "bash")).toBe("allow");
      expect(observeVerdict(role, "webfetch")).toBe("allow");
    }
  });

  test("认不出的角色：fail-closed（只读才放）", () => {
    expect(observeVerdict("unknown", "bash")).toBe("deny");
    expect(observeVerdict("unknown", "read")).toBe("allow");
  });

  test("other 类别在 guest 下放行 —— 认不出的动作不该被当危险动作拦", () => {
    expect(observeVerdict("guest", "something_new")).toBe("allow");
  });
});
