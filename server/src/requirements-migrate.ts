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

/**
 * 标签颜色(可选)。标签本身仍只是卡片 tags 数组里的字符串;这里只存「这个网络里这个名字用什么颜色」。
 * 没有行 = 默认色。改名 / 合并 / 删除时跟着挪或删(见 requirements.ts 的标签管理)。IF NOT EXISTS:重复执行无副作用。
 */
export function ensureNetworkTags(database: DbAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS network_tags (
      network_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (network_id, name)
    );
  `);
}

/**
 * 删掉的卡留一条墓碑,给 GET /api/requirements?changes=1 报「这些 id 没了」(按 updated_since 增量同步的客户端
 * 否则永远不知道一张卡被删了)。连同判断可见性要用的列一起存:受限成员只收到他本来看得见的卡的删除。
 * 保留 30 天(requirements.ts TOMBSTONE_RETENTION_MS,写入时顺手清)。IF NOT EXISTS:重复执行无副作用。
 */
export function ensureRequirementTombstones(database: DbAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS requirement_tombstones (
      requirement_id    TEXT PRIMARY KEY,
      network_id        TEXT NOT NULL,
      deleted_at        TEXT NOT NULL,
      project_id        TEXT,
      owner_json        TEXT,
      participants_json TEXT,
      created_by        TEXT,
      created_by_json   TEXT
    );
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirement_tombstones_network ON requirement_tombstones(network_id, deleted_at)");
}

/** external_ref 在同一网络里唯一(只管有值的行)。IF NOT EXISTS:重复执行无副作用。 */
export function ensureRequirementIndexes(database: DbAdapter): void {
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_requirements_external_ref ON requirements(network_id, external_ref) WHERE external_ref IS NOT NULL");
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirements_network_updated ON requirements(network_id, updated_at)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirements_parent ON requirements(parent_id) WHERE parent_id IS NOT NULL");
}

/**
 * 优先级加 lowest(P3 极低)。旧库建表时带 CHECK(priority IN ('high', 'normal', 'low')),SQLite 不能就地改
 * CHECK,只能重建一次:拿 sqlite_master 里的原建表语句(含历次加的列)只换掉那个 CHECK,整表拷过去,
 * 再按原样重建这张表的索引。已经放开的库什么都不做。存量值不改。
 */
const OLD_PRIORITY_CHECK = /CHECK\s*\(\s*priority\s+IN\s*\(\s*'high'\s*,\s*'normal'\s*,\s*'low'\s*\)\s*\)/i;
export const PRIORITY_CHECK = "CHECK(priority IN ('high', 'normal', 'low', 'lowest'))";
export function migrateRequirementPriorityCheck(database: DbAdapter): { rebuilt: boolean } {
  if (database.dialect === "postgres") {
    try {
      database.exec("ALTER TABLE requirements DROP CONSTRAINT IF EXISTS requirements_priority_check");
      database.exec(`ALTER TABLE requirements ADD CONSTRAINT requirements_priority_check ${PRIORITY_CHECK}`);
    } catch {}
    return { rebuilt: false };
  }
  const table = database.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'requirements'");
  if (!table?.sql || !OLD_PRIORITY_CHECK.test(table.sql)) return { rebuilt: false };
  const indexes = database.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requirements' AND sql IS NOT NULL");
  const createSql = table.sql
    .replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?requirements["`]?/i, "CREATE TABLE requirements_migrated")
    .replace(OLD_PRIORITY_CHECK, PRIORITY_CHECK);
  database.transaction(() => {
    database.exec("DROP TABLE IF EXISTS requirements_migrated");
    database.exec(createSql);
    database.exec("INSERT INTO requirements_migrated SELECT * FROM requirements");
    database.exec("DROP TABLE requirements");
    database.exec("ALTER TABLE requirements_migrated RENAME TO requirements");
    for (const index of indexes) database.exec(index.sql);
  });
  return { rebuilt: true };
}

/**
 * 状态加 abandoned(废弃)。同 migrateRequirementPriorityCheck:旧库的 CHECK(column_name IN ('pool', 'doing', 'done'))
 * SQLite 不能就地改,只重建一次;PostgreSQL 换掉默认名的列约束。已经放开的库什么都不做。存量值不改。
 */
const OLD_COLUMN_CHECK = /CHECK\s*\(\s*column_name\s+IN\s*\(\s*'pool'\s*,\s*'doing'\s*,\s*'done'\s*\)\s*\)/i;
export const COLUMN_CHECK = "CHECK(column_name IN ('pool', 'doing', 'done', 'abandoned'))";
export function migrateRequirementColumnCheck(database: DbAdapter): { rebuilt: boolean } {
  if (database.dialect === "postgres") {
    try {
      database.exec("ALTER TABLE requirements DROP CONSTRAINT IF EXISTS requirements_column_name_check");
      database.exec(`ALTER TABLE requirements ADD CONSTRAINT requirements_column_name_check ${COLUMN_CHECK}`);
    } catch {}
    return { rebuilt: false };
  }
  const table = database.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'requirements'");
  if (!table?.sql || !OLD_COLUMN_CHECK.test(table.sql)) return { rebuilt: false };
  const indexes = database.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requirements' AND sql IS NOT NULL");
  const createSql = table.sql
    .replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?requirements["`]?/i, "CREATE TABLE requirements_migrated")
    .replace(OLD_COLUMN_CHECK, COLUMN_CHECK);
  database.transaction(() => {
    database.exec("DROP TABLE IF EXISTS requirements_migrated");
    database.exec(createSql);
    database.exec("INSERT INTO requirements_migrated SELECT * FROM requirements");
    database.exec("DROP TABLE requirements");
    database.exec("ALTER TABLE requirements_migrated RENAME TO requirements");
    for (const index of indexes) database.exec(index.sql);
  });
  return { rebuilt: true };
}

/**
 * 任务短号 seq:每个网络自己的 #1、#2…,界面显示和按 #N 查都用它。主键 requirement_id 不变。
 * - 加可空列 seq;没有号的旧行按 created_at(再按 requirement_id)补号,接在该网络已有的最大号后面。
 * - requirement_seq_counters 记每个网络发到过的最大号:删掉 / 归档的卡,号也不回收。
 * - (network_id, seq) 唯一。重复执行只补还没号的行(回滚到旧 Hub 期间新建的卡)。
 */
export function ensureRequirementSeq(database: DbAdapter): { backfilled: number } {
  try { database.exec("ALTER TABLE requirements ADD COLUMN seq INTEGER"); } catch (e: any) { if (!/duplicate column|already exists/i.test(e?.message || "")) throw e; }
  database.exec("CREATE TABLE IF NOT EXISTS requirement_seq_counters (network_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0)");
  const pending = database.all<{ requirement_id: string; network_id: string; created_at: string | null }>(
    "SELECT requirement_id, network_id, created_at FROM requirements WHERE seq IS NULL",
  );
  if (pending.length) {
    // datetime('now') 的旧默认值「YYYY-MM-DD HH:MM:SS」是 UTC,和 ISO 混在一起时按字符串排会错位,换成毫秒再排。
    const at = (v: string | null) => {
      const s = v ?? "";
      const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
      return Number.isFinite(ms) ? ms : 0;
    };
    pending.sort((a, b) => a.network_id.localeCompare(b.network_id) || at(a.created_at) - at(b.created_at) || (a.requirement_id < b.requirement_id ? -1 : a.requirement_id > b.requirement_id ? 1 : 0));
    database.transaction(() => {
      const next = new Map<string, number>();
      for (const row of pending) {
        if (!next.has(row.network_id)) {
          const max = database.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM requirements WHERE network_id = ?1", row.network_id)?.m ?? 0;
          const counter = database.get<{ last_seq: number }>("SELECT last_seq FROM requirement_seq_counters WHERE network_id = ?1", row.network_id)?.last_seq ?? 0;
          next.set(row.network_id, Math.max(Number(max), Number(counter)));
        }
        const seq = next.get(row.network_id)! + 1;
        next.set(row.network_id, seq);
        database.run("UPDATE requirements SET seq = ?1 WHERE requirement_id = ?2 AND seq IS NULL", [seq, row.requirement_id]);
      }
    });
  }
  // 计数器不低于库里的最大号(补号之后、或计数器表是新建的)。
  for (const row of database.all<{ network_id: string; m: number }>("SELECT network_id, MAX(seq) AS m FROM requirements WHERE seq IS NOT NULL GROUP BY network_id")) {
    database.run(
      `INSERT INTO requirement_seq_counters (network_id, last_seq) VALUES (?1, ?2)
       ON CONFLICT(network_id) DO UPDATE SET last_seq = CASE WHEN excluded.last_seq > requirement_seq_counters.last_seq THEN excluded.last_seq ELSE requirement_seq_counters.last_seq END`,
      [row.network_id, Number(row.m)],
    );
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_requirements_network_seq ON requirements(network_id, seq) WHERE seq IS NOT NULL");
  return { backfilled: pending.length };
}

/**
 * 完成时间(仪表盘「今天 / 本周完成了多少」用)。三列只加不改:
 * - completed_at:进入「完成」列的时刻(ISO,UTC)。移出「完成」列清空;在「完成」列里改别的字段不动它。
 * - completed_by_json:谁把它移进「完成」的({kind,id},同 updated_by)。
 * - completed_at_approx:1 = 这个时刻是补出来的近似值(见下),界面可以标「近似」。
 * 补值:已经在「完成」列、还没有 completed_at 的卡,按 updated_at(没有就 created_at)补,approx = 1,completed_by 留空
 * —— updated_at 是「最后一次改」,不是「完成那一刻」,只能当近似。旧库里 datetime('now') 的「YYYY-MM-DD HH:MM:SS」(UTC)
 * 统一换成 ISO,按时间范围比较时不和 ISO 值错位。
 * 每次启动都跑,重复执行只处理需要处理的行:回滚到旧 Hub 期间移进「完成」的卡补近似值,移出「完成」的卡清掉残留。
 */
export function ensureRequirementCompletedAt(database: DbAdapter): { backfilled: number; cleared: number } {
  for (const column of ["completed_at TEXT", "completed_by_json TEXT", "completed_at_approx INTEGER NOT NULL DEFAULT 0"]) {
    try { database.exec(`ALTER TABLE requirements ADD COLUMN ${column}`); } catch (e: any) { if (!/duplicate column|already exists/i.test(e?.message || "")) throw e; }
  }
  const pending = database.all<{ requirement_id: string; updated_at: string | null; created_at: string | null }>(
    "SELECT requirement_id, updated_at, created_at FROM requirements WHERE column_name = 'done' AND completed_at IS NULL",
  );
  const stale = database.all<{ requirement_id: string }>(
    "SELECT requirement_id FROM requirements WHERE column_name <> 'done' AND (completed_at IS NOT NULL OR completed_by_json IS NOT NULL OR completed_at_approx <> 0)",
  );
  if (pending.length || stale.length) {
    database.transaction(() => {
      for (const row of pending) {
        database.run(
          "UPDATE requirements SET completed_at = ?1, completed_by_json = NULL, completed_at_approx = 1 WHERE requirement_id = ?2 AND completed_at IS NULL",
          [isoInstant(row.updated_at) ?? isoInstant(row.created_at) ?? new Date().toISOString(), row.requirement_id],
        );
      }
      for (const row of stale) {
        database.run("UPDATE requirements SET completed_at = NULL, completed_by_json = NULL, completed_at_approx = 0 WHERE requirement_id = ?1", [row.requirement_id]);
      }
    });
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirements_network_completed ON requirements(network_id, completed_at) WHERE completed_at IS NOT NULL");
  return { backfilled: pending.length, cleared: stale.length };
}

/** 库里的时间 → ISO(UTC)。认 ISO 和旧默认值「YYYY-MM-DD HH:MM:SS」(SQLite datetime('now'),UTC);读不懂 → null。 */
export function isoInstant(value: string | null | undefined): string | null {
  const s = value ?? "";
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 给新卡领下一个号。调用方把它和 INSERT 放在同一个事务里:插入失败(client_id / external_ref 撞了)号也一起回滚。
 * 一条语句完成「读 + 加一 + 写回」,两个并发的新建拿不到同一个号;(network_id, seq) 唯一索引兜底。
 */
export function nextRequirementSeq(database: DbAdapter, networkId: string): number {
  const row = database.get<{ last_seq: number }>(
    `INSERT INTO requirement_seq_counters (network_id, last_seq)
     VALUES (?1, COALESCE((SELECT MAX(seq) FROM requirements WHERE network_id = ?1), 0) + 1)
     ON CONFLICT(network_id) DO UPDATE SET last_seq = requirement_seq_counters.last_seq + 1
     RETURNING last_seq`,
    networkId,
  );
  return Number(row!.last_seq);
}
