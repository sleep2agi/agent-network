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
  /** 这次下发要的思考档位（来自 patch_json.modelVariant）；patch 里没有就是 null。 */
  requested_variant: string | null;
  /**
   * #4499 —— 「排队后被应用」是**推断**出来的，不是节点回报的：
   * 原来 ack 是 rejected/variant_busy，之后节点把排队的档位应用上了，回读档位 == 请求值。
   * 这种情况下 status 投影成 applied（因为它确实生效且回读一致），但这里留 true 便于排查；
   * observed_status 仍然保留原始的 rejected。应用窗口外的、或回读对不上的，一律 false。
   */
  resolved_after_queue: boolean;
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

/**
 * patch_json 里的思考档位（`modelVariant`）。
 *
 * 三种「没要档位」必须分开，不能都折叠成 null：
 *   · patch 里**没有** modelVariant 这个键 ⇒ undefined（这次下发与档位无关）
 *   · patch 里是 `null` / `"default"`        ⇒ null（**明确要求清空**回默认）
 *   · patch 里是字符串                        ⇒ 原样
 */
function requestedVariant(patchJson: string | null): string | null | undefined {
  if (!patchJson) return undefined;
  try {
    const parsed = JSON.parse(patchJson) as { modelVariant?: unknown };
    if (!Object.prototype.hasOwnProperty.call(parsed, "modelVariant")) return undefined;
    const v = (parsed as { modelVariant?: unknown }).modelVariant;
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v === "default" ? null : v;
    return undefined;
  } catch {
    return undefined;
  }
}

/** #4499 —— 排队应用的时间窗。超过这个窗口就不再假设「它后来生效了」。 */
export const QUEUED_VARIANT_WINDOW_MS = 15 * 60 * 1000;

/** ack 的原因是「档位忙」吗？只认节点自己写的 `variant_busy`（后面可能带细节）。 */
function isVariantBusy(error: string | null): boolean {
  return typeof error === "string" && /^variant_busy\b/.test(error);
}

/** 纯函数：一行 → 对外形状。抽出来是为了能单独钉住「闭集外不折叠」那条。 */
export function projectLastConfigUpdate(
  row: Row,
  ctx: { currentVariant?: string | null; nowMs?: number } = {},
): LastConfigUpdate {
  const observed = typeof row.status === "string" ? row.status : "";
  const known = (CONFIG_UPDATE_STATUSES as readonly string[]).includes(observed);
  const reqVariant = requestedVariant(row.patch_json);

  // #4499：rejected/variant_busy 之后，节点把排队的档位应用上了。
  // 判据三条同时成立才算（缺一条都保持 rejected，绝不把「排队中」冒充 applied）：
  //   ① ack 原因是 variant_busy；② patch 里确实要了档位；③ 节点当前回读的档位 == 请求值。
  // 另外加一条时间窗：太久以前的下发即使值巧合相等也不算（那是另一件事）。
  let resolvedAfterQueue = false;
  if (known && observed === "rejected" && isVariantBusy(row.error) && reqVariant !== undefined) {
    const nowMs = ctx.nowMs ?? Date.now();
    const createdMs = Number(row.created_at);
    const inWindow =
      Number.isFinite(createdMs) && createdMs > 0 &&
      nowMs >= createdMs && nowMs - createdMs <= QUEUED_VARIANT_WINDOW_MS;
    const current = ctx.currentVariant === undefined ? undefined : ctx.currentVariant === "default" ? null : ctx.currentVariant;
    const requested = reqVariant === null ? null : reqVariant;
    if (inWindow && current !== undefined && current === requested) resolvedAfterQueue = true;
  }

  const effectiveStatus = resolvedAfterQueue ? "applied" : known ? (observed as ConfigUpdateStatus) : "unknown";

  return {
    update_id: row.update_id,
    status: effectiveStatus,
    observed_status: observed,
    terminal: resolvedAfterQueue ? true : known ? TERMINAL[observed as ConfigUpdateStatus] : false,
    requested_model: requestedModel(row.patch_json),
    requested_variant: reqVariant === undefined ? null : reqVariant,
    resolved_after_queue: resolvedAfterQueue,
    error: resolvedAfterQueue ? null : typeof row.error === "string" && row.error ? row.error : null,
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
  ctx: { currentVariant?: string | null; nowMs?: number } = {},
): LastConfigUpdate | null {
  const row = get(LAST_CONFIG_UPDATE_SQL, nodeId);
  return row ? projectLastConfigUpdate(row, ctx) : null;
}
