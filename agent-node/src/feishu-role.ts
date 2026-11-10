// RFC-020 权限层 —— 飞书用户不是"在或不在白名单"，而是**拿什么权限**。
//
// 现状（2026-11-03 之前）：access.json 只有
//     { allowFrom: [open_id...], allowChats: [chat_id...] }
// 即「在名单里 = 全工具、全能力」。两个真实后果：
//
//   1. 一进名单就等于拿到了整台机器的 Bash/Edit —— 而飞书是**外部用户**能触达的入口，
//      与 Hub 那边"操作者可信"的前提不同（见 feishu-tool-deny.ts 的 scope 说明）。
//   2. 想加一个"只能问、不能动"的同事，只能连同工具一起给；想收紧，只能把人删掉。
//
// 所以这里引入 role，三个档：
//
//   guest   只读问答：能 Read、能回话；不能 Bash/Edit/Write/执行任何东西
//   member  默认档（= 今天的行为）：全工具，但 layer B 仍会拦密钥/配置路径
//   admin   在 member 之上**允许**改通道自身配置（今天这条对所有人都是禁的；
//           但"改白名单"这件事本身需要有人能做，否则维护只能靠登机器手改）
//
// 不变式（缺一条这个模型就是装饰）：
//   · 没登记的人**不进**（准入仍由 access.json 的 allowFrom/allowChats 决定）
//   · 登记了但没给 role ⇒ defaultRole（默认 member，保持向后兼容）
//   · 认不出的 role 字符串 ⇒ 拒（不要静默降级成 member，那会把"打错字"变成"给了全权"）
//   · admin 只多"改通道配置"这一项，不额外多出别的工具权限

export const FEISHU_ROLES = ["guest", "member", "admin"] as const;
export type FeishuRole = (typeof FEISHU_ROLES)[number];

export interface FeishuAccessWithRoles {
  allowFrom?: string[];
  allowChats?: string[];
  /** open_id → 角色。只对**已准入**的人生效。 */
  users?: Record<string, { role?: string } | undefined>;
  /** 明确要求时把 role 显式写出来。 */
  defaultRole?: string;
  /** 任何角色都不会拿到的工具（运营可追加），与 role 取并集。 */
  denyTools?: string[];
}

/** 只读工具：guest 唯一能用的。 */
export const GUEST_TOOLS = new Set<string>(["Read", "Glob", "Grep"]);

/** 只有 admin 才允许碰的工具（改通道自身配置需要 Write/Edit 落到 channels 目录）。 */
export const ADMIN_ONLY_CAPABILITY = "channel-config-write";

export type RoleResolution =
  | { ok: true; role: FeishuRole; reason: "explicit" | "default" }
  | { ok: false; error: "unknown_role"; value: string };

/**
 * 把 access.json 里的 role 解析成闭集内的值。
 *
 * 关键决定：**认不出的 role 直接拒**。静默回落成 member 会让一次拼写错误
 * （"admn"）变成一次授权升级 —— 而这种错误不会有人报错，只会一直生效。
 */
export function resolveDeclaredRole(raw: string | undefined, fallback: string | undefined): RoleResolution {
  const pick = (v: string) => {
    const s = v.trim().toLowerCase();
    return (FEISHU_ROLES as readonly string[]).includes(s) ? (s as FeishuRole) : null;
  };
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const role = pick(String(raw));
    return role ? { ok: true, role, reason: "explicit" } : { ok: false, error: "unknown_role", value: String(raw) };
  }
  if (fallback !== undefined && fallback !== null && String(fallback).trim() !== "") {
    const role = pick(String(fallback));
    return role ? { ok: true, role, reason: "default" } : { ok: false, error: "unknown_role", value: String(fallback) };
  }
  // 没写 defaultRole ⇒ member：与 2026-11-03 之前的行为逐字一致。
  return { ok: true, role: "member", reason: "default" };
}

/**
 * 这个发件人在这个会话里是什么角色。
 *
 * 注意：准入（是不是白名单里的人）不在这里判 —— 那是 bridge 的 allowFrom/allowChats。
 * 本函数只在**已经准入**之后回答"给多少"。
 */
export function roleForSender(access: FeishuAccessWithRoles, senderId: string | undefined): RoleResolution {
  const users = access.users ?? {};
  const entry = senderId ? users[senderId] : undefined;
  return resolveDeclaredRole(entry?.role, access.defaultRole);
}

/**
 * 这个角色允许用哪些工具（deny 形式，便于与现有 tool-deny 层合并）。
 *
 * 返回「这个角色**不能**用的工具名单」：
 *   guest  → 除 GUEST_TOOLS 之外全禁（用 null 表示"除白名单外全禁"）
 *   member → 禁 admin 专属能力对应的工具（Write/Edit 落 channels）—— 由调用方按路径判，
 *            这里只给工具级；路径级仍走 layer B
 *   admin  → 不额外禁
 */
export function deniedToolsForRole(role: FeishuRole): { denyAllExcept?: ReadonlySet<string>; deny: ReadonlySet<string> } {
  switch (role) {
    case "guest":
      return { denyAllExcept: GUEST_TOOLS, deny: new Set() };
    case "member":
      return { deny: new Set() };
    case "admin":
      return { deny: new Set() };
  }
}

export type InboundDecision =
  | { action: "allow"; role: FeishuRole }
  | { action: "refuse"; role: FeishuRole; reply: string };

/**
 * 这条入站消息该不该进 think()。
 *
 * 为什么需要它：**OpenCode V2 上「guest 只读」是一句没有执行者的规则** ——
 * V2 只在 flags.opencodeUnsafeTools=true 时允许跑（opencode-versions.ts 的注释写着：
 * 它忽略 node 安全策略，所有本地工具都会启用），而飞书那层工具闸门挂在 claude 的
 * PreToolUse hook 上，工具在 opencode server 里执行时根本不过那里。
 *
 * ⇒ fail-closed：V2 上不提供 guest 档。与其给一个"看起来只读、实际能跑 bash"的档，
 *    不如明确拒绝并说清下一步。等 permission 应答（见卡）实现后再放开。
 */
export function decideFeishuInbound(
  role: FeishuRole,
  opts: { opencodeGeneration?: string | null },
): InboundDecision {
  if (role === "guest" && opts.opencodeGeneration === "v2") {
    return {
      action: "refuse",
      role,
      reply: "[权限] 这个节点跑在 OpenCode V2 上，目前无法执行「只读来宾」限制；"
        + "V2 会启用全部本地工具，且不支持按回合收窄。"
        + "请联系管理员把你提升为 member（或把节点换成 V1）后再试。",
    };
  }
  return { action: "allow", role };
}

/** V2 的 permission 应答取值（来自 opencode 的 Permission.Reply）。 */
export type PermissionReply = "once" | "always" | "reject";

/**
 * 这一回合的角色，遇到一条 permission 请求，该回什么。
 *
 * 🔴 **永不返回 `always`**。`always` 会把这次决定**持久化**成一条规则，
 * 于是它跨回合、跨角色生效 —— 一个 guest 在这一轮被允许的工具，
 * 下一轮换个身份来的人也能用。授权一旦被持久化，就再也没人知道它当初是给谁的。
 *
 * 因此：member/admin ⇒ `once`（只放行这一次）；guest ⇒ `reject`；
 * 认不出的角色 ⇒ `reject`（fail-closed）。
 */
export function decidePermissionReply(role: FeishuRole | "unknown"): PermissionReply {
  if (role === "member" || role === "admin") return "once";
  return "reject";
}

/** 拒绝时给用户看的一句话（够具体，不暴露内部路径/凭据）。 */
export function permissionDenyNotice(role: FeishuRole | "unknown", action: string): string {
  if (role === "guest") {
    return `[权限] 这个工具调用（${action}）超出「只读来宾」的范围，已拒绝。如需执行，请联系管理员提升你的角色。`;
  }
  return `[权限] 无法确认发起者的角色，按 fail-closed 拒绝了这次工具调用（${action}）。`;
}
