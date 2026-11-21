// 「机器别名」（admin 2026-11-21）：节点运行所在物理机要能自定义名字，而不是只有原始 hostname。
//
// 为什么按 hostname 做 key：同一台机器上的多个节点共享一个别名，改一次全部生效；
// 手起的节点（没有 daemon 绑定）也能用，因为它只依赖 nodes.hostname 这个自动上报的只读字段。
//
// 存哪：独立小表 machine_aliases（hostname 主键）。**不放进 nodes 行**，因为一台机器的
// 别名是「机器」的属性，不是「节点」的属性；写 nodes 就得在同一台机器的 N 行上各写一份并保持一致。
//
// 谁能写：用户令牌（人改机器名）。节点令牌只读（上报/展示用），不允许自己改名 ——
// 否则任何 agent 都能把生产机器改名成别的。
import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS machine_aliases (
    hostname    TEXT PRIMARY KEY,
    alias       TEXT NOT NULL,
    updated_by  TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export const MACHINE_ALIAS_MAX = 64;

/** 允许的控制字符外的可打印字符；去掉首尾空白。返回 null = 非法。 */
export function normalizeMachineAlias(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v.length < 1 || v.length > MACHINE_ALIAS_MAX) return null;
  // 与其它名字字段同口径：不允许控制字符（\x00-\x1f / \x7f）
  if (/[\x00-\x1f\x7f]/.test(v)) return null;
  return v;
}

export type MachineAliasRow = { hostname: string; alias: string; updated_at: string };

export function getMachineAlias(hostname: string): MachineAliasRow | null {
  if (!hostname) return null;
  return db.get<MachineAliasRow>(
    "SELECT hostname, alias, updated_at FROM machine_aliases WHERE hostname = ?1",
    hostname,
  ) ?? null;
}

export function setMachineAlias(hostname: string, alias: string, updatedBy: string | null): MachineAliasRow {
  db.run(
    `INSERT INTO machine_aliases (hostname, alias, updated_by, updated_at)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(hostname) DO UPDATE SET alias = ?2, updated_by = ?3, updated_at = datetime('now')`,
    [hostname, alias, updatedBy],
  );
  return getMachineAlias(hostname)!;
}

export function clearMachineAlias(hostname: string): boolean {
  return db.run("DELETE FROM machine_aliases WHERE hostname = ?1", [hostname]).changes > 0;
}

/** 该 hostname 上有多少台节点（给 UI 提示「改一次影响 N 个节点」）。 */
export function countNodesOnHost(hostname: string): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE hostname = ?1", hostname)?.n ?? 0;
}
