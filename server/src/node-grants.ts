// 节点管理授权（admin 2026-11-11「节点的权限要好好设计：某些节点可以有管理员权限去编辑定时任务、管表，
// 也可以只管某个部门下的」）。
//
// 模型 = 能力 × 范围 × 级别，按行存在 node_grants：
//   capability  schedules（第一期）；board（第二期：等 requirements 判定和看板工具一起上线时开放）
//   scope_kind  network（整个网络，scope_id = ""）| department（该部门及全部下级，scope_id = department_id）
//               | node（单个节点，scope_id = node_id）
//   level       read（只看）| edit（看 + 改）
//
// 判定（只加不减）：授权只**追加**节点能看 / 能改的东西，从不收回现有规则（节点自己建的 / 发给自己的计划照旧）。
//   • 定时任务按**目标节点**判范围：network 全部；department 看目标节点 nodes.department_id 是否在该部门子树里；
//     node 看 target_node_id。
//   • 节点 permission_mode = readonly 时，edit 授权降为 read（只读节点永远不能改）。
//   • 撤销 = 删行，下一次请求立即生效（不缓存）。
//
// 谁能授权（REST PUT /api/nodes/:id/grants）：网络 owner / admin 与 Hub 管理员可授任意范围；
// 部门负责人只能授自己负责的子树里的 department / node 范围（不能授 network）。
import { db } from "./db.js";
import { departmentCardsFor, departmentSubtree, isDepartmentCard } from "./department-heads.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS node_grants (
    network_id  TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    capability  TEXT NOT NULL,
    scope_kind  TEXT NOT NULL,
    scope_id    TEXT NOT NULL DEFAULT '',
    level       TEXT NOT NULL,
    granted_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, node_id, capability, scope_kind, scope_id)
  );
  CREATE INDEX IF NOT EXISTS idx_node_grants_node ON node_grants(node_id);
`);

export const GRANT_CAPABILITIES = ["schedules"] as const;
// 第二期（board）：能力定义与判定已写好，但**暂不开闸** —— 等 requirements 读写判定 + 看板工具
// 在同一个 PR 里一起上（否则「能授、能存、但不起作用」，看起来像生效了）。
export const GRANT_CAPABILITIES_PLANNED = ["board"] as const;
export type GrantCapability = (typeof GRANT_CAPABILITIES)[number];
export type GrantScopeKind = "network" | "department" | "node";
export type GrantLevel = "read" | "edit";
export type NodeGrant = { capability: GrantCapability; scope_kind: GrantScopeKind; scope_id: string; level: GrantLevel };
export type StoredNodeGrant = NodeGrant & { granted_by: string | null; created_at: string };

export const MAX_GRANTS_PER_NODE = 50;

export function listNodeGrants(networkId: string, nodeId: string): StoredNodeGrant[] {
  return db.all<StoredNodeGrant>(
    "SELECT capability, scope_kind, scope_id, level, granted_by, created_at FROM node_grants WHERE network_id = ?1 AND node_id = ?2 ORDER BY capability, scope_kind, scope_id",
    networkId, nodeId,
  );
}

export type GrantValidation = { ok: true; grants: NodeGrant[] } | { ok: false; error: string; index?: number; message: string };

/** 解析 + 校验一整份授权名单（PUT 是整份替换）。部门 / 节点必须属于这个网络。 */
export function parseNodeGrants(networkId: string, raw: unknown): GrantValidation {
  if (!Array.isArray(raw)) return { ok: false, error: "invalid_grants", message: "grants must be an array (use [] to clear)" };
  if (raw.length > MAX_GRANTS_PER_NODE) return { ok: false, error: "too_many_grants", message: `at most ${MAX_GRANTS_PER_NODE} grants per node` };
  const out: NodeGrant[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const g = raw[i] as Record<string, unknown> | null;
    if (!g || typeof g !== "object") return { ok: false, error: "invalid_grant", index: i, message: "each grant is an object" };
    const capability = g.capability;
    if ((GRANT_CAPABILITIES_PLANNED as readonly unknown[]).includes(capability)) {
      return { ok: false, error: "capability_not_supported", index: i, message: `capability ${String(capability)} is planned but not available on this Hub yet` };
    }
    if (!(GRANT_CAPABILITIES as readonly unknown[]).includes(capability)) return { ok: false, error: "invalid_capability", index: i, message: `capability must be one of ${GRANT_CAPABILITIES.join(", ")}` };
    const kind = g.scope_kind;
    if (kind !== "network" && kind !== "department" && kind !== "node") return { ok: false, error: "invalid_scope_kind", index: i, message: "scope_kind must be network, department or node" };
    const scopeId = kind === "network" ? "" : typeof g.scope_id === "string" ? g.scope_id.trim() : "";
    if (kind === "department" && !db.get("SELECT 1 AS ok FROM network_departments WHERE network_id = ?1 AND department_id = ?2", networkId, scopeId)) {
      return { ok: false, error: "department_not_found", index: i, message: "scope_id must be a department of this network" };
    }
    if (kind === "node" && !db.get("SELECT 1 AS ok FROM nodes WHERE network_id = ?1 AND node_id = ?2", networkId, scopeId)) {
      return { ok: false, error: "node_not_found", index: i, message: "scope_id must be a node of this network" };
    }
    const level = g.level ?? "edit";
    if (level !== "read" && level !== "edit") return { ok: false, error: "invalid_level", index: i, message: "level must be read or edit" };
    const key = `${capability}|${kind}|${scopeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ capability: capability as GrantCapability, scope_kind: kind, scope_id: scopeId, level });
  }
  return { ok: true, grants: out };
}

export function replaceNodeGrants(networkId: string, nodeId: string, grants: NodeGrant[], actorUserId: string | null): void {
  db.transaction(() => {
    db.run("DELETE FROM node_grants WHERE network_id = ?1 AND node_id = ?2", [networkId, nodeId]);
    for (const g of grants) {
      db.run(
        "INSERT INTO node_grants (network_id, node_id, capability, scope_kind, scope_id, level, granted_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [networkId, nodeId, g.capability, g.scope_kind, g.scope_id, g.level, actorUserId],
      );
    }
  });
}

export function deleteNodeGrants(nodeId: string): void {
  db.run("DELETE FROM node_grants WHERE node_id = ?1 OR (scope_kind = 'node' AND scope_id = ?1)", [nodeId]);
}

/** 部门负责人能授的：只能是自己负责子树里的 department / node 范围。 */
export function grantsWithinManaged(networkId: string, grants: NodeGrant[], managed: ReadonlySet<string>): boolean {
  for (const g of grants) {
    if (g.scope_kind === "network") return false;
    if (g.scope_kind === "department" && !managed.has(g.scope_id)) return false;
    if (g.scope_kind === "node") {
      const dept = db.get<{ department_id: string | null }>("SELECT department_id FROM nodes WHERE network_id = ?1 AND node_id = ?2", networkId, g.scope_id)?.department_id;
      if (!dept || !managed.has(dept)) return false;
    }
  }
  return true;
}

/**
 * 这个节点对「目标节点」的某个能力有什么级别：edit / read / null（没有授权）。
 * readonly 模式的节点 edit 降为 read。
 */
export function grantLevelForTarget(
  networkId: string, nodeId: string, capability: GrantCapability, targetNodeId: string | null, mode?: string | null,
): GrantLevel | null {
  const rows = db.all<{ scope_kind: GrantScopeKind; scope_id: string; level: GrantLevel }>(
    "SELECT scope_kind, scope_id, level FROM node_grants WHERE network_id = ?1 AND node_id = ?2 AND capability = ?3",
    networkId, nodeId, capability,
  );
  if (!rows.length) return null;
  let targetDept: string | null | undefined;
  let best: GrantLevel | null = null;
  for (const r of rows) {
    let hit = false;
    if (r.scope_kind === "network") hit = true;
    else if (r.scope_kind === "node") hit = !!targetNodeId && r.scope_id === targetNodeId;
    else if (r.scope_kind === "department" && targetNodeId) {
      if (targetDept === undefined) {
        targetDept = db.get<{ department_id: string | null }>("SELECT department_id FROM nodes WHERE network_id = ?1 AND node_id = ?2", networkId, targetNodeId)?.department_id ?? null;
      }
      hit = !!targetDept && departmentSubtree(networkId, r.scope_id).has(targetDept);
    }
    if (hit) { best = r.level === "edit" ? "edit" : best ?? "read"; if (best === "edit") break; }
  }
  if (best === "edit" && mode === "readonly") return "read";
  return best;
}

/** 这个节点有没有任何该能力的授权（列表时决定要不要扫全网的计划）。 */
export function hasAnyGrant(networkId: string, nodeId: string, capability: GrantCapability): boolean {
  return !!db.get("SELECT 1 AS ok FROM node_grants WHERE network_id = ?1 AND node_id = ?2 AND capability = ?3 LIMIT 1", networkId, nodeId, capability);
}

// ── 第二期：任务看板（board）─────────────────────────────────────────────
//
// 与 schedules 的口径**不同**，别混：
//   · schedules 按「目标节点所在部门」判（计划后面挂着一个目标节点）
//   · board 按「**卡的负责人所在部门**」判 —— 卡没有目标节点
//
// 部门口径**必须**和部门负责人（RFC-040）完全一致，所以这里直接复用
// `isDepartmentCard(departmentCardsFor(net, departmentSubtree(net, scope_id)), row)`，
// 不自己解析 owner_json —— 那边判的是「agent 的主人是否在部门成员里」（nodesOwnedBy），
// 而不是「agent 节点自己的 department_id」；两套写法会判出不同结果。
export type BoardCardRef = {
  owner_json: string | null;
  agent_owner_json?: string | null;
};

/** 卡的 agent_owner 节点 id（只有 node 范围需要它）。 */
function agentOwnerNodeId(row: BoardCardRef): string | null {
  if (!row.agent_owner_json) return null;
  try {
    const ref = JSON.parse(row.agent_owner_json) as { kind?: unknown; id?: unknown };
    return ref && ref.kind === "node" && typeof ref.id === "string" ? ref.id : null;
  } catch {
    return null;
  }
}

/** 这个节点对这张卡有没有 board 授权，以及级别。readonly 模式下 edit 降为 read。 */
export function boardGrantForCard(
  networkId: string, nodeId: string, row: BoardCardRef, mode?: string | null,
): "edit" | "read" | null {
  const grants = db.all<{ scope_kind: GrantScopeKind; scope_id: string; level: GrantLevel }>(
    "SELECT scope_kind, scope_id, level FROM node_grants WHERE network_id = ?1 AND node_id = ?2 AND capability = 'board'",
    networkId, nodeId,
  );
  if (!grants.length) return null;
  const agentNode = agentOwnerNodeId(row);
  const deptScopes = new Map<string, ReturnType<typeof departmentCardsFor>>();
  let best: GrantLevel | null = null;
  for (const g of grants) {
    let hit = false;
    if (g.scope_kind === "network") hit = true;
    else if (g.scope_kind === "node") hit = !!agentNode && g.scope_id === agentNode;
    else if (g.scope_kind === "department") {
      let cards = deptScopes.get(g.scope_id);
      if (!cards) {
        cards = departmentCardsFor(networkId, departmentSubtree(networkId, g.scope_id));
        deptScopes.set(g.scope_id, cards);
      }
      hit = isDepartmentCard(cards, row);
    }
    if (!hit) continue;
    if (g.level === "edit") { best = "edit"; break; }
    best = best ?? "read";
  }
  if (best === "edit" && mode === "readonly") return "read";
  return best;
}
