// #752(父卡 #750 Agent 进组织架构)—— MCP org_whoami:节点问「我在组织架构的哪里」。只读,只给节点令牌。
//
// 部门取法:节点自己的归属(#751 network_node_departments)→ source "node";没有 → 主人(nodes.owner_user_id)
// 在本网络的部门 → source "owner"(和 department-heads.ts 按主人归部门的间接口径一致);都没有 → "none"。
// 🔴 每条查询都带 network_id = 调用者令牌绑定的网络:别的网络里同 id 的部门 / 节点 / 人一律看不见。
// 显示名规则同 requirements-people.ts:没设或等于用户名 → "",从不把用户名当显示名吐出去。

import { db } from "./db.js";
import { parseDbTimestampMs } from "./db-timestamp.js";
import { nodeDepartment } from "./departments.js";

export const ORG_WHOAMI_MEMBER_CAP = 50;
const ONLINE_MS = 5 * 60_000; // 与 list_host_supervisors 同一口径(心跳 3 分钟)

type Ref = { id: string; name: string };
const displayName = (u: { username: string; display_name: string | null }) =>
  !u.display_name || u.display_name === u.username ? "" : u.display_name;

export function orgWhoami(networkId: string, nodeId: string | null, ownerUserId: string | null) {
  let source: "node" | "owner" | "none" = "none";
  let deptId = nodeId ? nodeDepartment(networkId, nodeId) : null;
  if (deptId) source = "node";
  else if (ownerUserId) {
    deptId = db.get<{ department_id: string }>(
      `SELECT m.department_id FROM network_members m
         JOIN network_departments d ON d.network_id = m.network_id AND d.department_id = m.department_id
        WHERE m.network_id = ?1 AND m.user_id = ?2`,
      networkId, ownerUserId,
    )?.department_id ?? null;
    if (deptId) source = "owner";
  }
  if (!deptId) return { ok: true, source: "none" as const, department: null, ancestors: [], head: null, humans: [], agents: [], truncated: false };

  const depts = new Map(db.all<{ department_id: string; name: string; parent_id: string | null; leader_user_id: string | null }>(
    "SELECT department_id, name, parent_id, leader_user_id FROM network_departments WHERE network_id = ?1",
    networkId,
  ).map(d => [d.department_id, d]));
  const self = depts.get(deptId)!;
  const ancestors: Ref[] = [];
  const seen = new Set([deptId]);
  for (let p = self.parent_id; p && depts.has(p) && !seen.has(p); p = depts.get(p)!.parent_id) {
    seen.add(p);
    ancestors.push({ id: p, name: depts.get(p)!.name });
  }

  const userRow = (userId: string) => db.get<{ user_id: string; username: string; display_name: string | null }>(
    `SELECT u.user_id, u.username, u.display_name FROM network_members m JOIN users u ON u.user_id = m.user_id
      WHERE m.network_id = ?1 AND m.user_id = ?2`,
    networkId, userId,
  );
  const leader = self.leader_user_id ? userRow(self.leader_user_id) : null; // 负责人不在本网络了 → null(同 listDepartments)
  const head = leader ? { user_id: leader.user_id, display_name: displayName(leader) } : null;

  const cap = ORG_WHOAMI_MEMBER_CAP + 1;
  const humanRows = db.all<{ user_id: string; username: string; display_name: string | null }>(
    `SELECT u.user_id, u.username, u.display_name FROM network_members m JOIN users u ON u.user_id = m.user_id
      WHERE m.network_id = ?1 AND m.department_id = ?2 ORDER BY m.joined_at, u.user_id LIMIT ${cap}`,
    networkId, deptId,
  );
  const agentRows = db.all<{ node_id: string; alias: string | null; node_name: string; status: string | null; last_seen_at: string | null }>(
    `SELECT n.node_id, n.alias, n.node_name, s.status, s.last_seen_at
       FROM network_node_departments m
       JOIN nodes n ON n.node_id = m.node_id AND n.network_id = m.network_id
       LEFT JOIN sessions s ON s.network_id = m.network_id AND s.alias = n.alias -- (network_id, alias) 唯一
      WHERE m.network_id = ?1 AND m.department_id = ?2 ORDER BY n.alias, n.node_id LIMIT ${cap}`,
    networkId, deptId,
  );
  const now = Date.now();
  const humans = humanRows.map(u => ({ user_id: u.user_id, display_name: displayName(u) }));
  const agents = agentRows.map(a => {
    const t = a.last_seen_at ? parseDbTimestampMs(a.last_seen_at) : NaN;
    return { node_id: a.node_id, alias: a.alias || a.node_name, online: a.status !== "offline" && !isNaN(t) && now - t <= ONLINE_MS };
  });
  const truncated = humans.length + agents.length > ORG_WHOAMI_MEMBER_CAP;
  const keptHumans = humans.slice(0, ORG_WHOAMI_MEMBER_CAP);
  return {
    ok: true, source, department: { id: deptId, name: self.name }, ancestors, head,
    humans: keptHumans, agents: agents.slice(0, ORG_WHOAMI_MEMBER_CAP - keptHumans.length), truncated,
  };
}
