// 任务动态(#429,Vincent 2026-09-30「任务有新的状态…这完成了,这是有这种动态」)。
//
// requirements 表只存「现在是什么」和「最后是谁改的」(updated_by_json),改之前是什么没有任何地方留着 ——
// 「优先级 P2 → P0」「状态 需求池 → 进行中」画不出来。这里给每一次写入记字段级的流水:谁(用户 / 节点)、
// 什么时候、哪个字段、旧值 → 新值。写入点在 requirements.ts 的各条写路径里,和那次 UPDATE 在同一个事务里。
//
// 表只加不改:旧 Hub(回滚之后)不认识这张表,也不会碰它;再升回来接着记(回滚期间的改动没有流水)。
// 读:GET /api/requirements/events(requirements.ts,可见范围与列表相同),capability `events`。
import type { DbAdapter } from "./db-adapter.js";

/** 流水保留多久。更早的在写入时顺手清掉(每 PRUNE_EVERY 次写一次)。 */
export const EVENTS_RETENTION_MS = 180 * 86_400_000;
const PRUNE_EVERY = 500;

/** IF NOT EXISTS:重复执行无副作用;SQLite / PostgreSQL 同一段(适配层把 AUTOINCREMENT 译成 BIGSERIAL)。 */
export function ensureRequirementEvents(database: DbAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS requirement_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id     TEXT NOT NULL,
      requirement_id TEXT NOT NULL,
      seq            INTEGER,
      title          TEXT,
      actor_json     TEXT,
      kind           TEXT NOT NULL,
      field          TEXT,
      old_json       TEXT,
      new_json       TEXT,
      created_at     TEXT NOT NULL
    );
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirement_events_network ON requirement_events(network_id, id)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirement_events_card ON requirement_events(requirement_id, id)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_requirement_events_created ON requirement_events(created_at)");
}

/** 流水要比较的列(requirements.ts 的 Row 的子集)。 */
export type EventCard = {
  requirement_id: string;
  network_id: string;
  seq: number | null;
  title: string;
  column_name: string;
  priority: string;
  due_on: string | null;
  start_on: string | null;
  assignee: string | null;
  owner_json: string | null;
  agent_owner_json: string | null;
  participants_json: string | null;
  tags_json: string | null;
  checklist_json: string | null;
  description: string | null;
  project_id: string | null;
  parent_id: string | null;
  archived: number | null;
};

export type EventKind = "created" | "changed" | "deleted";
/**
 * field(kind = changed):column / title / priority / due / start / assignee / owner / agent_owner / participants /
 * tags / checklist_item(勾选或取消一项:{id,text,done})/ checklist(增删改条目:{total,done})/
 * description(只记字数,不存正文)/ project / parent / archived。
 */
export type EventDraft = { kind: EventKind; field: string | null; old: unknown; new: unknown };

const parse = (json: string | null | undefined): unknown => {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
};
const list = (json: string | null | undefined): unknown[] => { const v = parse(json); return Array.isArray(v) ? v : []; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Item = { id: string; text: string; done: boolean };
const items = (json: string | null | undefined): Item[] =>
  list(json).filter((x): x is Item => !!x && typeof (x as Item).id === "string" && typeof (x as Item).text === "string").map(x => ({ id: x.id, text: x.text, done: !!x.done }));
const counts = (xs: Item[]) => ({ total: xs.length, done: xs.filter(x => x.done).length });

/** 一次写入前后的差异。before = null:新建(只记一条 created)。 */
export function diffRequirement(before: EventCard | null, after: EventCard): EventDraft[] {
  if (!before) return [{ kind: "created", field: null, old: null, new: { title: after.title, column: after.column_name } }];
  const out: EventDraft[] = [];
  const scalar = (field: string, a: unknown, b: unknown) => { if (!same(a, b)) out.push({ kind: "changed", field, old: a, new: b }); };
  scalar("column", before.column_name, after.column_name);
  scalar("title", before.title, after.title);
  scalar("priority", before.priority, after.priority);
  scalar("due", before.due_on || null, after.due_on || null);
  scalar("start", before.start_on || null, after.start_on || null);
  scalar("assignee", before.assignee || null, after.assignee || null);
  scalar("owner", parse(before.owner_json), parse(after.owner_json));
  scalar("agent_owner", parse(before.agent_owner_json), parse(after.agent_owner_json));
  scalar("participants", list(before.participants_json), list(after.participants_json));
  scalar("tags", list(before.tags_json), list(after.tags_json));
  // 子任务:同一条(同 id、同文字)只是勾选变了 = 一条 checklist_item;条目增删 / 改字 / 换顺序 = 一条 checklist。
  const a = items(before.checklist_json), b = items(after.checklist_json);
  const shape = (xs: Item[]) => xs.map(x => `${x.id}\u0000${x.text}`).join("\u0001");
  if (shape(a) === shape(b)) {
    for (let i = 0; i < b.length; i++) if (a[i].done !== b[i].done) out.push({ kind: "changed", field: "checklist_item", old: a[i], new: b[i] });
  } else {
    out.push({ kind: "changed", field: "checklist", old: counts(a), new: counts(b) });
  }
  if ((before.description || "") !== (after.description || "")) {
    out.push({ kind: "changed", field: "description", old: { chars: (before.description || "").length }, new: { chars: (after.description || "").length } });
  }
  scalar("project", before.project_id || null, after.project_id || null);
  scalar("parent", before.parent_id || null, after.parent_id || null);
  scalar("archived", !!before.archived, !!after.archived);
  return out;
}

let writes = 0;

/** 记下一张卡的一组流水(调用方负责放进同一个事务)。actorJson = updated_by_json 的那个值。 */
export function recordRequirementEvents(database: DbAdapter, card: Pick<EventCard, "requirement_id" | "network_id" | "seq" | "title">, actorJson: string | null, drafts: readonly EventDraft[], at: string): void {
  for (const d of drafts) {
    database.run(
      `INSERT INTO requirement_events (network_id, requirement_id, seq, title, actor_json, kind, field, old_json, new_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      [card.network_id, card.requirement_id, card.seq ?? null, card.title, actorJson && actorJson !== "null" ? actorJson : null, d.kind, d.field,
        d.old === null || d.old === undefined ? null : JSON.stringify(d.old), d.new === null || d.new === undefined ? null : JSON.stringify(d.new), at],
    );
    writes++;
  }
  if (drafts.length && writes >= PRUNE_EVERY) {
    writes = 0;
    database.run("DELETE FROM requirement_events WHERE created_at < ?1", [new Date(Date.parse(at) - EVENTS_RETENTION_MS).toISOString()]);
  }
}

export type EventRow = { id: number | string; network_id: string; requirement_id: string; seq: number | string | null; title: string | null; actor_json: string | null; kind: string; field: string | null; old_json: string | null; new_json: string | null; created_at: string };

/** 对外的一条(id 转成字符串:PostgreSQL 的 BIGSERIAL 可能回成字符串或 bigint,客户端一律按字符串比较 / 翻页)。 */
export const eventPublic = (row: EventRow) => ({
  id: String(row.id),
  requirement_id: row.requirement_id,
  seq: row.seq == null ? null : Number(row.seq),
  title: row.title,
  actor: parse(row.actor_json),
  kind: row.kind,
  field: row.field,
  old: parse(row.old_json),
  new: parse(row.new_json),
  at: row.created_at,
});
