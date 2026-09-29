// 需求卡的启动迁移。requirements.ts 载入时调用一次(列由 db.ts 的加列循环加上)。
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

/**
 * 项目表(需求卡的「项目」)。只建表、建索引,不塞任何项目 —— 军团项目 / TMAI 由 owner 在界面里建。
 * CREATE ... IF NOT EXISTS:重复执行无副作用。放在这里而不是 db.ts,db.ts 的行号被文档钉着。
 */
export function ensureRequirementProjects(database: DbAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS requirement_projects (
      project_id  TEXT PRIMARY KEY,
      network_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL,
      sort        INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_requirement_projects_network ON requirement_projects(network_id, sort);
  `);
}

/** external_ref 在同一网络里唯一(只管有值的行)。IF NOT EXISTS:重复执行无副作用。 */
export function ensureRequirementIndexes(database: DbAdapter): void {
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_requirements_external_ref ON requirements(network_id, external_ref) WHERE external_ref IS NOT NULL");
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirements_network_updated ON requirements(network_id, updated_at)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirements_parent ON requirements(parent_id) WHERE parent_id IS NOT NULL");
}
