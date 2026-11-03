// 飞书用户权限：**不是"在不在名单"，是"拿多少"**。
//
// 为什么值得单独钉：权限模型的 bug 不会报错 —— 它只会让某个本该只读的人
// 拿到 Bash。而"拼错一个 role 就静默变成 member"正是这类 bug 的经典形态。
import { describe, expect, test } from "bun:test";
import {
  FEISHU_ROLES,
  GUEST_TOOLS,
  decideFeishuInbound,
  decidePermissionReply,
  deniedToolsForRole,
  permissionDenyNotice,
  resolveDeclaredRole,
  roleForSender,
} from "./feishu-role";

describe("role 解析：闭集，认不出就拒", () => {
  test("显式 role 生效", () => {
    expect(resolveDeclaredRole("guest", undefined)).toEqual({ ok: true, role: "guest", reason: "explicit" });
    expect(resolveDeclaredRole("ADMIN ", undefined)).toEqual({ ok: true, role: "admin", reason: "explicit" });
  });

  test("没写 role ⇒ defaultRole", () => {
    expect(resolveDeclaredRole(undefined, "guest")).toEqual({ ok: true, role: "guest", reason: "default" });
  });

  test("都没有 ⇒ member（与 2026-11-03 之前逐字一致）", () => {
    expect(resolveDeclaredRole(undefined, undefined)).toEqual({ ok: true, role: "member", reason: "default" });
    expect(resolveDeclaredRole("", "")).toEqual({ ok: true, role: "member", reason: "default" });
  });

  test("🔴 拼错的 role 必须拒，不许静默降级成 member（那会把打错字变成授权升级）", () => {
    for (const bad of ["admn", "root", "owner", "gues", "member;admin"]) {
      const r = resolveDeclaredRole(bad, undefined);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toBe("unknown_role");
    }
  });

  test("两端空白容忍（配置文件里常见），但**拼写**不容忍", () => {
    expect((resolveDeclaredRole(" guest ", undefined) as any).role).toBe("guest");
    expect(resolveDeclaredRole(" gues ", undefined).ok).toBe(false);
  });

  test("defaultRole 打错字同样拒（否则整份配置的默认档被悄悄改成 member）", () => {
    expect(resolveDeclaredRole(undefined, "guesst").ok).toBe(false);
  });
});

describe("按发件人取角色", () => {
  const access = {
    allowFrom: ["ou_admin", "ou_guest", "ou_plain"],
    users: { ou_admin: { role: "admin" }, ou_guest: { role: "guest" } },
  };

  test("登记了 role 的人拿到自己的档", () => {
    expect((roleForSender(access, "ou_admin") as any).role).toBe("admin");
    expect((roleForSender(access, "ou_guest") as any).role).toBe("guest");
  });

  test("在白名单但没登记 role ⇒ defaultRole（未写则 member）", () => {
    expect((roleForSender(access, "ou_plain") as any).role).toBe("member");
    expect((roleForSender({ ...access, defaultRole: "guest" }, "ou_plain") as any).role).toBe("guest");
  });

  test("根本没有 users 段 ⇒ 全员 member（老配置不用改就能跑）", () => {
    expect((roleForSender({ allowFrom: ["ou_plain"] }, "ou_plain") as any).role).toBe("member");
  });

  test("没有发件人 id ⇒ 走默认档，不崩", () => {
    expect((roleForSender(access, undefined) as any).role).toBe("member");
  });
});

describe("角色能力：guest 只读", () => {
  test("guest ⇒ 除 Read/Glob/Grep 之外全禁", () => {
    const rule = deniedToolsForRole("guest");
    expect(rule.denyAllExcept).toBe(GUEST_TOOLS);
    // 镜像肯定断言：白名单里确实是这三个，多一个都算扩权。
    expect([...GUEST_TOOLS].sort()).toEqual(["Glob", "Grep", "Read"]);
  });

  test("member / admin 不额外禁（路径级仍由 layer B 管）", () => {
    expect(deniedToolsForRole("member").denyAllExcept).toBeUndefined();
    expect(deniedToolsForRole("admin").denyAllExcept).toBeUndefined();
  });

  test("闭集齐全：每个 role 都有定义（加档时忘了实现会在这里红）", () => {
    for (const role of FEISHU_ROLES) {
      expect(deniedToolsForRole(role)).toBeDefined();
    }
  });
});

describe("#3682 fail-closed：V2 上没有可执行的「只读来宾」", () => {
  test("V2 + guest ⇒ 拒绝，且回复里说清原因与下一步", () => {
    const d = decideFeishuInbound("guest", { opencodeGeneration: "v2" });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.reply).toContain("OpenCode V2");
      expect(d.reply).toContain("member");
    }
  });

  test("镜像肯定：同一档在 V1 上放行（否则等于把功能整个砍掉）", () => {
    expect(decideFeishuInbound("guest", { opencodeGeneration: "v1" }).action).toBe("allow");
    expect(decideFeishuInbound("guest", { opencodeGeneration: undefined }).action).toBe("allow");
  });

  test("member / admin 在 V2 上照常放行（拒绝只针对没有执行者的那一档）", () => {
    expect(decideFeishuInbound("member", { opencodeGeneration: "v2" }).action).toBe("allow");
    expect(decideFeishuInbound("admin", { opencodeGeneration: "v2" }).action).toBe("allow");
  });
});

describe("#3682 V2 permission 应答：只放行一次，绝不持久化", () => {
  test("member / admin ⇒ once（只放行这一次）", () => {
    expect(decidePermissionReply("member")).toBe("once");
    expect(decidePermissionReply("admin")).toBe("once");
  });

  test("guest ⇒ reject（只读档不许执行工具）", () => {
    expect(decidePermissionReply("guest")).toBe("reject");
  });

  test("认不出的角色 ⇒ reject（fail-closed，不因为认不出就给权限）", () => {
    expect(decidePermissionReply("unknown")).toBe("reject");
  });

  test("🔴 任何角色都不许返回 always —— 那会把这次决定持久化成跨回合、跨身份的规则", () => {
    const roles = [...FEISHU_ROLES, "unknown"] as const;
    for (const role of roles) {
      expect(decidePermissionReply(role), role).not.toBe("always");
    }
  });

  test("拒绝文案：guest 与「认不出」要能区分（两者修法不同）", () => {
    expect(permissionDenyNotice("guest", "bash")).toContain("只读来宾");
    expect(permissionDenyNotice("unknown", "bash")).toContain("无法确认");
  });
});
