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

/** `department_id`: Agent 的**显式**部门归属(可空)。空 = 仍按「负责人在哪个部门」推断,
 *  客户端据此把 Agent 放对格子 —— 2026-10-19 前没有这一列,328 个 Agent 只能全算「未归属」。 */
export type DirectoryAgent = {
  node_id: string;
  alias: string;
  department_id?: string | null;
  /**
   * #2596 —— 这一行“最后一次被 Hub 看到”的时间（`nodes.updated_at`），以及生命周期状态。
   *
   * 为什么加：组织架构页把 368 个 agent 全塞进「未归属」，其中 125 个是 5–8 月的历史残留
   * （如 `海报设计师1–5号` 注册于 2026-05-17、早已 offline）。客户端要能“默认只显示近 7 天活跃”
   * 与“同一 alias 只保留最新的那条”，就必须拿到时间轴——否则只能靠 node_id 猜。
   *
   * 只增不改：老客户端忽略未知键，形状断言已在同批测试里放宽。
   */
  updated_at?: string | null;
  lifecycle_state?: string | null;
};
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
  const nodes = db.all<{ node_id: string; alias: string | null; node_name: string; owner_user_id: string | null; department_id: string | null; updated_at: string | null; lifecycle_state: string | null }>(
    "SELECT node_id, alias, node_name, owner_user_id, department_id, updated_at, lifecycle_state FROM nodes WHERE network_id = ?1 ORDER BY COALESCE(alias, node_name), node_id",
    networkId,
  ).filter(n => !hidden?.(n.node_id));
  // #2965 —— 同 alias 多 node 行时**不删行**（保持既有契约：重复项照样列出，客户端去重），
  // 只额外给一个确定性的「该保留哪条」：其余行带 `duplicate_of = <首选 node_id>`。
  //
  // 为什么必须由 hub 判：客户端只看得到 updated_at，而重复注册常发生在同一秒 ——
  // 实测 TM客户端基建牛 三条 updated_at 完全相同（2026-10-26 12:26:22），
  // 按「保留最新」会随机留一条，而真正在跑的是**有会话**的那条（客户端看不到会话）。
  //
  // 规则：有会话 > updated_at 新 > node_id 字典序（最后一条只为让结果稳定）。
  const liveNodeIds = new Set(
    db.all<{ node_id: string | null }>("SELECT DISTINCT node_id FROM sessions WHERE network_id = ?1", networkId)
      .map(r => r.node_id).filter((x): x is string => !!x),
  );
  const byAliasForRank = new Map<string, typeof nodes>();
  for (const n of nodes) {
    const key = n.alias || n.node_name;
    const bucket = byAliasForRank.get(key);
    if (bucket) bucket.push(n); else byAliasForRank.set(key, [n]);
  }
  const preferredByAlias = new Map<string, string>();
  for (const [key, bucket] of byAliasForRank) {
    if (bucket.length < 2) continue;
    const ranked = [...bucket].sort((a, b) => {
      const alive = Number(liveNodeIds.has(b.node_id)) - Number(liveNodeIds.has(a.node_id));
      if (alive !== 0) return alive;
      const t = String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
      if (t !== 0) return t;
      return a.node_id.localeCompare(b.node_id);
    });
    preferredByAlias.set(key, ranked[0].node_id);
  }
  const memberIds = new Set(members.map(m => m.user_id));
  const byOwner = new Map<string, DirectoryAgent[]>();
  const unowned: DirectoryAgent[] = [];
  for (const n of nodes) {
    // 只在**显式**归属时带这一格:没设 = 没有显式归属(顶层 agent_department_supported 告诉
    // 客户端这一点)。行形状保持不变 —— 旧客户端拿到的行还是老样子(多一个键会让严格要求
    // 形状的测试/客户端意外),只是新客户端不再把「负责人在哪个部门」当成 Agent 的部门。
    const agent = {
      node_id: n.node_id,
      alias: n.alias || n.node_name,
      ...(n.department_id ? { department_id: n.department_id } : {}),
      // #2596 —— 客户端据此做「按 alias 去重（保留最新）」与「默认只看近 7 天」。
      updated_at: n.updated_at ?? null,
      lifecycle_state: n.lifecycle_state ?? null,
      // #2965 —— 同 alias 的重复行：这一格指向「首选 node_id」，没有重复时不出现。
      // 客户端可以据此只显示首选那条；也可以像以前一样自己按 updated_at 去重（行为不变）。
      ...(() => {
        const pref = preferredByAlias.get(n.alias || n.node_name);
        return pref && pref !== n.node_id ? { duplicate_of: pref } : {};
      })(),
    };
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
    // #1976 —— 「Agent 归属」与「人类部门」是两个独立的结构。
    // Agent 放哪个部门,只由**显式**设置(nodes.department_id)决定;**不再**从「负责人在哪个部门」推断。
    // 这一格告诉客户端「这个 Hub 支持显式 Agent 部门」:客户端据此把「没有 department_id 这一行」
    // 读成「没有显式归属 ⇒ 未归属」,而不是「按负责人部门推断」。
    // 老 Hub 没有这一格 ⇒ 客户端保留旧的推断口径,行为不变。
    agent_department_supported: true,
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
