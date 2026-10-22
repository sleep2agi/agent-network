// #1521 全团队规则(admin 2026-10-19 截图:Hub 侧栏 Provider 下面缺一个「全团队规则」入口)。
//
// 本片只做**存储 + revision**(checklist 第 2 项):
//   网络级一份文本,一个网络一行;revision 单调递增,内容一字不变就不涨(幂等),
//   后面「受管块注入」(`<!-- ANET:TEAM-RULES v<revision> … -->`)按 revision 判断要不要重写节点文件。
// 投递(门铃注入)、开关、客户端页是后续两片,不在这里。
//
// 权限:读 = 网络成员 / 本网络节点令牌 / Hub 管理员;写 = owner / admin / Hub 管理员(节点令牌不能写)。
// 不存任何密钥;内容是普通规则文本,审计只记字节数与 revision,不记正文。

import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS network_rules (
    network_id TEXT PRIMARY KEY,
    content    TEXT NOT NULL DEFAULT '',
    revision   INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export const NETWORK_RULES_WRITE_DENIED = "network_rules_write_denied";
// 与 write_node_rules_file 的单次上限一致(256 KiB),两边同一把尺子。
export const NETWORK_RULES_MAX_BYTES = 256 * 1024;

type Row = { network_id: string; content: string; revision: number; updated_by: string | null; updated_at: string };
type Ok = { ok: true; network_id: string; content: string; revision: number; updated_by: string | null; updated_at: string; changed: boolean };
type Fail = { ok: false; status: number; error: string };
export type NetworkRulesResult = Ok | Fail;

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

function row(networkId: string): Row | null {
  return (
    db.get<Row>(
      "SELECT network_id, content, revision, updated_by, updated_at FROM network_rules WHERE network_id = ?1",
      networkId,
    ) ?? null
  );
}

/** 读网络规则;没写过时返回空文本 + revision 0(而不是 404,客户端不必判两种形状)。 */
export function getNetworkRules(networkId: string): Ok {
  const r = row(networkId);
  if (r) return { ok: true, ...r, changed: false };
  return { ok: true, network_id: networkId, content: "", revision: 0, updated_by: null, updated_at: "", changed: false };
}

/** 写网络规则。内容不变 → 原样返回、revision 不涨;变了 → revision + 1。空串 = 清空(仍 +1,受管块据此回滚)。 */
export function saveNetworkRules(networkId: string, userId: string | null, content: unknown): NetworkRulesResult {
  if (typeof content !== "string") return fail(400, "content required");
  if (Buffer.byteLength(content, "utf8") > NETWORK_RULES_MAX_BYTES) return fail(400, "content_too_long");
  const before = row(networkId);
  if (before && before.content === content) return { ok: true, ...before, changed: false };
  const revision = (before?.revision ?? 0) + 1;
  db.run(
    `INSERT INTO network_rules (network_id, content, revision, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(network_id) DO UPDATE SET content = ?2, revision = ?3, updated_by = ?4, updated_at = datetime('now')`,
    [networkId, content, revision, userId],
  );
  const after = row(networkId)!;
  return { ok: true, ...after, changed: true };
}
