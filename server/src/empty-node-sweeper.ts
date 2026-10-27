// #2596 —— 组织架构页那些“重复名字”的真身：**注册失败留下的空白 node 行**。
//
// 生产实测（2026-10-27，只读）：
// ``` 
// nodes 总数 312
// runtime / hostname / config_path 全为空、且没有任何 session 的行 = 12
// 形态高度一致：同一 alias 在几分钟内连着出现，最后一个才被填上真实身份
//   TMA门户鲸2号 ×5  09-17 15:47:52 → 16:03:05   （6 分钟注册 5 次，第 6 次成功）
// ```
// ⇒ 注册流程先建行、节点再补身份；补不上的尝试留下永久空壳，被组织架构页当成 node 渲染。
//
// 这里只做**清理**，不动注册流程：
//   · 只删「三个身份字段全空 + 没有任何 session」的行 —— 这种行不可能提供任何功能；
//   · 只删 `created_at` 早于 N 天（默认 2 天）的行 —— 正在注册中的行自然不会被误删；
//     （用 created_at 不用 updated_at：后者会被无关的批量更新刷新，见下方注释里的生产实例）
//   · 删除前把整行导成 JSON 到日志（可人工恢复），并返回被删的 id 列表。
//
// 为什么不用「同 alias 只留一条」这种规则：不同机器共用 alias 是**数据问题不是脏数据**
// （Mac打包狗 / TM微软牛 / TM汇报牛 这类），删了会丢真实节点。空壳判据才安全。

import { db } from "./db.js";

export const EMPTY_NODE_AGE_DAYS_ENV = "COMMHUB_EMPTY_NODE_GC_DAYS";
export const EMPTY_NODE_AGE_DAYS_DEFAULT = 2;

export type EmptyNodeSweepResult = {
  deleted: number;
  ids: string[];
  ageDays: number;
};

export function readEmptyNodeAgeDays(raw = process.env[EMPTY_NODE_AGE_DAYS_ENV]): number {
  if (raw === undefined || raw === "") return EMPTY_NODE_AGE_DAYS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return EMPTY_NODE_AGE_DAYS_DEFAULT;
  return Math.floor(n);
}

const IDENTITY_EMPTY = `COALESCE(runtime, '') = '' AND COALESCE(hostname, '') = '' AND COALESCE(config_path, '') = ''`;

export function sweepEmptyNodeRows(
  opts: { olderThanDays?: number; dryRun?: boolean } = {},
): EmptyNodeSweepResult {
  const ageDays = opts.olderThanDays ?? readEmptyNodeAgeDays();
  // <=0 关闭（运维可以彻底停掉这个清理）
  if (ageDays <= 0) return { deleted: 0, ids: [], ageDays: 0 };

  const rows = db.all<{ node_id: string }>(
    `SELECT n.node_id
       FROM nodes n
      WHERE ${IDENTITY_EMPTY.replace(/\b(runtime|hostname|config_path)\b/g, "n.$1")}
        -- #2596 —— 用 created_at 而不是 updated_at：空壳行会被无关的批量更新
        -- 把 updated_at 顶到「今天」（生产实测：2026-10-26 的一次批量更新把 08/09 月
        -- 建的空壳全部刷成 10-26），那样 2 天的阈值就永远删不掉它们。
        -- created_at 才是“这行空了多久”的稳定量；在注册中的行 created_at 必然是新的。
        AND n.created_at < datetime('now', ?1)
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.node_id = n.node_id)
      LIMIT 500`,
    `-${ageDays} days`,
  );
  if (rows.length === 0) return { deleted: 0, ids: [], ageDays };

  const ids = rows.map((r) => r.node_id);
  if (opts.dryRun) return { deleted: 0, ids, ageDays };

  // 删前留证：整行 JSON 打到日志里（运维可据此恢复），再逐条删。
  try {
    const full = db.all<Record<string, unknown>>(
      `SELECT * FROM nodes WHERE node_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
      ids,
    );
    console.log(`[commhub empty-node-gc] deleting ${ids.length} placeholder node row(s): ${JSON.stringify(full)}`);
  } catch (e: any) {
    console.log(`[commhub empty-node-gc] backup dump failed, aborting: ${e?.message ?? e}`);
    return { deleted: 0, ids: [], ageDays };
  }

  let deleted = 0;
  for (const id of ids) {
    try {
      const res = db.run(`DELETE FROM nodes WHERE node_id = ?1 AND ${IDENTITY_EMPTY}`, [id]);
      deleted += res.changes ?? 0;
    } catch (e: any) {
      console.log(`[commhub empty-node-gc] delete ${id} failed: ${e?.message ?? e}`);
    }
  }
  return { deleted, ids, ageDays };
}
