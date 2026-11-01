// #3146 —— 客户端「切模型」失败时，Hub 明明已经知道原因，界面上却只显示「90s 内没回来，
// 请到机器上看日志」。
//
// 原因不是客户端乱写：`GET /api/nodes/:id/config` 原来只回 config_revision / model / flags /
// config_update_capable —— 没有一处能读到**上一次下发的结局**。于是客户端只能靠
// 「revision 有没有涨」推断，涨不了就只能是 timeout。而生产上（2026-11-01 通信欧）
// 真实结局是 rejected，Hub 库里写着：
//
//     status = 'rejected'
//     error  = 'OpenCode V2 session is not running; model was not changed'
//     acked_at 也写了
//
// —— 一条「答案已经在库里、但读者拿不到」的缺口。
//
// 这个模块只做**投影**：把 node_config_updates 最近一行翻译成客户端能直接渲染的形状。
// 三条规矩：
//   ① 状态是闭集。不在表里的值报 unknown 并把原值带出去（不折叠成最乐观的那一档）。
//   ② 时间列是 **TEXT 存 ms epoch**，不是 hub 那种无时区标记的字符串；解析不出就 null，
//      不允许出现 "Invalid Date"。
//   ③ 不投影 `created_by_token`：那是凭据标识，不是界面信息。

export const CONFIG_UPDATE_STATUSES = ["pending", "restarting", "applied", "rejected", "timeout"] as const;
export type ConfigUpdateStatus = (typeof CONFIG_UPDATE_STATUSES)[number];

/** 闭集显式映射。pending/restarting 是「还在路上」，其余三个是终点。 */
const TERMINAL: Record<ConfigUpdateStatus, boolean> = {
  pending: false,
  restarting: false,
  applied: true,
  rejected: true,
  timeout: true,
};

export interface LastConfigUpdate {
  update_id: string;
  /** 闭集内就是它自己；闭集外是 `unknown`（并把原值放在 observed_status）。 */
  status: ConfigUpdateStatus | "unknown";
  /** 原始 status 字符串（永远给，便于排查；闭集内与 status 相同）。 */
  observed_status: string;
  /** 已知是终点才 true；unknown 一律 false —— 「不知道结没结束」不等于「结束了」。 */
  terminal: boolean;
  /** 这次下发要的模型（来自 patch_json.model）；patch 里没有就是 null。 */
  requested_model: string | null;
  /** 节点自报的失败原因（rejected/timeout 才有；applied 是 null）。 */
  error: string | null;
  /** ISO；TEXT 存的是 ms epoch，转不出来就是 null。 */
  created_at: string | null;
  acked_at: string | null;
}

type Row = {
  update_id: string;
  status: string;
  patch_json: string | null;
  error: string | null;
  created_at: string | number | null;
  acked_at: string | number | null;
};

/** ms epoch（TEXT 或数字）→ ISO。非有限数、非正数一律 null。 */
function msToIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/** patch_json 里的 model。解析失败或没有 model ⇒ null（不猜）。 */
function requestedModel(patchJson: string | null): string | null {
  if (!patchJson) return null;
  try {
    const parsed = JSON.parse(patchJson) as { model?: unknown };
    return typeof parsed?.model === "string" && parsed.model ? parsed.model : null;
  } catch {
    return null;
  }
}

/** 纯函数：一行 → 对外形状。抽出来是为了能单独钉住「闭集外不折叠」那条。 */
export function projectLastConfigUpdate(row: Row): LastConfigUpdate {
  const observed = typeof row.status === "string" ? row.status : "";
  const known = (CONFIG_UPDATE_STATUSES as readonly string[]).includes(observed);
  return {
    update_id: row.update_id,
    status: known ? (observed as ConfigUpdateStatus) : "unknown",
    observed_status: observed,
    terminal: known ? TERMINAL[observed as ConfigUpdateStatus] : false,
    requested_model: requestedModel(row.patch_json),
    error: typeof row.error === "string" && row.error ? row.error : null,
    created_at: msToIso(row.created_at),
    acked_at: msToIso(row.acked_at),
  };
}

export const LAST_CONFIG_UPDATE_SQL =
  `SELECT update_id, status, patch_json, error, created_at, acked_at
     FROM node_config_updates WHERE node_id = ?1
    ORDER BY created_at DESC, rowid DESC LIMIT 1`;

/** 读这个节点最近一次配置下发。从未下发过 ⇒ null（不是空对象：两者在界面上不同）。 */
export function readLastConfigUpdate(
  get: (sql: string, ...params: any[]) => Row | null,
  nodeId: string,
): LastConfigUpdate | null {
  const row = get(LAST_CONFIG_UPDATE_SQL, nodeId);
  return row ? projectLastConfigUpdate(row) : null;
}
