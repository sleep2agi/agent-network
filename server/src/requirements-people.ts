// #473(#469 问题 2)—— Agent 查人。
//
// 现场:Agent 想把任务派给「张三」或者某个节点,手里只有用户名 / 别名,而任务的人员字段只收 id;
// GET /api/requirements/people 只给显示名,没有用户名、角色、部门,也看不出哪个 Agent 是谁的。
// 这里给 MCP requirements_people 一份紧凑的通讯录:每个成员一行(user_id、username、display_name、网络角色、
// 部门),带上他名下的 Agent(node_id、alias);没有主人(或主人不在本网络)的 Agent 单列。
// 只在一个网络里查,受限成员看不见的 Agent 一律不出现(与 /people 同一个 hidden 判据)。
//
// 人员字段按名字写(owner {kind:'user', username} / agent_owner {kind:'node', alias})的解析在
// requirements.ts personRef():同样只在任务所在的那个网络里找,看不见的节点等同不存在。

import { db } from "./db.js";
import "./departments.js"; // network_departments 表 + network_members.department_id 列(导入即建,只增)

type HiddenNode = ((nodeId: string) => boolean) | null;

export const PEOPLE_DEFAULT_LIMIT = 50;
export const PEOPLE_MAX_LIMIT = 200;

export type DirectoryAgent = { node_id: string; alias: string };
export type DirectoryPerson = {
  user_id: string;
  username: string;
  /** 没设(或等于用户名)为 ""(与 /people 同一规则)。 */
  display_name: string;
  role: string;
  department: { id: string; name: string } | null;
  agents: DirectoryAgent[];
};

/** q / limit / offset 解析;不合法 → 错误码(400)。 */
export function parsePeopleQuery(params: URLSearchParams): { q: string; limit: number; offset: number } | { error: string } {
  const q = (params.get("q") ?? "").trim();
  if (q.length > 100) return { error: "invalid_q" };
  let limit = PEOPLE_DEFAULT_LIMIT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit)) return { error: "invalid_limit" };
    limit = Number(rawLimit);
    if (limit < 1 || limit > PEOPLE_MAX_LIMIT) return { error: "invalid_limit" };
  }
  let offset = 0;
  const rawOffset = params.get("offset");
  if (rawOffset !== null) {
    if (!/^\d{1,6}$/.test(rawOffset)) return { error: "invalid_offset" };
    offset = Number(rawOffset);
  }
  return { q, limit, offset };
}

/**
 * 一个网络的通讯录。q = 不区分大小写的子串,匹配用户名 / 显示名 / 部门名 / 名下 Agent 的别名;
 * 成员按 username 排序、offset 翻页;没主人的 Agent 只在第一页给(按 q 过滤)。
 */
export function peopleDirectory(networkId: string, hidden: HiddenNode, query: { q: string; limit: number; offset: number }) {
  const members = db.all<{ user_id: string; username: string; display_name: string | null; role: string | null; department_id: string | null; department_name: string | null }>(
    `SELECT u.user_id, u.username, u.display_name, m.role, d.department_id, d.name AS department_name
       FROM network_members m
       JOIN users u ON u.user_id = m.user_id
       LEFT JOIN network_departments d ON d.network_id = m.network_id AND d.department_id = m.department_id
      WHERE m.network_id = ?1
      ORDER BY u.username, u.user_id`,
    networkId,
  );
  const nodes = db.all<{ node_id: string; alias: string | null; node_name: string; owner_user_id: string | null }>(
    "SELECT node_id, alias, node_name, owner_user_id FROM nodes WHERE network_id = ?1 ORDER BY COALESCE(alias, node_name), node_id",
    networkId,
  ).filter(n => !hidden?.(n.node_id));
  const memberIds = new Set(members.map(m => m.user_id));
  const byOwner = new Map<string, DirectoryAgent[]>();
  const unowned: DirectoryAgent[] = [];
  for (const n of nodes) {
    const agent = { node_id: n.node_id, alias: n.alias || n.node_name };
    if (n.owner_user_id && memberIds.has(n.owner_user_id)) {
      const list = byOwner.get(n.owner_user_id) ?? [];
      list.push(agent);
      byOwner.set(n.owner_user_id, list);
    } else unowned.push(agent);
  }
  const needle = query.q.toLowerCase();
  const hit = (s: string | null | undefined) => !needle || (s ?? "").toLowerCase().includes(needle);
  const people: DirectoryPerson[] = [];
  for (const m of members) {
    const displayName = !m.display_name || m.display_name === m.username ? "" : m.display_name;
    const agents = byOwner.get(m.user_id) ?? [];
    if (!(hit(m.username) || (displayName && hit(displayName)) || (m.department_name && hit(m.department_name)) || agents.some(a => hit(a.alias)))) continue;
    people.push({
      user_id: m.user_id,
      username: m.username,
      display_name: displayName,
      role: m.role ?? "member",
      department: m.department_id && m.department_name ? { id: m.department_id, name: m.department_name } : null,
      agents,
    });
  }
  const page = people.slice(query.offset, query.offset + query.limit);
  const hasMore = query.offset + query.limit < people.length;
  return {
    ok: true,
    network_id: networkId,
    total: people.length,
    people: page,
    ...(query.offset === 0 ? { agents_without_owner: unowned.filter(a => hit(a.alias)) } : {}),
    has_more: hasMore,
    next_offset: hasMore ? query.offset + query.limit : null,
  };
}

/**
 * 按名字找人(personRef 用):只在 networkId 里找,hidden 的节点等同不存在。
 * 返回 id;找不到 → person_not_in_network;同一个别名对上多个节点 → person_ambiguous。
 */
export function resolvePersonName(kind: "user" | "node", name: string, networkId: string, hidden: HiddenNode): string {
  if (kind === "user") {
    const row = db.get<{ user_id: string }>(
      "SELECT u.user_id FROM network_members m JOIN users u ON u.user_id = m.user_id WHERE m.network_id = ?1 AND u.username = ?2",
      networkId, name,
    );
    if (!row) throw new Error("person_not_in_network");
    return row.user_id;
  }
  const rows = db.all<{ node_id: string }>("SELECT node_id FROM nodes WHERE network_id = ?1 AND alias = ?2", networkId, name)
    .filter(r => !hidden?.(r.node_id));
  if (rows.length === 0) throw new Error("person_not_in_network");
  if (rows.length > 1) throw new Error("person_ambiguous");
  return rows[0].node_id;
}
