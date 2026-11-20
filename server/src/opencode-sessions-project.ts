// #4821 —— 把 OpenCode V2 `GET /api/session` 的原始条目投影成 Hub 对外形状。
//
// 事实来源（通信客户端欧 2026-11-20 在真节点实测）：端点 GET /api/session，分页 ?cursor=；
// 顶层形状 { data: [...], cursor: { previous, next } }；空列表是 { data: [], cursor: {...} }（不是裸 []）。
// 原始字段：id / fork{...} / projectID / agent / model{id,providerID,variant} / cost /
//          tokens{...} / outcome / time{created,updated,idle,viewed}（**epoch ms**）/ title / location{directory}
//
// 投影原则：
//   · 只暴露 App 用得到的六个字段，不把 OpenCode 原始结构透出去（未来它改字段不会烧到 UI）；
//   · 时间统一 epoch ms → ISO-8601 UTC（与 /api/inbox 的 at 同口径）；
//   · cursor 对 App 是 opaque：只透传 next，不解析、不重编码。

export type HubSession = {
  id: string;
  title: string;
  project_id: string | null;
  model: { provider: string; id: string; variant?: string } | null;
  updated_at: string;
  directory: string | null;
};

export function isoFromEpochMs(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function projectSession(raw: any): HubSession | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  const m = raw.model && typeof raw.model === "object" ? raw.model : null;
  const provider = typeof m?.providerID === "string" ? m.providerID : null;
  const modelId = typeof m?.id === "string" ? m.id : null;
  const variant = typeof m?.variant === "string" && m.variant ? m.variant : undefined;
  const loc = raw.location && typeof raw.location === "object" ? raw.location : null;
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    project_id: typeof raw.projectID === "string" ? raw.projectID : null,
    model: provider && modelId ? { provider, id: modelId, ...(variant ? { variant } : {}) } : null,
    updated_at: isoFromEpochMs(raw?.time?.updated) ?? isoFromEpochMs(raw?.time?.created) ?? "",
    directory: typeof loc?.directory === "string" ? loc.directory : null,
  };
}

/** 只读投影整页；`data` 不是数组时返回空页（不抛，避免把上游形状变化变成 500）。 */
export function projectSessionPage(raw: any): { sessions: HubSession[]; next_cursor: string | null } {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  const sessions = data.map(projectSession).filter((s: HubSession | null): s is HubSession => !!s);
  const next = raw?.cursor?.next;
  return { sessions, next_cursor: typeof next === "string" && next ? next : null };
}
