// #5125 —— fork 向导要显示「与源节点共用目录 {path}」，但 /api/nodes 里没有工作目录。
//
// 口径（负责人 2026-11-19 定稿）：**两个字段**，不要用一个 null 装两种含义。
//   reported     有权查看且节点上报了真实项目目录 → workdir 有值
//   not_reported 有权查看但节点还没上报        → workdir 为 null
//   forbidden    无权查看                      → workdir 为 null，且不返回任何额外信息
//                （不泄露路径、不泄露是否存在 —— 所以这里连 state 的其它线索都不给）
//
// 为什么要分三种：`not_reported` 是「节点旧、还没升级」，`forbidden` 是「你不该看」。
// 前者运维要去升级节点，后者要去申请权限 —— 修法相反，压成一个 null 会把两种都诊断错。

export type WorkdirState = "reported" | "not_reported" | "forbidden";

/** 从 config_snapshot 里读节点上报的工作目录；没有/形状不对 ⇒ null（不猜）。 */
export function readReportedWorkdir(parsed: any): string | null {
  const candidates = [parsed?.flags?.workdir, parsed?.flags?.cwd, parsed?.workdir];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const v = c.trim();
    if (!v || v.length > 4096 || /[\0\r\n]/.test(v)) continue;
    return v;
  }
  return null;
}

export function workdirProjection(
  canView: boolean,
  reported: string | null,
): { workdir: string | null; workdir_state: WorkdirState } {
  if (!canView) return { workdir: null, workdir_state: "forbidden" };
  return reported
    ? { workdir: reported, workdir_state: "reported" }
    : { workdir: null, workdir_state: "not_reported" };
}
