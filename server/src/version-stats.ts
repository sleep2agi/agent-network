// #2720 —— 让「版本债务」自己更新，不靠人跑 SQL。
//
// 背景（2026-10-27 生产只读统计）：370 个 session 里 159 个没有版本号，
// 其中 33 个**还在线**。继续拆下去才看清真相：
//   · 24 个的 `agent` 是 `claude-code` —— 那是 Claude 会话自己调
//     `commhub_report_status(status=…, task=…)` 写的，**它没有 version 这个概念**；
//   · 剩下 9 个才是老 agent-node（#1809 之前每次上报不带 version）。
// ⇒ 「无版本」不是一个桶：对 `claude-code` 是 n/a，对 agent-node 才是债务。
//   把两者混在一起算，会得出「升级节点能修好 33 个」的错误结论（只能修好 9 个）。
//
// 这个模块只做聚合（只读），返回：
//   by_version   —— (agent, version) → 总数/在线数
//   no_version   —— 按 agent 拆开的「无版本」，让调用方自己判 n/a 还是债务
//   agent_kind   —— 该 agent 的上报方式（`llm-tool-call` = 不自带版本）

import { db } from "./db.js";

/** 这些 agent 的上报者是 LLM 会话自己调工具，没有打包版本号可报（不是缺字段）。 */
const LLM_TOOL_CALL_AGENTS = new Set(["claude-code"]);

export type VersionBucket = {
  agent: string;
  version: string | null;
  sessions: number;
  active: number;
  /** false = 这个 agent 没有版本概念（n/a），而不是“该报未报”。 */
  version_expected: boolean;
};

export type VersionStats = {
  network_id: string | null;
  sessions: number;
  active: number;
  by_version: VersionBucket[];
  no_version_by_agent: Array<{ agent: string; sessions: number; version_expected: boolean }>;
  /** 在线且「该报版本却没报」的总数 —— 这才是真正的债务口径。 */
  active_missing_version: number;
  /** 在线且版本落后于「在线里最高版本」的数量（只对字符串完全可比的同 agent 生效）。 */
  active_behind_same_agent: number;
};

export function versionStats(networkId: string | null = null): VersionStats {
  const rows = db.all<{ agent: string | null; version: string | null; status: string | null; c: number }>(
    `SELECT COALESCE(agent, '') AS agent,
            COALESCE(NULLIF(version, ''), '') AS version,
            COALESCE(status, '') AS status,
            COUNT(*) AS c
       FROM sessions
      WHERE (?1 IS NULL OR network_id = ?1)
      GROUP BY 1, 2, 3`,
    networkId,
  );

  const buckets = new Map<string, VersionBucket>();
  let sessions = 0;
  let active = 0;
  for (const r of rows) {
    const isActive = r.status !== "offline";
    sessions += r.c;
    if (isActive) active += r.c;
    const version = r.version === "" ? null : r.version;
    const key = `${r.agent}\u0000${version ?? ""}`;
    const cur = buckets.get(key) ?? {
      agent: r.agent,
      version,
      sessions: 0,
      active: 0,
      version_expected: !LLM_TOOL_CALL_AGENTS.has(r.agent),
    };
    cur.sessions += r.c;
    if (isActive) cur.active += r.c;
    buckets.set(key, cur);
  }

  const all = [...buckets.values()].sort((a, b) => b.sessions - a.sessions || a.agent.localeCompare(b.agent));

  const noVersion = all
    .filter((b) => b.version === null)
    .map((b) => ({ agent: b.agent, sessions: b.sessions, version_expected: b.version_expected }));

  // 每个 agent 在「在线」行里出现过的最高版本（仅用于粗判落后；不做语义版本比较，
  // 只在字符串完全一致时才算“同一个版本”）。
  const highest = new Map<string, string>();
  for (const b of all) {
    if (!b.version || b.active === 0) continue;
    const cur = highest.get(b.agent);
    if (!cur || b.version.localeCompare(cur) > 0) highest.set(b.agent, b.version);
  }
  let behind = 0;
  for (const b of all) {
    if (!b.version || b.active === 0) continue;
    const top = highest.get(b.agent);
    if (top && b.version !== top) behind += b.active;
  }

  const activeMissingVersion = all
    .filter((b) => b.version === null && b.version_expected)
    .reduce((n, b) => n + b.active, 0);

  return {
    network_id: networkId,
    sessions,
    active,
    by_version: all,
    no_version_by_agent: noVersion,
    active_missing_version: activeMissingVersion,
    active_behind_same_agent: behind,
  };
}
