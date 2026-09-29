// 需求卡的启动迁移。db.ts 启动时调用;单独成文件,db.ts 只多一行 import 一行调用。
import type { DbAdapter } from "./db-adapter";

/**
 * 负责人 = 人类(owner, kind user);负责 Agent = 节点(agent_owner, kind node)。
 * 之前 owner 可以是节点:这些卡把节点挪到 agent_owner、owner 置空。只动 agent_owner 还空着的行,
 * 所以重复执行不会再改任何东西;不删行,不碰别的列。在 JS 里判 kind(不依赖 SQLite 的 json_extract)。
 */
export function migrateRequirementAgentOwners(database: DbAdapter): { moved: number } {
  const rows = database.all<{ requirement_id: string; owner_json: string | null }>(
    "SELECT requirement_id, owner_json FROM requirements WHERE owner_json IS NOT NULL AND agent_owner_json IS NULL",
  );
  let moved = 0;
  for (const row of rows) {
    let owner: { kind?: unknown; id?: unknown } | null = null;
    try { owner = JSON.parse(row.owner_json || "null"); } catch { continue; }
    if (!owner || owner.kind !== "node" || typeof owner.id !== "string" || !owner.id) continue;
    database.run(
      "UPDATE requirements SET agent_owner_json = ?1, owner_json = NULL WHERE requirement_id = ?2 AND agent_owner_json IS NULL",
      [JSON.stringify({ kind: "node", id: owner.id }), row.requirement_id],
    );
    moved += 1;
  }
  return { moved };
}
