// V2 的 permission 层：把「谁能执行什么」变成一组**可静态检查**的规则与判定。
//
// 背景（2026-11-05 实测）：OpenCode V2 只在 flags.opencodeUnsafeTools=true 时启动，
// 它忽略 node 安全策略、所有本地工具默认启用；而飞书的工具闸门挂在 claude 的
// PreToolUse hook 上，V2 的工具在 opencode server 里执行 ⇒ 那一层完全不生效。
//
// V2 自己的抓手是 permission 请求：把危险工具设成 ask，就有了**每回合**的拦截点。
// 本模块只做两件纯逻辑（不轮询、不发请求），因为把它们钉住才好在危险的那一半动手：
//   ① permissionRulesFor(mode)  —— 启动时该把哪些工具设成 ask
//   ② classifyPermission(item)  —— 一条请求到底要动哪个工具 / 属于哪一类
//
// 🔴 观测与执法必须分开：
//    observe（默认）规则同样设 ask，但**一律放行**并记录「本该拒绝什么」。
//    这样既有真实数据，又不会因为拦截逻辑有 bug 把节点卡死。
//    enforce 才真的按角色拒绝。

export type PermissionMode = "off" | "observe" | "enforce";

/**
 * 启动时写进 opencode config.permission 的规则。
 *
 * 只把**危险**工具设成 ask；Read/Glob/Grep 这类只读的不动 —— 全设 ask 会让
 * 每轮多出几十次往返，节点看起来就是"变慢了"，而那种慢没人能归因。
 */
export function permissionRulesFor(mode: PermissionMode): Record<string, "ask" | "allow"> {
  if (mode === "off") return {};
  return {
    bash: "ask",
    edit: "ask",
    write: "ask",
    patch: "ask",
    // 只读的显式 allow：即使上游默认变了，也不会因为"忘了写"而变成拦截。
    read: "allow",
    glob: "allow",
    grep: "allow",
  };
}

export interface PermissionClass {
  /** permission 请求里的 action（工具名或动作名）。 */
  action: string;
  /** 归一化后的类别，用于决定策略。 */
  kind: "shell" | "write" | "network" | "read" | "other";
}

const SHELL = /^(bash|shell|exec|run|command)/i;
const WRITE = /^(edit|write|patch|create|delete|remove|move|rename|apply)/i;
const NET = /^(fetch|web|http|curl|download|upload)/i;
const READ = /^(read|glob|grep|list|search|view)/i;

/** 把一条 permission 请求归到某一类。认不出就是 other（不猜）。 */
export function classifyPermission(action: string | undefined): PermissionClass {
  const a = typeof action === "string" ? action.trim() : "";
  if (!a) return { action: "", kind: "other" };
  if (SHELL.test(a)) return { action: a, kind: "shell" };
  if (WRITE.test(a)) return { action: a, kind: "write" };
  if (NET.test(a)) return { action: a, kind: "network" };
  if (READ.test(a)) return { action: a, kind: "read" };
  return { action: a, kind: "other" };
}

/**
 * 观测模式下这条请求**本该**怎么处理（用于日志与后续切 enforce 的判据）。
 *
 * 返回 "allow" 表示"按当前角色会放行"，"deny" 表示"切到 enforce 后会被拒"。
 */
export function observeVerdict(role: "guest" | "member" | "admin" | "unknown", action: string | undefined): "allow" | "deny" {
  const kind = classifyPermission(action).kind;
  // guest 只读：动手/联网的一律会拒；只读放行。
  if (role === "guest") return kind === "read" || kind === "other" ? "allow" : "deny";
  // 认不出的角色：fail-closed。
  if (role === "unknown") return kind === "read" ? "allow" : "deny";
  return "allow";
}
