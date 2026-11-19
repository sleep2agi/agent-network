// #4825 —— list_opencode_sessions 的调用门槛（负责人 2026-11-19 定）。
//
// 会话标题和目录本身就是敏感信息（能看出这台节点在做什么项目），所以门槛与 fork 一致：
//   owner / admin            → 任意节点
//   部门负责人（含子部门）    → 只能看自己管辖部门的节点
//   其余                     → 403
// 源节点没有部门时：只有 owner/admin 能看（部门负责人不猜）。
//
// 纯函数：调用方负责把 role / 部门关系查出来传进来，这里只做判定，
// 便于在没有 DB 的情况下把三种身份都钉住（之前 clone 的部门分支就是靠纯函数才测得住）。

export type SessionListVerdict = { ok: true } | { ok: false; error: "insufficient_role_for_list_sessions"; required_role: "admin" };

export function canListOpencodeSessions(input: {
  role: string | null;
  targetDepartmentId: string | null;
  managesTargetDepartment: boolean;
}): SessionListVerdict {
  const { role, targetDepartmentId, managesTargetDepartment } = input;
  if (role === "owner" || role === "admin") return { ok: true };
  // 部门负责人：目标节点必须有部门，且该部门在自己管辖范围（含子部门）
  if (targetDepartmentId && managesTargetDepartment) return { ok: true };
  return { ok: false, error: "insufficient_role_for_list_sessions", required_role: "admin" };
}
