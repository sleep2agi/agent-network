// 需求池。长期卡片，存在 Hub 上，手机和电脑读同一份。
// 不是 tasks：tasks 是正在派给节点的活，状态由节点收尾。
import { createHash } from "node:crypto";
import { encodeCursor, matchesTaskId, matchesTerms, parseListQuery, type ListQuery, type NameMaps } from "./requirements-search.js";
import { db, logAudit } from "./db.js";
import { markGzipReusable } from "./http-gzip.js";
import { applyTagOp, normalizeTags, parseTagOp, storedTags, type TagOp } from "./requirement-tags.js";
import { aggregateStats, parseStatsQuery, type StatsRow } from "./requirements-stats.js";
import { addHumanNetworkScope, canRestWriteNetwork, canRestWriteNetworkAsHuman, resolveRestWriteNetworkId, type RestNetworkScope } from "./network-scope.js";
import { isAgentRestricted, restrictedNetworkIds, visibleAgents } from "./agent-access.js";
import {
  addProjectVisibilityScope, addTaskVisibilityScope, canDeleteTask, canEditTask, canParticipantEditTask, canSeeTask, canUseProject, deleteTaskGrantsForProject, projectUseResolver,
  isTaskScoped, PARTICIPANT_EDIT_FIELDS, shouldAuditDenied, taskPermissionsResolver, type TaskCaller,
} from "./task-access.js";
import { notifyParticipantChange } from "./requirement-notify.js";
import { diffRequirement, ensureRequirementEvents, eventPublic, recordRequirementEvents, type EventRow } from "./requirement-events.js";
import { ensureNetworkTags, ensureRequirementCompletedAt, ensureRequirementIndexes, ensureRequirementProjects, ensureRequirementSeq, ensureRequirementTombstones, migrateRequirementAgentOwners, migrateRequirementPriorityCheck, nextRequirementSeq } from "./requirements-migrate.js";

// 启动迁移:旧库里节点当负责人的卡,节点挪到 agent_owner(列由 db.ts 的加列循环加上)。
// 放在这里而不是 db.ts:db.ts 每多一行,文档里钉着的行号就漂一次。
migrateRequirementPriorityCheck(db);
migrateRequirementAgentOwners(db);
ensureRequirementProjects(db);
ensureRequirementIndexes(db);
ensureRequirementSeq(db);
ensureRequirementCompletedAt(db);
ensureNetworkTags(db);
ensureRequirementTombstones(db);
ensureRequirementEvents(db);

type RequestAuth = { userId: string; networkId: string | null; username: string; tokenId?: string | null; tokenName?: string | null } | null;

export type RequirementsRequestContext = {
  req: Request;
  url: URL;
  auth: RequestAuth;
  isAdmin: boolean;
  isNodeToken: boolean;
  scope: RestNetworkScope;
};

const COLUMNS = new Set(["pool", "doing", "done"]);
// 界面上 P0–P3:high=P0 最高、normal=P1 普通、low=P2 低、lowest=P3 极低。存的值不变,旧客户端照常读写前三个。
const PRIORITIES = new Set(["high", "normal", "low", "lowest"]);
const DUE = /^\d{4}-\d{2}-\d{2}$/;

type Row = {
  owner_json: string | null;
  agent_owner_json: string | null;
  description: string | null;
  checklist_json: string | null;
  project_id: string | null;
  external_ref: string | null;
  external_url: string | null;
  archived: number | null;
  created_by: string | null;
  created_by_json: string | null;
  updated_by_json: string | null;
  updated_at: string | null;
  parent_id: string | null;
  children_total: number | null;
  children_done: number | null;
  participants_json: string;
  requirement_id: string;
  network_id: string;
  title: string;
  column_name: string;
  priority: string;
  due_on: string | null;
  start_on: string | null;
  assignee: string | null;
  issues_json: string | null;
  tags_json: string | null;
  created_at: string;
  seq: number | null;
  completed_at: string | null;
  completed_by_json: string | null;
  completed_at_approx: number | null;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

// ── 任务的人员权限(RFC-038 §9,判定在 task-access.ts) ──
// 节点令牌(Agent)、Hub 管理员、没有身份的旧全局令牌:不受任务权限约束(null)。
function taskCaller(ctx: RequirementsRequestContext): TaskCaller {
  if (!ctx.auth || ctx.isNodeToken || ctx.isAdmin) return null;
  return { userId: ctx.auth.userId };
}
/**
 * 看得见但没权限写:403,并按 (用户, 卡) 每小时最多记一条审计。
 * field:参与人改了参与人不能改的字段 —— 错误码不变(旧 App 照旧认 task_read_only),多带 field + 一句中文 message。
 */
function taskDenied(ctx: RequirementsRequestContext, row: Row, error: "task_read_only" | "task_delete_denied", field?: string): Response {
  if (ctx.auth && shouldAuditDenied(ctx.auth.userId, row.requirement_id)) {
    logAudit(ctx.auth.userId, ctx.auth.username || null, "task_access_denied", "requirement", row.requirement_id, JSON.stringify(field ? { error, field } : { error }), undefined, row.network_id);
  }
  if (!field) return jsonError(error, 403);
  return Response.json({ ok: false, error, field, message: `参与人只能修改状态和检查项,不能修改「${FIELD_LABEL[field] ?? field}」` }, { status: 403 });
}
const FIELD_LABEL: Record<string, string> = {
  name: "标题", description: "描述", owner: "负责人", agent_owner: "负责 Agent", participants: "参与人", project_id: "项目",
  priority: "优先级", due: "预计完成", start: "开始时间", tags: "标签", issues: "关联 issue", assignee: "执行人",
  external_ref: "外部引用", external_url: "外部链接", archived: "归档", parent_id: "父任务",
};
/** 参与人改完(事务提交后)发通知;操作者不是参与人 / 状态和检查项没变 → 不发。只对人(用户令牌)。 */
function notifyIfParticipant(ctx: RequirementsRequestContext, before: Row, after: Row): void {
  if (!ctx.auth || ctx.isNodeToken) return;
  try {
    notifyParticipantChange({ before, after, actorUserId: ctx.auth.userId });
  } catch (e) {
    // 通知失败不影响这次改动(已经提交)。
    console.error(`[requirements] participant notice failed: ${(e as Error).message}`);
  }
}
/** 父卡对调用者不可见 = 与不存在同一个错误(不给 scoped 成员留卡片存在性探测)。 */
function parentHidden(ctx: RequirementsRequestContext, parentId: string): boolean {
  const caller = taskCaller(ctx);
  if (!caller) return false;
  const parent = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, parentId);
  return !!parent && !canSeeTask(caller, parent);
}

function dueOk(due: string): boolean {
  if (!DUE.test(due)) return false;
  const [y, m, d] = due.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 预计完成:两种形状都收。
//   YYYY-MM-DD                      全天(旧值原样保存、原样返回;客户端按查看者本地时区的那一天理解)
//   YYYY-MM-DDTHH:MM[:SS][.fff](Z|±HH:MM)  精确到秒的时刻 → 统一存成 UTC「YYYY-MM-DDTHH:MM:SSZ」
// 不带时区的时刻拒收(无法知道是谁的本地时间)。返回 null = 不合法。
const DUE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
export function normalizeDue(raw: string): string | null {
  const due = raw.trim();
  if (!due) return "";
  if (dueOk(due)) return due;
  const m = DUE_DATETIME.exec(due);
  if (!m) return null;
  if (!dueOk(`${m[1]}-${m[2]}-${m[3]}`)) return null;
  const [hh, mm, ss] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (hh > 23 || mm > 59 || ss > 59) return null;
  if (m[7] !== "Z" && (Number(m[8]) > 14 || Number(m[9]) > 59)) return null;
  const ms = Date.parse(due);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;

function clipTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").trim().slice(0, 120) : "";
}

function issueFromParts(repo: string, number: number, title: string) {
  if (!REPO.test(repo) || !Number.isInteger(number) || number < 1 || number > 10_000_000) return null;
  return { repo, number, title: clipTitle(title) };
}

function oneIssue(item: unknown) {
  if (typeof item === "string") {
    const m = ISSUE_URL.exec(item.trim());
    return m ? issueFromParts(`${m[1]}/${m[2]}`, Number(m[3]), "") : null;
  }
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  if (typeof row.url === "string") {
    const m = ISSUE_URL.exec(row.url.trim());
    if (m) return issueFromParts(`${m[1]}/${m[2]}`, Number(m[3]), clipTitle(row.title));
  }
  const repo = typeof row.repo === "string" ? row.repo.trim() : "";
  const number = typeof row.number === "number" ? row.number : Number(row.number);
  return issueFromParts(repo, number, clipTitle(row.title));
}

function normalizeIssues(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 8) return null;
  const out: { repo: string; number: number; title: string }[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const issue = oneIssue(item);
    if (!issue) return null;
    const key = `${issue.repo}#${issue.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function storedIssues(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed = normalizeIssues(JSON.parse(raw));
    return parsed ?? [];
  } catch {
    return [];
  }
}

// ── 描述 / 子任务 ──
// 描述是 markdown 原文,整段替换。子任务是有序数组 [{id,text,done}]:PATCH 整个替换(排序、增删都走这里),
// 单项勾选走 PATCH /api/requirements/{id}/checklist/{itemId} {done} —— 只改那一项,app 和 Agent 同时操作
// 不会互相盖掉对方的整张清单。done 是显式值(不是「取反」),重复请求结果一样。
export const DESCRIPTION_MAX = 20_000;
export const CHECKLIST_MAX_ITEMS = 100;
export const CHECKLIST_TEXT_MAX = 500;
const CHECKLIST_ID = /^[A-Za-z0-9_-]{1,40}$/;
type ChecklistItem = { id: string; text: string; done: boolean };

function normalizeDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n?/g, "\n");
  return text.length > DESCRIPTION_MAX ? null : text;
}

/** 输入的 id 保留(客户端要靠它对上勾选);缺 id 的由 Hub 生成。重复 id、空文字、超长 → null(整体拒绝)。 */
function normalizeChecklist(raw: unknown): ChecklistItem[] | null {
  if (!Array.isArray(raw) || raw.length > CHECKLIST_MAX_ITEMS) return null;
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const id = item.id === undefined ? `ck_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}` : item.id;
    if (typeof id !== "string" || !CHECKLIST_ID.test(id) || seen.has(id)) return null;
    const text = typeof item.text === "string" ? item.text.replace(/[\r\n]+/g, " ").trim() : "";
    if (!text || text.length > CHECKLIST_TEXT_MAX) return null;
    if (item.done !== undefined && typeof item.done !== "boolean") return null;
    seen.add(id);
    out.push({ id, text, done: item.done === true });
  }
  return out;
}

function storedChecklist(raw: string | null): ChecklistItem[] {
  if (!raw) return [];
  try { return normalizeChecklist(JSON.parse(raw)) ?? []; } catch { return []; }
}

// ── 项目 ──
// 按网络隔离;名字 1–40 字,同一网络里未归档的项目不重名;颜色 #RRGGBB;sort 越小越靠前。
// 删除 = 删项目行 + 把引用它的卡片 project_id 置空(卡片本身不动);归档 = 保留引用,只是不能再被选。
type ProjectRow = { project_id: string; network_id: string; name: string; color: string; sort: number; archived: number; created_at: string };
const PROJECT_COLOR = /^#[0-9a-fA-F]{6}$/;
const PROJECT_PALETTE = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];
const PROJECT_SELECT = "project_id, network_id, name, color, sort, archived, created_at";
const projectPublic = (row: ProjectRow) => ({ id: row.project_id, name: row.name, color: row.color, sort: row.sort, archived: !!row.archived, createdAt: row.created_at });
const projectName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\r\n\t]+/g, " ").trim();
  return name && name.length <= 40 ? name : null;
};
function projectNameTaken(networkId: string, name: string, except?: string): boolean {
  return !!db.get("SELECT 1 FROM requirement_projects WHERE network_id = ?1 AND name = ?2 AND archived = 0 AND project_id != ?3", networkId, name, except ?? "");
}
/** 卡片上的 project_id:null 清空;字符串必须是同一网络、未归档的项目。 */
function projectRef(value: unknown, networkId: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value) throw new Error("invalid_project");
  const row = db.get<ProjectRow>(`SELECT ${PROJECT_SELECT} FROM requirement_projects WHERE project_id = ?1`, value);
  if (!row || row.network_id !== networkId) throw new Error("project_not_in_network");
  if (row.archived) throw new Error("project_archived");
  return row.project_id;
}

async function handleProjects(ctx: RequirementsRequestContext): Promise<Response> {
  const { req, url } = ctx;
  const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
  if (!networkId) return jsonError("network_id_required", 400);
  const one = url.pathname.match(/^\/api\/requirements\/projects\/([^/]+)$/);
  if (url.pathname === "/api/requirements/projects" && req.method === "GET") {
    // scoped 成员只列授权给自己的项目(RFC-038 §9.3)。
    const projectParams: unknown[] = [networkId];
    const projectSql = addProjectVisibilityScope(`SELECT ${PROJECT_SELECT} FROM requirement_projects WHERE network_id = ?1`, projectParams, taskCaller(ctx), networkId);
    const rows = db.all<ProjectRow>(`${projectSql} ORDER BY sort, created_at`, ...projectParams);
    // viewer_can.edit:调用者能不能把卡建进 / 挪进这个项目 —— 与 POST / PATCH 卡片同一套判据
    // (canWrite + projectRef 拒归档 + canUseProject)。只加字段;客户端据此只列能编辑的项目(app 任务页审计 L13)。
    const writable = canWrite(ctx, networkId);
    const canUse = projectUseResolver(taskCaller(ctx), networkId);
    return Response.json({ ok: true, projects: rows.map((row) => ({ ...projectPublic(row), viewer_can: { edit: writable && !row.archived && canUse(row.project_id) } })) });
  }
  if (!canWrite(ctx, networkId)) return jsonError("permission_denied", 403);
  // 项目管理(建 / 改名 / 归档 / 删)只给不受任务范围限制的人。
  if (taskCaller(ctx) && isTaskScoped(ctx.auth!.userId, networkId)) return jsonError("permission_denied", 403);
  let body: Record<string, unknown> = {};
  if (req.method === "POST" || req.method === "PATCH") {
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
  }
  if (url.pathname === "/api/requirements/projects" && req.method === "POST") {
    const name = projectName(body.name);
    if (!name) return jsonError("invalid_project_name", 400);
    if (projectNameTaken(networkId, name)) return jsonError("project_name_taken", 409);
    const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM requirement_projects WHERE network_id = ?1", networkId)?.n ?? 0;
    if (count >= 200) return jsonError("too_many_projects", 400);
    const color = body.color === undefined ? PROJECT_PALETTE[count % PROJECT_PALETTE.length] : body.color;
    if (typeof color !== "string" || !PROJECT_COLOR.test(color)) return jsonError("invalid_project_color", 400);
    const sort = body.sort === undefined ? count : body.sort;
    if (!Number.isInteger(sort)) return jsonError("invalid_project_sort", 400);
    const id = `proj_${crypto.randomUUID()}`;
    db.run(`INSERT INTO requirement_projects (${PROJECT_SELECT}) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)`, [id, networkId, name, color, sort, new Date().toISOString()]);
    return Response.json({ ok: true, project: projectPublic(db.get<ProjectRow>(`SELECT ${PROJECT_SELECT} FROM requirement_projects WHERE project_id = ?1`, id)!) }, { status: 201 });
  }
  if (!one) return jsonError("not_found", 404);
  const current = db.get<ProjectRow>(`SELECT ${PROJECT_SELECT} FROM requirement_projects WHERE project_id = ?1`, decodeURIComponent(one[1]));
  if (!current || current.network_id !== networkId) return jsonError("project_not_found", 404);
  if (req.method === "DELETE") {
    // 先把卡片上的引用置空,再删项目:卡片一张不少。
    // updated_at 跟着动:按 updated_since 增量同步的客户端要看得见「项目被清空」这一改动。
    // 每张被清空项目的卡记一条「项目 X → 无」(与清空同一个事务)。
    const at = new Date().toISOString();
    const actor = JSON.stringify(actorOf(ctx));
    db.transaction(() => {
      const cards = db.all<{ requirement_id: string; network_id: string; seq: number | null; title: string }>("SELECT requirement_id, network_id, seq, title FROM requirements WHERE project_id = ?1", current.project_id);
      db.run("UPDATE requirements SET project_id = NULL, updated_at = ?2 WHERE project_id = ?1", [current.project_id, at]);
      for (const card of cards) recordRequirementEvents(db, card, actor, [{ kind: "changed", field: "project", old: current.project_id, new: null }], at);
      db.run("DELETE FROM requirement_projects WHERE project_id = ?1", [current.project_id]);
    });
    deleteTaskGrantsForProject(current.project_id);
    return Response.json({ ok: true });
  }
  if (req.method !== "PATCH") return jsonError("not_found", 404);
  let { name, color, sort, archived } = current;
  if ("name" in body) {
    const next = projectName(body.name);
    if (!next) return jsonError("invalid_project_name", 400);
    name = next;
  }
  if ("color" in body) {
    if (typeof body.color !== "string" || !PROJECT_COLOR.test(body.color)) return jsonError("invalid_project_color", 400);
    color = body.color;
  }
  if ("sort" in body) {
    if (!Number.isInteger(body.sort)) return jsonError("invalid_project_sort", 400);
    sort = body.sort as number;
  }
  if ("archived" in body) {
    if (typeof body.archived !== "boolean") return jsonError("invalid_project_archived", 400);
    archived = body.archived ? 1 : 0;
  }
  if (!archived && projectNameTaken(networkId, name, current.project_id)) return jsonError("project_name_taken", 409);
  db.run("UPDATE requirement_projects SET name = ?1, color = ?2, sort = ?3, archived = ?4 WHERE project_id = ?5", [name, color, sort, archived, current.project_id]);
  return Response.json({ ok: true, project: projectPublic(db.get<ProjectRow>(`SELECT ${PROJECT_SELECT} FROM requirement_projects WHERE project_id = ?1`, current.project_id)!) });
}

// ── 标签管理(RFC-038 §9 的取舍:同项目管理) ──
// 改名 / 合并 / 删除要改写网络里**每一张**带这个标签的卡,包括调用者看不见的;所以只给不受任务范围限制的人
// (网络 owner / 管理员 / task_access='all' 的成员),scoped 成员一律 403 —— 不做「只改我看得见的那几张」:
// 那样同一个标签会被拆成两半,而且改动条数会泄露看不见的卡有几张。节点令牌在入口已被拒(tags_write)。
function canManageTags(ctx: RequirementsRequestContext, networkId: string): boolean {
  if (ctx.isNodeToken || !canWrite(ctx, networkId)) return false;
  return !(taskCaller(ctx) && isTaskScoped(ctx.auth!.userId, networkId));
}

async function handleTagOp(ctx: RequirementsRequestContext): Promise<Response> {
  const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
  if (!networkId) return jsonError("network_id_required", 400);
  if (!canManageTags(ctx, networkId)) return jsonError("permission_denied", 403);
  let body: Record<string, unknown>;
  try { body = await bodyObject(ctx.req); } catch { return jsonError("invalid_json", 400); }
  const op = parseTagOp(body);
  if ("error" in op) return jsonError(op.error, 400);
  const now = new Date().toISOString();
  const actor = JSON.stringify(actorOf(ctx));
  // 读-改-写整个网络的标签在一个事务里:中途失败一张都不改;颜色表跟着一起挪。
  const result = db.transaction(() => {
    const cards = db.all<{ requirement_id: string; network_id: string; seq: number | null; title: string; tags_json: string | null }>(
      "SELECT requirement_id, network_id, seq, title, tags_json FROM requirements WHERE network_id = ?1 AND tags_json IS NOT NULL AND tags_json <> '[]'", networkId,
    );
    const colorOf = (name: string) => db.get<{ color: string }>("SELECT color FROM network_tags WHERE network_id = ?1 AND name = ?2", networkId, name)?.color ?? null;
    const sources = op.op === "rename" ? [op.from] : op.op === "merge" ? op.from : [op.tag];
    const known = cards.some(card => storedTags(card.tags_json).some(tag => sources.includes(tag))) || sources.some(tag => colorOf(tag) !== null);
    if (!known) return null;
    if (op.op === "color") {
      if (op.color === null) db.run("DELETE FROM network_tags WHERE network_id = ?1 AND name = ?2", [networkId, op.tag]);
      else db.run("INSERT INTO network_tags (network_id, name, color, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (network_id, name) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at", [networkId, op.tag, op.color, now]);
      return { affected: 0 };
    }
    let affected = 0;
    for (const card of cards) {
      const next = applyTagOp(storedTags(card.tags_json), op);
      if (!next) continue;
      db.run("UPDATE requirements SET tags_json = ?1, updated_at = ?2, updated_by_json = ?3 WHERE requirement_id = ?4", [JSON.stringify(next), now, actor, card.requirement_id]);
      recordRequirementEvents(db, card, actor, [{ kind: "changed", field: "tags", old: storedTags(card.tags_json), new: next }], now);
      affected++;
    }
    moveTagColors(networkId, op, colorOf, now);
    return { affected };
  });
  if (!result) return jsonError("tag_not_found", 404);
  if (ctx.auth) logAudit(ctx.auth.userId, ctx.auth.username || null, `requirement_tag_${op.op}`, "requirement_tag", op.op === "rename" || op.op === "merge" ? op.to : op.tag, JSON.stringify({ ...op, affected: result.affected }).slice(0, 1000), undefined, networkId);
  return Response.json({ ok: true, op: op.op, affected: result.affected });
}

/** 改名 / 合并:目标没有颜色就继承第一个有颜色的来源;来源的颜色行删掉。删除:删颜色行。 */
function moveTagColors(networkId: string, op: TagOp, colorOf: (name: string) => string | null, now: string): void {
  if (op.op === "color") return;
  const sources = op.op === "rename" ? [op.from] : op.op === "merge" ? op.from : [op.tag];
  if (op.op !== "delete" && colorOf(op.to) === null) {
    const inherited = sources.map(colorOf).find(color => color !== null);
    if (inherited) db.run("INSERT INTO network_tags (network_id, name, color, updated_at) VALUES (?1, ?2, ?3, ?4)", [networkId, op.to, inherited, now]);
  }
  for (const tag of sources) db.run("DELETE FROM network_tags WHERE network_id = ?1 AND name = ?2", [networkId, tag]);
}

function toPublic(row: Row) {
  return {
    owner: row.owner_json ? JSON.parse(row.owner_json) : null,
    // 负责 Agent(执行者)。字段总在:客户端靠它判断这个 Hub 分不分「负责人 / 负责 Agent」。
    agent_owner: row.agent_owner_json ? JSON.parse(row.agent_owner_json) : null,
    // 描述(markdown)与子任务。字段总在:客户端靠它判断这个 Hub 支不支持。
    description: row.description || "",
    checklist: storedChecklist(row.checklist_json),
    // 项目(可空)。字段总在:客户端靠它判断这个 Hub 有没有项目。项目被删 → 置空;被归档 → 引用保留。
    project_id: row.project_id || null,
    participants: JSON.parse(row.participants_json || '[]'),
    id: row.requirement_id,
    // 短号:每个网络自己的 #1、#2…(不回收)。界面显示 #N;GET / PATCH / MCP 的 id 也收「#N」。旧 App 忽略它。
    seq: row.seq == null ? null : Number(row.seq),
    name: row.title,
    priority: row.priority,
    assignee: row.assignee || "",
    due: row.due_on || "",
    // 开始(可空,甘特图用)。形状同 due;没设 = ""。旧 App 不认识这个字段,忽略即可。
    start: row.start_on || "",
    column: row.column_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    issues: storedIssues(row.issues_json),
    tags: storedTags(row.tags_json),
    // 同步用的外部引用(如 github:owner/repo#123)和链接;归档的卡默认不在列表里(include_archived=1 才有)。
    external_ref: row.external_ref || null,
    external_url: row.external_url || null,
    archived: !!row.archived,
    // 谁建的 / 谁最后改的:{kind:"user"|"node", id}。旧卡只有 created_by(用户 id)。
    created_by: row.created_by_json ? JSON.parse(row.created_by_json) : row.created_by ? { kind: "user", id: row.created_by } : null,
    updated_by: row.updated_by_json ? JSON.parse(row.updated_by_json) : null,
    // 子需求:parent_id(可空)和父卡上的子需求进度(未归档的子需求数 / 其中完成的)。
    parent_id: row.parent_id || null,
    children: { total: Number(row.children_total ?? 0), done: Number(row.children_done ?? 0) },
    // 完成时间:进「完成」列的时刻,移出清空(不在「完成」列 = null)。completedAtApprox = 升级前就完成的卡,
    // 时刻是按 updated_at 补的近似值。completedBy = 谁移进「完成」的(近似值的卡为 null)。旧 App 忽略这三个字段。
    completedAt: row.completed_at || null,
    completedAtApprox: !!row.completed_at_approx,
    completedBy: row.completed_by_json ? JSON.parse(row.completed_by_json) : null,
  };
}

async function bodyObject(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
  return value as Record<string, unknown>;
}

function writeNetwork(body: Record<string, unknown>, ctx: RequirementsRequestContext): string | null {
  if (ctx.auth?.networkId) return ctx.auth.networkId;
  if (typeof body.network_id === "string" && body.network_id.trim()) return body.network_id.trim();
  return resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
}

function canWrite(ctx: RequirementsRequestContext, networkId: string | null): boolean {
  // 节点令牌只能写它绑定的那个网络(scope 已强制;这里再核一次,防止别的入口绕过 scope)。
  if (ctx.isNodeToken && (!ctx.auth?.networkId || ctx.auth.networkId !== networkId)) return false;
  if (ctx.isNodeToken) return canRestWriteNetwork(ctx.auth, networkId, ctx.isAdmin);
  // 需求看板是人类协作面:受限成员(只看授权 Agent 的成员)照样能读写卡片,
  // 只是卡片上没授权给他的 Agent 引用会被隐去、也不能被他指派(见 hiddenNodeFilter)。
  return canRestWriteNetworkAsHuman(ctx.auth, networkId, ctx.isAdmin);
}

// ── 多用户 Agent 权限 ──
// 受限成员看需求卡时:agent_owner / 参与人 / created_by / updated_by 里没授权给他的节点一律隐去;
// 他写卡时也不能引用这些节点。返回 null = 这个调用者在这个网络里不受限。
type HiddenNode = ((nodeId: string) => boolean) | null;
function hiddenNodeFilter(ctx: RequirementsRequestContext, networkId: string): HiddenNode {
  if (!ctx.auth || ctx.isNodeToken || ctx.isAdmin) return null;
  if (!isAgentRestricted(ctx.auth.userId, networkId)) return null;
  const visible = new Set(visibleAgents(ctx.auth.userId, networkId).nodeIds);
  return (nodeId: string) => !visible.has(nodeId);
}
function isHiddenRef(ref: unknown, hidden: HiddenNode): boolean {
  if (!hidden || !ref || typeof ref !== "object") return false;
  const r = ref as { kind?: unknown; id?: unknown };
  return r.kind === "node" && typeof r.id === "string" && hidden(r.id);
}
// 每个请求一个权限解析器(按网络缓存成员行与项目授权)。
const permsByCtx = new WeakMap<RequirementsRequestContext, ReturnType<typeof taskPermissionsResolver>>();
function toPublicFor(ctx: RequirementsRequestContext, row: Row) {
  let perms = permsByCtx.get(ctx);
  if (!perms) permsByCtx.set(ctx, perms = taskPermissionsResolver(taskCaller(ctx)));
  // viewer_can:只对「只看相关任务」的调用者出现,客户端据此画只读锁、藏删除;不出现 = 与今天一样全能(旧 Hub 也不出现)。
  const can = perms(row);
  const pub = can ? { ...toPublic(row), viewer_can: can } : toPublic(row);
  const hidden = hiddenNodeFilter(ctx, row.network_id);
  if (!hidden) return pub;
  return {
    ...pub,
    owner: isHiddenRef(pub.owner, hidden) ? null : pub.owner,
    agent_owner: isHiddenRef(pub.agent_owner, hidden) ? null : pub.agent_owner,
    participants: Array.isArray(pub.participants) ? pub.participants.filter((ref: unknown) => !isHiddenRef(ref, hidden)) : pub.participants,
    created_by: isHiddenRef(pub.created_by, hidden) ? null : pub.created_by,
    updated_by: isHiddenRef(pub.updated_by, hidden) ? null : pub.updated_by,
    completedBy: isHiddenRef(pub.completedBy, hidden) ? null : pub.completedBy,
  };
}

const SELECT = "requirement_id, network_id, title, column_name, priority, due_on, assignee, issues_json, tags_json, created_at, owner_json, participants_json, agent_owner_json, description, checklist_json, project_id, external_ref, external_url, archived, created_by, created_by_json, updated_by_json, updated_at, parent_id, start_on, seq, completed_at, completed_by_json, completed_at_approx, " +
  "(SELECT COUNT(*) FROM requirements c WHERE c.parent_id = requirements.requirement_id AND COALESCE(c.archived, 0) = 0) AS children_total, " +
  "(SELECT COUNT(*) FROM requirements c WHERE c.parent_id = requirements.requirement_id AND COALESCE(c.archived, 0) = 0 AND c.column_name = 'done') AS children_done";

type PersonRef = { kind: 'user' | 'node'; id: string };
function personRef(value: unknown, networkId: string, hidden: HiddenNode = null): PersonRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_person');
  const row = value as Record<string, unknown>;
  if ((row.kind !== 'user' && row.kind !== 'node') || typeof row.id !== 'string' || !row.id.trim()) throw new Error('invalid_person');
  const exists = row.kind === 'user'
    ? db.get("SELECT 1 FROM network_members m JOIN users u ON u.user_id=m.user_id WHERE m.network_id=?1 AND m.user_id=?2", networkId, row.id)
    : db.get("SELECT 1 FROM nodes WHERE network_id=?1 AND node_id=?2", networkId, row.id);
  // 没授权的节点与不存在的节点同一个错误,不给受限成员留 node_id 探测差异。
  if (!exists || (row.kind === 'node' && hidden?.(row.id as string))) throw new Error('person_not_in_network');
  return { kind: row.kind, id: row.id };
}

// 负责人只能是人类,负责 Agent 只能是节点;参与人两种都行。库里旧的节点负责人照样读出来(启动迁移会挪走),
// 只有这次请求显式写了 owner / agent_owner 才校验种类。
// 旧客户端兼容(App ≤ 0.2.142 只有一个「负责人」,可以选节点):请求里 owner 是节点、又**没带** agent_owner
// → 当成设置负责 Agent,负责人清空,照常 200,并回 owner_coerced_to_agent_owner: true。
// 带了 agent_owner 的就是新客户端,保持严格:owner 是节点 → 400 owner_must_be_human。
function assignments(body: Record<string, unknown>, networkId: string, current?: Row, hidden: HiddenNode = null) {
  let owner = current?.owner_json ? JSON.parse(current.owner_json) : null;
  let agentOwner = current?.agent_owner_json ? JSON.parse(current.agent_owner_json) : null;
  let coerced: PersonRef | null = null;
  // 受限成员看不见的负责 Agent,他也不能换掉或清空(他读到的是 null,写回 null 不该抹掉别人的指派)。
  const agentOwnerLocked = isHiddenRef(agentOwner, hidden);
  if ('owner' in body) {
    owner = body.owner === null ? null : personRef(body.owner, networkId, hidden);
    if (owner && owner.kind !== 'user') {
      if ('agent_owner' in body) throw new Error('owner_must_be_human');
      coerced = owner;
      agentOwner = owner;
      owner = null;
    }
  }
  if (coerced && agentOwnerLocked) throw new Error('agent_owner_not_granted');
  if ('agent_owner' in body) {
    if (agentOwnerLocked) throw new Error('agent_owner_not_granted');
    agentOwner = body.agent_owner === null ? null : personRef(body.agent_owner, networkId, hidden);
    if (agentOwner && agentOwner.kind !== 'node') throw new Error('agent_owner_must_be_agent');
  }
  let participants = current ? JSON.parse(current.participants_json || '[]') : [];
  if ('participants' in body) {
    if (!Array.isArray(body.participants) || body.participants.length > 100) throw new Error('invalid_participants');
    const refs = body.participants.map(value => personRef(value, networkId, hidden));
    // 参与人是整体替换:把受限成员看不见的那些节点原样留下,别让他「保存」时静默删掉。
    const keptHidden = hidden ? participants.filter((ref: unknown) => isHiddenRef(ref, hidden)) : [];
    participants = [...new Map([...keptHidden, ...refs].map((ref: PersonRef) => [`${ref.kind}:${ref.id}`, ref])).values()];
  }
  return {
    coerced,
    ownerJson: owner === null ? null : JSON.stringify(owner),
    agentOwnerJson: agentOwner === null ? null : JSON.stringify(agentOwner),
    participantsJson: JSON.stringify(participants),
  };
}

/**
 * 节点令牌(Agent,比如把 GitHub issue 同步进任务的 TM 节点)可用的操作 —— 只在它自己的网络里
 * (令牌绑定的网络,范围由 resolveRestNetworkScope 强制)。删除卡片、管理项目仍然只给人。
 */
const NODE_TOKEN_OPERATIONS: ReadonlySet<string> = new Set<string>(["read", "create", "patch", "checklist_item", "upsert", "projects_read"]);
function operationOf(req: Request, url: URL): string {
  if (/^\/api\/requirements\/projects(\/|$)/.test(url.pathname)) return req.method === "GET" ? "projects_read" : "projects_write";
  if (url.pathname === "/api/requirements/tags/ops") return "tags_write";
  if (req.method === "GET") return "read";
  if (/^\/api\/requirements\/[^/]+\/checklist\/[^/]+$/.test(url.pathname)) return "checklist_item";
  if (url.pathname === "/api/requirements/upsert") return "upsert";
  if (req.method === "DELETE") return "delete";
  if (req.method === "PATCH") return "patch";
  return "create";
}

/**
 * GET /api/requirements 的条件请求:ETag = 响应体的哈希,`If-None-Match` 对上就回 304 空体。
 * app 每 15 s 轮询整张表(生产 500 行 708 KB / gzip 163 KB,中国 → 美国约 0.65 s 纯传输),
 * 绝大多数轮询里表根本没变。按**响应体**算,所以对这个调用方可见的任何字段变了都会变
 * (同一张表不同成员看到的不同,ETag 也不同)。不带 If-None-Match 的旧客户端照旧拿 200 全量。
 */
export function conditionalJson(req: Request, payload: unknown): Response {
  const body = JSON.stringify(payload);
  return conditionalBody(req, body, bodyEtag(body));
}

function bodyEtag(body: string): string {
  return `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

function conditionalBody(req: Request, body: string, etag: string): Response {
  // private:按用户可见范围生成,不能被共享缓存复用;no-cache:每次都要回来验证,不会拿旧表当新的。
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  // ETag 就是正文的哈希:同一份正文的 gzip 结果可以复用(http-gzip.ts)。
  return markGzipReusable(new Response(body, { headers: { ...headers, "Content-Type": "application/json;charset=utf-8" } }), etag);
}

function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some(tag => tag.trim() === "*" || bare(tag) === bare(etag));
}

// tag_ops:有 POST /api/requirements/tags/ops(标签改名 / 合并 / 删除 / 颜色),GET /api/requirements/tags 带 counts / colors / can_manage。
// search:GET 认 q=(服务端搜索,语义同 App 的任务搜索);paging:认 limit / cursor,响应带 has_more / next_cursor。
// list_summary:GET 认 view=summary(不带描述正文与子任务条目,见 toSummary);changes:GET 认 changes=1 + updated_since
// (改过的卡含归档的,加上 deleted 墓碑与 server_time,见 listChanges)。
// events:GET /api/requirements/events —— 字段级的改动流水(谁、何时、旧值 → 新值,requirement-events.ts)。
export const REQUIREMENT_CAPABILITIES = ["agent_owner", "description", "checklist", "projects", "due_datetime", "external_ref", "archived", "agent_api", "sub_requirements", "tags", "priority_lowest", "start_date", "requirement_seq", "search", "paging", "completed_at", "stats", "tag_ops", "list_summary", "changes", "events"] as const;

// ── 子需求 ──
// parent_id:同一网络里的另一张卡;不能成环;最多 5 层(顶层是第 1 层)。删父卡 = 子卡保留、parent_id 置空。
export const MAX_REQUIREMENT_DEPTH = 5;
function levelOf(id: string): number {
  let level = 1;
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return Number.POSITIVE_INFINITY; // 已存在的环(不该有):当作超深,拒绝挂上去
    seen.add(cur);
    const up = db.get<{ parent_id: string | null }>("SELECT parent_id FROM requirements WHERE requirement_id = ?1", cur);
    cur = up?.parent_id ?? null;
    if (cur) level++;
  }
  return level;
}
/** 以 id 为根的子树还有几层(叶子 = 0)。 */
function heightBelow(id: string): number {
  let height = 0;
  let frontier = [id];
  const seen = new Set<string>([id]);
  while (frontier.length && height <= MAX_REQUIREMENT_DEPTH) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const c of db.all<{ requirement_id: string }>("SELECT requirement_id FROM requirements WHERE parent_id = ?1", f)) {
        if (!seen.has(c.requirement_id)) { seen.add(c.requirement_id); next.push(c.requirement_id); }
      }
    }
    if (!next.length) break;
    height++;
    frontier = next;
  }
  return height;
}
/** 校验要挂的父卡:同网络、存在、不是自己或自己的后代(不成环)、挂上后不超过 5 层。返回错误码或 null。 */
function parentError(networkId: string, parentId: string, selfId: string | null): string | null {
  const parent = db.get<{ network_id: string; requirement_id: string }>("SELECT network_id, requirement_id FROM requirements WHERE requirement_id = ?1", parentId);
  if (!parent || parent.network_id !== networkId) return "parent_not_found";
  if (selfId) {
    // 从父卡往上走,碰到自己 = 成环
    let cur: string | null = parentId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === selfId) return "parent_cycle";
      seen.add(cur);
      cur = db.get<{ parent_id: string | null }>("SELECT parent_id FROM requirements WHERE requirement_id = ?1", cur)?.parent_id ?? null;
    }
  }
  const depth = levelOf(parentId) + 1 + (selfId ? heightBelow(selfId) : 0);
  return depth > MAX_REQUIREMENT_DEPTH ? "parent_too_deep" : null;
}
function parentIdOf(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined;
}

// ── 谁做的 ──
// 用户令牌 = {kind:"user", id:user_id};节点令牌 = {kind:"node", id:令牌绑定的 node_id}(老令牌没绑 node_id 时按
// 令牌名里的 alias 在本网络找;都找不到记 token 本身,不冒充任何节点)。写进 created_by / updated_by。
type Actor = { kind: "user" | "node"; id: string };
function actorOf(ctx: RequirementsRequestContext): Actor | null {
  if (!ctx.auth) return null;
  if (!ctx.isNodeToken) return { kind: "user", id: ctx.auth.userId };
  const tokenId = ctx.auth.tokenId ?? null;
  const bound = tokenId ? db.get<{ bound_node_id: string | null }>("SELECT bound_node_id FROM api_tokens WHERE token_id = ?1", tokenId)?.bound_node_id : null;
  if (bound) return { kind: "node", id: bound };
  const alias = ctx.auth.tokenName?.startsWith("node:") ? ctx.auth.tokenName.slice(5) : null;
  if (alias && ctx.auth.networkId) {
    const node = db.get<{ node_id: string }>("SELECT node_id FROM nodes WHERE network_id = ?1 AND alias = ?2", ctx.auth.networkId, alias);
    if (node) return { kind: "node", id: node.node_id };
  }
  return { kind: "node", id: `token:${tokenId ?? "unknown"}` };
}

// ── 外部引用(同步用) ──
// external_ref:如 github:owner/repo#123,同一网络里唯一(部分唯一索引,见 requirements-migrate.ts)。
// external_url:http(s) 链接,给界面显示成「在 GitHub 打开」。
const EXTERNAL_REF = /^[A-Za-z0-9][A-Za-z0-9_.:\/#@+-]{0,199}$/;
function externalRef(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return EXTERNAL_REF.test(v) ? v : undefined;
}
function externalUrl(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return /^https?:\/\/[^\s]{1,500}$/i.test(v) ? v : undefined;
}
function rowByExternalRef(networkId: string, ref: string): Row | undefined {
  return db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE network_id = ?1 AND external_ref = ?2`, networkId, ref) ?? undefined;
}

// ── 新建 ──
async function createRequirement(ctx: RequirementsRequestContext, body: Record<string, unknown>): Promise<Response> {
  const networkId = writeNetwork(body, ctx);
  if (!networkId) return jsonError("network_id_required", 400);
  if (!canWrite(ctx, networkId)) return jsonError("permission_denied", 403);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return jsonError("invalid_name", 400);
  const priority = typeof body.priority === "string" ? body.priority : "normal";
  if (!PRIORITIES.has(priority)) return jsonError("invalid_priority", 400);
  const due = typeof body.due === "string" ? normalizeDue(body.due) : "";
  if (due === null) return jsonError("invalid_due", 400);
  const start = typeof body.start === "string" ? normalizeDue(body.start) : "";
  if (start === null) return jsonError("invalid_start", 400);
  const assignee = typeof body.assignee === "string" ? body.assignee.trim().slice(0, 80) : "";
  const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
  if (clientId && !/^[A-Za-z0-9._-]{1,80}$/.test(clientId)) return jsonError("invalid_client_id", 400);
  const column = typeof body.column === "string" && COLUMNS.has(body.column) ? body.column : "pool";
  const issues = body.issues === undefined ? [] : normalizeIssues(body.issues);
  if (issues === null) return jsonError("invalid_issues", 400);
  const tags = body.tags === undefined ? [] : normalizeTags(body.tags);
  if (tags === null) return jsonError("invalid_tags", 400);
  const description = body.description === undefined ? "" : normalizeDescription(body.description);
  if (description === null) return jsonError("invalid_description", 400);
  const checklist = body.checklist === undefined ? [] : normalizeChecklist(body.checklist);
  if (checklist === null) return jsonError("invalid_checklist", 400);
  const caller = taskCaller(ctx);
  const scoped = !!caller && isTaskScoped(caller.userId, networkId);
  let projectId: string | null = null;
  if (body.project_id !== undefined) {
    try { projectId = projectRef(body.project_id, networkId); } catch (e) { return jsonError((e as Error).message, 400); }
    // scoped 成员只能建进自己 can_edit 的项目;没授权的项目与不存在的项目同一个错误。
    if (!canUseProject(caller, networkId, projectId)) return jsonError("project_not_in_network", 400);
  }
  const ref = body.external_ref === undefined ? null : externalRef(body.external_ref);
  if (ref === undefined) return jsonError("invalid_external_ref", 400);
  // scoped 成员不能带 external_ref:「external_ref_exists」会把别人的卡号回给他。
  if (ref && scoped) return jsonError("external_ref_not_allowed", 403);
  const extUrl = body.external_url === undefined ? null : externalUrl(body.external_url);
  if (extUrl === undefined) return jsonError("invalid_external_url", 400);
  const parentId = body.parent_id === undefined ? null : parentIdOf(body.parent_id);
  if (parentId === undefined) return jsonError("invalid_parent_id", 400);
  if (parentId) {
    const err = parentHidden(ctx, parentId) ? "parent_not_found" : parentError(networkId, parentId, null);
    if (err) return jsonError(err, 400);
  }
  if (ref) {
    const existing = rowByExternalRef(networkId, ref);
    // 同一个外部条目再建一次 = 冲突,回已有的 id(同步方改用 upsert,或按这个 id PATCH)。
    if (existing) return Response.json({ ok: false, error: "external_ref_exists", existing_id: existing.requirement_id }, { status: 409 });
  }
  if (clientId) {
    const existing = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE network_id = ?1 AND client_id = ?2`, networkId, clientId);
    // 重放只回调用者看得见的卡;撞上别人的卡(scoped 看不见)= 固定的 409,不把那张卡回给他。
    if (existing) return canSeeTask(caller, existing) ? Response.json({ ok: true, requirement: toPublicFor(ctx, existing) }) : jsonError("client_id_taken", 409);
  }
  const id = `req_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  let people;
  try { people = assignments(body, networkId, undefined, hiddenNodeFilter(ctx, networkId)); } catch (e) { return jsonError((e as Error).message, 400); }
  const actor = JSON.stringify(actorOf(ctx));
  try {
    // 领号、插入、记「新建」这条动态在同一个事务里:插入被唯一索引挡下时,号和动态一起回滚,不留空洞。
    db.transaction(() => {
      const seq = nextRequirementSeq(db, networkId);
      db.run(
        `INSERT INTO requirements
         (requirement_id, network_id, title, column_name, priority, due_on, assignee, client_id, issues_json, created_by, created_at, updated_at, owner_json, participants_json, agent_owner_json, description, checklist_json, project_id, external_ref, external_url, created_by_json, updated_by_json, archived, parent_id, tags_json, start_on, seq, completed_at, completed_by_json, completed_at_approx)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, 0, ?21, ?22, ?23, ?24, ?25, ?26, 0)`,
        [id, networkId, name, column, priority, due || null, assignee, clientId || null, JSON.stringify(issues), ctx.auth?.userId ?? null, createdAt, people.ownerJson, people.participantsJson, people.agentOwnerJson, description || null, JSON.stringify(checklist), projectId, ref, extUrl, actor, parentId, JSON.stringify(tags), start || null, seq,
          // 直接建在「完成」列 = 此刻完成、由建卡的人完成。
          column === "done" ? createdAt : null, column === "done" ? actor : null],
      );
      recordRequirementEvents(db, { requirement_id: id, network_id: networkId, seq, title: name }, actor, [{ kind: "created", field: null, old: null, new: { title: name, column } }], createdAt);
    });
  } catch {
    // 并发的同一个 external_ref / client_id:唯一索引挡住了第二个,回已有的那条。
    if (ref) {
      const existing = rowByExternalRef(networkId, ref);
      if (existing) return Response.json({ ok: false, error: "external_ref_exists", existing_id: existing.requirement_id }, { status: 409 });
    }
    if (!clientId) return jsonError("insert_failed", 500);
    const existing = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE network_id = ?1 AND client_id = ?2`, networkId, clientId);
    if (!existing) return jsonError("insert_failed", 500);
    if (!canSeeTask(caller, existing)) return jsonError("client_id_taken", 409);
    return Response.json({ ok: true, requirement: toPublicFor(ctx, existing) });
  }
  const created = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, id)!;
  return Response.json(withLegacyOwner(toPublicFor(ctx, created), people.coerced), { status: 201 });
}

// ── 修改(省略的字段保留原值) ──
const PATCH_FIELDS = ["column", "issues", "tags", "name", "priority", "due", "assignee", "owner", "agent_owner", "participants", "description", "checklist", "project_id", "external_ref", "external_url", "archived", "parent_id", "start"];
function patchRequirement(ctx: RequirementsRequestContext, row: Row, body: Record<string, unknown>): Response {
  if (!PATCH_FIELDS.some(k => Object.prototype.hasOwnProperty.call(body, k))) return jsonError("empty_patch", 400);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (!canWrite(ctx, row.network_id)) return jsonError("permission_denied", 403);
  const caller = taskCaller(ctx);
  if (!canEditTask(caller, row)) {
    // 参与人:只放状态和检查项;别的字段点名拒绝。不是参与人 → 与今天一样。
    if (!canParticipantEditTask(caller, row)) return taskDenied(ctx, row, "task_read_only");
    const other = PATCH_FIELDS.find(k => has(k) && !PARTICIPANT_EDIT_FIELDS.includes(k));
    if (other) return taskDenied(ctx, row, "task_read_only", other);
  }
  // scoped 成员不能写 external_ref:唯一索引冲突会泄露别的卡用了这个 ref。
  if (has("external_ref") && caller && isTaskScoped(caller.userId, row.network_id)) return jsonError("external_ref_not_allowed", 403);
  if (has("column") && !COLUMNS.has(String(body.column))) return jsonError("invalid_column", 400);
  const issues = has("issues") ? normalizeIssues(body.issues) : null;
  if (has("issues") && issues === null) return jsonError("invalid_issues", 400);
  const tags = has("tags") ? normalizeTags(body.tags) : null;
  if (has("tags") && tags === null) return jsonError("invalid_tags", 400);
  const description = has("description") ? normalizeDescription(body.description) : null;
  if (has("description") && description === null) return jsonError("invalid_description", 400);
  const checklist = has("checklist") ? normalizeChecklist(body.checklist) : null;
  if (has("checklist") && checklist === null) return jsonError("invalid_checklist", 400);
  let name = row.title;
  if (has("name")) {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return jsonError("invalid_name", 400);
  }
  let priority = row.priority;
  if (has("priority")) {
    if (typeof body.priority !== "string" || !PRIORITIES.has(body.priority)) return jsonError("invalid_priority", 400);
    priority = body.priority;
  }
  let due = row.due_on || "";
  if (has("due")) {
    if (typeof body.due !== "string") return jsonError("invalid_due", 400);
    const next = normalizeDue(body.due);
    if (next === null) return jsonError("invalid_due", 400);
    due = next;
  }
  let start = row.start_on || "";
  if (has("start")) {
    if (typeof body.start !== "string") return jsonError("invalid_start", 400);
    const next = normalizeDue(body.start);
    if (next === null) return jsonError("invalid_start", 400);
    start = next;
  }
  let assignee = row.assignee || "";
  if (has("assignee")) {
    if (typeof body.assignee !== "string") return jsonError("invalid_assignee", 400);
    assignee = body.assignee.trim().slice(0, 80);
  }
  let people;
  try { people = assignments(body, row.network_id, row, hiddenNodeFilter(ctx, row.network_id)); } catch (e) { return jsonError((e as Error).message, 400); }
  let projectId = row.project_id;
  if (has("project_id")) {
    try { projectId = projectRef(body.project_id, row.network_id); } catch (e) { return jsonError((e as Error).message, 400); }
    // scoped 成员只能挪进自己 can_edit 的项目;没授权的项目与不存在的项目同一个错误。
    if (projectId !== row.project_id && !canUseProject(caller, row.network_id, projectId)) return jsonError("project_not_in_network", 400);
  }
  let ref = row.external_ref;
  if (has("external_ref")) {
    const next = externalRef(body.external_ref);
    if (next === undefined) return jsonError("invalid_external_ref", 400);
    if (next && next !== row.external_ref) {
      const taken = rowByExternalRef(row.network_id, next);
      if (taken) return Response.json({ ok: false, error: "external_ref_exists", existing_id: taken.requirement_id }, { status: 409 });
    }
    ref = next;
  }
  let extUrl = row.external_url;
  if (has("external_url")) {
    const next = externalUrl(body.external_url);
    if (next === undefined) return jsonError("invalid_external_url", 400);
    extUrl = next;
  }
  let parentId = row.parent_id;
  if (has("parent_id")) {
    const next = parentIdOf(body.parent_id);
    if (next === undefined) return jsonError("invalid_parent_id", 400);
    if (next) {
      const err = parentHidden(ctx, next) ? "parent_not_found" : parentError(row.network_id, next, row.requirement_id);
      if (err) return jsonError(err, 400);
    }
    parentId = next;
  }
  let archived = row.archived ? 1 : 0;
  if (has("archived")) {
    if (typeof body.archived !== "boolean") return jsonError("invalid_archived", 400);
    archived = body.archived ? 1 : 0;
  }
  const updatedAt = new Date().toISOString();
  const column = has("column") ? String(body.column) : row.column_name;
  const actor = JSON.stringify(actorOf(ctx));
  // 完成时间:移进「完成」= 此刻 + 这次的操作者;移出 = 清空;留在「完成」(done → done、改别的字段)= 原样不动。
  const completed = column !== "done" ? { at: null, by: null, approx: 0 }
    : row.column_name !== "done" ? { at: updatedAt, by: actor, approx: 0 }
    : { at: row.completed_at, by: row.completed_by_json, approx: row.completed_at_approx ? 1 : 0 };
  // 改卡和记动态(改前 row → 改后 updated 的字段差异)在同一个事务里:要么都在,要么都不在。
  const updated = db.transaction(() => {
    db.run(
      `UPDATE requirements SET column_name = ?1, updated_at = ?2, title = ?7, priority = ?8, due_on = ?9, assignee = ?10, owner_json = ?4, participants_json = ?5, issues_json = ?6,
         agent_owner_json = ?11, description = ?12, checklist_json = ?13, project_id = ?14, external_ref = ?15, external_url = ?16, archived = ?17, updated_by_json = ?18, parent_id = ?19, tags_json = ?20, start_on = ?21,
         completed_at = ?22, completed_by_json = ?23, completed_at_approx = ?24
       WHERE requirement_id = ?3`,
      [column, updatedAt, row.requirement_id, people.ownerJson, people.participantsJson, has("issues") ? JSON.stringify(issues) : row.issues_json, name, priority, due || null, assignee, people.agentOwnerJson,
        has("description") ? (description || null) : row.description, has("checklist") ? JSON.stringify(checklist) : row.checklist_json, projectId, ref, extUrl, archived, actor, parentId, has("tags") ? JSON.stringify(tags) : row.tags_json, start || null,
        completed.at, completed.by, completed.approx],
    );
    const after = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, row.requirement_id)!;
    recordRequirementEvents(db, after, actor, diffRequirement(row, after), updatedAt);
    return after;
  });
  notifyIfParticipant(ctx, row, updated);
  return Response.json(withLegacyOwner(toPublicFor(ctx, updated), people.coerced));
}

/**
 * 被兼容改写的请求(旧客户端):响应里的 owner 按旧客户端的理解回显那个节点(它会拿响应核对「保存生效没有」,
 * 0.2.142 的核对不通过就报「这个 Hub 还不能修改」),真实存储是 owner 空、agent_owner = 节点;agent_owner 也一并返回。
 * GET 不这么做:新 App 读 owner / agent_owner 两个字段,GET 回显会让新 App 把 Agent 当成负责人。
 */
function withLegacyOwner(requirement: ReturnType<typeof toPublic>, coerced: PersonRef | null) {
  if (!coerced) return { ok: true, requirement };
  return { ok: true, requirement: { ...requirement, owner: coerced }, owner_coerced_to_agent_owner: true };
}

/** 「#123」→ 123;别的形状(包括裸数字)→ null,仍按 requirement_id 查。 */
export function seqFromId(id: string): number | null {
  const m = /^#([1-9]\d{0,14})$/.exec(id.trim());
  return m ? Number(m[1]) : null;
}

/**
 * 按 id 或「#N」找调用者作用域里的那张卡。短号只在一个网络里唯一:作用域跨多个网络、又各有一张 #N 时
 * 不猜,回 409 ambiguous_seq(带 ?network_id= 再查)。
 */
function scopedRow(ctx: RequirementsRequestContext, id: string): Row | Response {
  const seq = seqFromId(id);
  const params: unknown[] = [seq ?? id];
  let sql = `SELECT ${SELECT} FROM requirements WHERE ${seq === null ? "requirement_id" : "seq"} = ?1`;
  sql = addHumanNetworkScope(sql, params, ctx.scope);
  // 看不见的卡与不存在的卡同一个 404(逐字节相同);#N 的 ambiguous_seq 也只在看得见的行里判定。
  sql = addTaskVisibilityScope(sql, params, taskCaller(ctx));
  const rows = db.all<Row>(`${sql} LIMIT 2`, ...params);
  if (rows.length > 1) {
    const networks = rows.map(r => r.network_id);
    return Response.json({ ok: false, error: "ambiguous_seq", networks, message: `#${seq} exists in more than one network you can see (${networks.join(", ")}); pass network_id to pick one` }, { status: 409 });
  }
  return rows[0] ?? jsonError("requirement_not_found", 404);
}

/** GET 的筛选(同步方 / MCP 用):seq(短号)、status、project_id、owner / agent_owner(kind:id)、updated_since、external_ref、parent_id / top_level、include_archived。 */
function listFilters(url: URL, sql: string, params: unknown[], ctx?: RequirementsRequestContext): string | Response {
  const q = url.searchParams;
  const status = q.get("status");
  if (status !== null) {
    if (!COLUMNS.has(status)) return jsonError("invalid_status", 400);
    sql += ` AND column_name = ?${params.push(status)}`;
  }
  const project = q.get("project_id");
  if (project !== null) sql += project === "none" ? " AND project_id IS NULL" : ` AND project_id = ?${params.push(project)}`;
  for (const [param, column] of [["owner", "owner_json"], ["agent_owner", "agent_owner_json"]] as const) {
    const v = q.get(param);
    if (v === null) continue;
    if (v === "none") { sql += ` AND ${column} IS NULL`; continue; }
    const m = /^(user|node):(.+)$/.exec(v);
    if (!m) return jsonError(`invalid_${param}`, 400);
    // 受限成员按一个没授权给他的节点筛选:与「没有这样的卡」同一结果(否则是「谁负责这张卡」的探测器)。
    if (m[1] === "node" && ctx && hiddenFilterForScope(ctx, m[2])) { sql += " AND 1=0"; continue; }
    sql += ` AND ${column} = ?${params.push(JSON.stringify({ kind: m[1], id: m[2] }))}`;
  }
  const since = q.get("updated_since");
  if (since !== null) {
    const ms = Date.parse(since);
    if (!Number.isFinite(ms)) return jsonError("invalid_updated_since", 400);
    sql += ` AND updated_at >= ?${params.push(new Date(ms).toISOString())}`;
  }
  const seq = q.get("seq");
  if (seq !== null) {
    if (!/^[1-9]\d{0,14}$/.test(seq)) return jsonError("invalid_seq", 400);
    sql += ` AND seq = ?${params.push(Number(seq))}`;
  }
  const ref = q.get("external_ref");
  if (ref !== null) sql += ` AND external_ref = ?${params.push(ref)}`;
  const parent = q.get("parent_id");
  if (parent !== null) sql += parent === "none" ? " AND parent_id IS NULL" : ` AND parent_id = ?${params.push(parent)}`;
  if (q.get("top_level") === "1") sql += " AND parent_id IS NULL";
  // Explicit archived-only wins over the legacy include-all switch.
  // changes=1 看得见「被归档」这一改动:默认连归档的一起回(行上 archived: true),客户端据此把它移出看板。
  if (q.get("archived") === "true") sql += " AND COALESCE(archived, 0) = 1";
  else if (q.get("include_archived") !== "1" && q.get("changes") !== "1") sql += " AND COALESCE(archived, 0) = 0";
  return sql;
}

const LIST_ORDER = " ORDER BY created_at DESC, requirement_id DESC";
type LightRow = { requirement_id: string; seq?: number | null; network_id: string; created_at: string; title: string; description: string | null; assignee: string | null; tags_json: string | null; project_id: string | null; owner_json: string | null; agent_owner_json: string | null; participants_json: string | null };
const parseRef = (json: string | null) => { try { return json ? JSON.parse(json) : null; } catch { return null; } };

/**
 * 列表的一页(from = listFilters 拼好的「FROM requirements WHERE …」)。没有搜索词:SQL 直接 LIMIT。有搜索词:先按同样的筛选 + 顺序读轻量列(不算子需求计数),
 * 在这里逐行匹配,凑够 limit + 1 张就停,再按 id 读这一页的完整行。
 */
function listPage(ctx: RequirementsRequestContext, from: string, baseParams: unknown[], lq: ListQuery): { rows: Row[]; hasMore: boolean; nextCursor: string | null } {
  const params = [...baseParams];
  let where = from;
  if (lq.cursor) {
    const a = params.push(lq.cursor.createdAt), b = params.push(lq.cursor.id);
    where += ` AND (created_at < ?${a} OR (created_at = ?${a} AND requirement_id < ?${b}))`;
  }
  let rows: Row[];
  if (!lq.terms.length) {
    rows = db.all<Row>(`SELECT ${SELECT} ${where}${LIST_ORDER} LIMIT ${lq.limit + 1}`, ...params);
  } else {
    // seq(任务短号,#2139):启动迁移 ensureRequirementSeq 在 SQLite / PostgreSQL 上都加这一列,SELECT 本来就带它。
    const light = db.all<LightRow>(`SELECT requirement_id, seq, network_id, created_at, title, description, assignee, tags_json, project_id, owner_json, agent_owner_json, participants_json ${where}${LIST_ORDER}`, ...params);
    const maps = new Map<string, NameMaps>();
    const hits: string[] = [];
    for (const r of light) {
      let m = maps.get(r.network_id);
      if (!m) maps.set(r.network_id, m = searchNameMaps(ctx, r.network_id));
      const row = { name: r.title, description: r.description || "", assignee: r.assignee || "", tags: storedTags(r.tags_json), project_id: r.project_id, owner: parseRef(r.owner_json), agent_owner: parseRef(r.agent_owner_json), participants: parseRef(r.participants_json) ?? [] };
      if (matchesTaskId(r, lq.idQuery) || matchesTerms(row, lq.terms, m)) hits.push(r.requirement_id);
      if (hits.length > lq.limit) break;
    }
    const byId = new Map(hits.length ? db.all<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id IN (${hits.map((_, i) => `?${i + 1}`).join(",")})`, ...hits).map(r => [r.requirement_id, r]) : []);
    rows = hits.map(id => byId.get(id)).filter((r): r is Row => !!r);
  }
  const hasMore = rows.length > lq.limit;
  if (hasMore) rows = rows.slice(0, lq.limit);
  const last = rows[rows.length - 1];
  return { rows, hasMore, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.requirement_id }) : null };
}

/** 搜索用的名字表(与 GET /api/requirements/people 同一个显示名规则);调用者看不见的节点不放进来。 */
function searchNameMaps(ctx: RequirementsRequestContext, networkId: string): NameMaps {
  const hidden = hiddenNodeFilter(ctx, networkId);
  const people = new Map<string, string>();
  for (const u of db.all<{ id: string; name: string }>("SELECT u.user_id AS id, COALESCE(NULLIF(u.display_name,''), u.username) AS name FROM network_members m JOIN users u ON u.user_id=m.user_id WHERE m.network_id=?1", networkId)) people.set(`user:${u.id}`, u.name);
  for (const n of db.all<{ id: string; name: string }>("SELECT node_id AS id, COALESCE(NULLIF(display_name,''), NULLIF(alias,''), node_name) AS name FROM nodes WHERE network_id=?1", networkId)) if (!hidden?.(n.id)) people.set(`node:${n.id}`, n.name);
  const projects = new Map(db.all<{ project_id: string; name: string }>("SELECT project_id, name FROM requirement_projects WHERE network_id=?1", networkId).map(p => [p.project_id, p.name] as const));
  return { people, projects };
}

/** 这个节点对调用者在他作用域内的某个受限网络里是否隐藏。 */
function hiddenFilterForScope(ctx: RequirementsRequestContext, nodeId: string): boolean {
  const restricted = ctx.scope.agentRestriction?.networkIds ?? [];
  for (const networkId of restricted) {
    const hidden = hiddenNodeFilter(ctx, networkId);
    if (hidden?.(nodeId)) return true;
  }
  return false;
}

// ── 列表省流(2026-09-30,App「连接较慢 · 数据可能稍有延迟」)──
// 生产:425 张卡、1447 条子任务,整张表 1 MB(gzip 240 KB),任务页每 15 s 读一次;中国经 RELAY 的链路上
// 一次要好几秒。三件事,都是加法,旧 App 不带新参数就与原来逐字相同:
//   1. view=summary:不带描述正文和子任务条目(打开一张卡再 GET /api/requirements/:id 读全文);
//   2. changes=1 + updated_since:只回这之后改过的卡(含归档的),加上删掉的卡的 id 和下次用的 server_time;
//   3. 表没变时不重算:按「调用者 + 查询」缓存上一次的正文和 ETag,需求表一有写入就作废(见 requirementsGeneration)。

/** view=summary 的一行:去掉 description / checklist,换成 has_description 和 checklist_count。 */
function toSummary<T extends { description: string; checklist: ChecklistItem[] }>(pub: T): Omit<T, "description" | "checklist"> & { has_description: boolean; checklist_count: { total: number; done: number } } {
  const { description, checklist, ...rest } = pub;
  return { ...rest, has_description: !!description, checklist_count: { total: checklist.length, done: checklist.filter(item => item.done).length } };
}

/** 墓碑保留多久。changes 的 updated_since 早于这之前,删除就可能漏报 —— 响应里的 tombstones_since 告诉客户端这个下限。 */
export const TOMBSTONE_RETENTION_MS = 30 * 86_400_000;

/** 删卡时留一条墓碑(连同判断「谁看得见」要用的列,受限成员只收到他本来看得见的卡的删除)。 */
function recordTombstone(row: Row, deletedAt: string): void {
  db.run(
    `INSERT INTO requirement_tombstones (requirement_id, network_id, deleted_at, project_id, owner_json, participants_json, created_by, created_by_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(requirement_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
    [row.requirement_id, row.network_id, deletedAt, row.project_id || null, row.owner_json || null, row.participants_json || null, row.created_by || null, row.created_by_json || null],
  );
  db.run("DELETE FROM requirement_tombstones WHERE deleted_at < ?1", [new Date(Date.parse(deletedAt) - TOMBSTONE_RETENTION_MS).toISOString()]);
}

type TombstoneRow = { requirement_id: string; network_id: string; deleted_at: string; project_id: string | null; owner_json: string | null; participants_json: string | null; created_by: string | null; created_by_json: string | null };

/** updated_since 之后删掉的、调用者看得见的卡。同 id 又出现在表里的(不该有)不算删除。 */
function deletedSince(ctx: RequirementsRequestContext, sinceIso: string): string[] {
  const params: unknown[] = [sinceIso];
  let sql = "SELECT requirement_id, network_id, deleted_at, project_id, owner_json, participants_json, created_by, created_by_json FROM requirement_tombstones WHERE deleted_at >= ?1";
  sql = addHumanNetworkScope(sql, params, ctx.scope);
  sql += " AND requirement_id NOT IN (SELECT requirement_id FROM requirements) ORDER BY deleted_at, requirement_id";
  const caller = taskCaller(ctx);
  return db.all<TombstoneRow>(sql, ...params).filter(row => canSeeTask(caller, row)).map(row => row.requirement_id);
}

// ── 任务动态(requirement-events.ts)──
// GET /api/requirements/events?network_id&since&limit&cursor&requirement_id:一个网络的改动流水,按 id 从新到旧。
// 可见范围与列表相同:卡还在 → 按当前这张卡判断调用者看不看得见;删掉了 → 按墓碑(过了墓碑保留期的删除,
// 只有不受任务范围限制的调用者看得到)。受限成员看不见的节点:操作者隐去,负责人 / 负责 Agent / 参与人里的隐去,
// 隐去之后前后一样的那条整条不回(否则是「这张卡的 Agent 换过」的探测器)。
// 按可见性过滤是在读出来之后做的:一页最多扫 EVENTS_SCAN_MAX 条,扫满还没凑够就带 next_cursor 回去,客户端接着翻。
const EVENTS_PAGE_DEFAULT = 200;
const EVENTS_PAGE_MAX = 500;
const EVENTS_SCAN_MAX = 5000;
type VisibilityRow = { network_id: string; owner_json: string | null; participants_json: string | null; created_by: string | null; created_by_json: string | null; project_id: string | null };

function listEvents(ctx: RequirementsRequestContext): Response {
  const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
  if (!networkId) return jsonError("network_id_required", 400);
  const q = ctx.url.searchParams;
  const limit = q.get("limit") === null ? EVENTS_PAGE_DEFAULT : Number(q.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_PAGE_MAX) return jsonError("invalid_limit", 400);
  let since: string | null = null;
  if (q.get("since") !== null) {
    const ms = Date.parse(q.get("since")!);
    if (!Number.isFinite(ms)) return jsonError("invalid_since", 400);
    since = new Date(ms).toISOString();
  }
  const cursor = q.get("cursor");
  if (cursor !== null && !/^[1-9]\d{0,17}$/.test(cursor)) return jsonError("invalid_cursor", 400);
  const card = q.get("requirement_id");
  // server_time 取在读表之前:下次拿它当 since,读的期间写进来的不会漏(>= 会重复回,客户端按 id 去重)。
  const serverTime = new Date().toISOString();
  const caller = taskCaller(ctx);
  const hidden = hiddenNodeFilter(ctx, networkId);
  const seen = new Map<string, boolean>();
  const canSee = (id: string): boolean => {
    if (!caller) return true;
    let ok = seen.get(id);
    if (ok === undefined) {
      const cols = "network_id, owner_json, participants_json, created_by, created_by_json, project_id";
      const row = db.get<VisibilityRow>(`SELECT ${cols} FROM requirements WHERE requirement_id = ?1`, id)
        ?? db.get<VisibilityRow>(`SELECT ${cols} FROM requirement_tombstones WHERE requirement_id = ?1`, id);
      seen.set(id, ok = !!row && row.network_id === networkId && canSeeTask(caller, row));
    }
    return ok;
  };
  const shown = (row: EventRow) => {
    if (!canSee(row.requirement_id)) return null;
    const ev = eventPublic(row);
    if (!hidden) return ev;
    const mask = (ref: unknown) => (isHiddenRef(ref, hidden) ? null : ref);
    const masked = { ...ev, actor: mask(ev.actor) };
    if (ev.field === "owner" || ev.field === "agent_owner") { masked.old = mask(ev.old); masked.new = mask(ev.new); }
    if (ev.field === "participants") {
      masked.old = Array.isArray(ev.old) ? ev.old.filter(ref => !isHiddenRef(ref, hidden)) : ev.old;
      masked.new = Array.isArray(ev.new) ? ev.new.filter(ref => !isHiddenRef(ref, hidden)) : ev.new;
    }
    return ev.field && JSON.stringify(masked.old) === JSON.stringify(masked.new) ? null : masked;
  };
  const events: ReturnType<typeof eventPublic>[] = [];
  let before = cursor === null ? null : Number(cursor);
  let scanned = 0;
  let nextCursor: string | null = null;
  scan: for (;;) {
    const params: unknown[] = [networkId];
    let sql = "SELECT id, network_id, requirement_id, seq, title, actor_json, kind, field, old_json, new_json, created_at FROM requirement_events WHERE network_id = ?1";
    if (since) sql += ` AND created_at >= ?${params.push(since)}`;
    if (card) sql += ` AND requirement_id = ?${params.push(card)}`;
    if (before !== null) sql += ` AND id < ?${params.push(before)}`;
    const batch = db.all<EventRow>(`${sql} ORDER BY id DESC LIMIT ${limit + 1}`, ...params);
    for (const row of batch) {
      const ev = shown(row);
      if (ev && events.length === limit) { nextCursor = events[events.length - 1].id; break scan; }
      scanned++;
      before = Number(row.id);
      if (ev) events.push(ev);
    }
    if (batch.length < limit + 1) break;
    // 扫满了(调用者看不见的太多):从扫到的地方接着翻。
    if (scanned >= EVENTS_SCAN_MAX) { nextCursor = String(before); break; }
  }
  return Response.json({ ok: true, network_id: networkId, events, has_more: nextCursor !== null, next_cursor: nextCursor, server_time: serverTime });
}

/**
 * 需求表的写入代数:每个经过 handleRequirementsRequest 的非 GET 请求处理完就 +1(REST 和 MCP 的写入都走它,
 * tools.ts 调的是同一个处理函数)。列表缓存只在代数没变时复用。进程重启 = 缓存清空。
 */
let requirementsGeneration = 0;
/** 缓存条目最长信任这么久:兜住不经过处理函数的改动(启动迁移、运维脚本直接改库)。 */
export const LIST_CACHE_MAX_AGE_MS = 60_000;
/** 只缓存不带搜索词的列表(搜索每打一个字就是一个新键),总共最多这么多字符(条目按最近使用淘汰)。 */
const LIST_CACHE_MAX_CHARS = 16 * 1024 * 1024;
type ListCacheEntry = { generation: number; acl: string; at: number; body: string; etag: string };
const listCache = new Map<string, ListCacheEntry>();
let listCacheChars = 0;
function rememberList(key: string, entry: ListCacheEntry): void {
  const old = listCache.get(key);
  if (old) { listCache.delete(key); listCacheChars -= old.body.length; }
  if (entry.body.length > LIST_CACHE_MAX_CHARS / 4) return;
  listCache.set(key, entry);
  listCacheChars += entry.body.length;
  for (const [k, v] of listCache) {
    if (listCacheChars <= LIST_CACHE_MAX_CHARS) break;
    listCache.delete(k);
    listCacheChars -= v.body.length;
  }
}

/**
 * 缓存能不能用、以及调用者权限的指纹。null = 这个调用者不缓存:受限成员(看得见哪些 Agent 取决于节点表)
 * 和「只看相关任务」的成员(看得见哪些卡取决于项目授权)每次照旧现算。
 * 其余调用者的输出只取决于需求表本身 + 他的角色 / 成员行:这些都放进指纹,变了就不命中。
 */
function listCacheAcl(ctx: RequirementsRequestContext): string | null {
  const caller = taskCaller(ctx);
  if (!caller) return `open:${ctx.isAdmin ? 1 : 0}:${ctx.isNodeToken ? 1 : 0}`;
  if (restrictedNetworkIds(caller.userId).length > 0) return null;
  const members = db.all<Record<string, unknown>>("SELECT * FROM network_members WHERE user_id = ?1 ORDER BY network_id", caller.userId);
  const networks = members.map(m => String(m.network_id));
  if (networks.some(networkId => isTaskScoped(caller.userId, networkId))) return null;
  const role = db.get<{ role: string | null }>("SELECT role FROM users WHERE user_id = ?1", caller.userId)?.role ?? null;
  return JSON.stringify({ role, members });
}

function listCacheKey(ctx: RequirementsRequestContext): string {
  const sorted = [...ctx.url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ u: ctx.auth?.userId ?? null, n: ctx.auth?.networkId ?? null, a: ctx.isAdmin, t: ctx.isNodeToken, s: ctx.scope, q: sorted });
}

/** Test-only. */
export function __requirementsListCacheForTest() {
  return { size: () => listCache.size, clear: () => { listCache.clear(); listCacheChars = 0; }, generation: () => requirementsGeneration };
}

export async function handleRequirementsRequest(ctx: RequirementsRequestContext): Promise<Response | null> {
  const { url } = ctx;
  if (url.pathname !== "/api/requirements" && !url.pathname.startsWith("/api/requirements/")) return null;
  if (ctx.req.method === "GET") return handleRequirementsRequestInner(ctx);
  // 写完(成功与否)才 +1:之后的 GET 一定看得见这次写入。
  try { return await handleRequirementsRequestInner(ctx); } finally { requirementsGeneration++; }
}

async function handleRequirementsRequestInner(ctx: RequirementsRequestContext): Promise<Response | null> {
  const { req, url } = ctx;
  // 节点令牌只能做 NODE_TOKEN_OPERATIONS 里的事(读 / 建 / 改 / 勾子任务 / upsert / 读项目),
  // 而且只在它绑定的网络里 —— 范围由 scope 强制,写入再由 canWrite 核一次。
  if (ctx.isNodeToken && !NODE_TOKEN_OPERATIONS.has(operationOf(req, url))) return jsonError("user_token_required", 403);

  if (url.pathname === "/api/requirements/projects" || url.pathname.startsWith("/api/requirements/projects/")) return handleProjects(ctx);

  if (url.pathname === "/api/requirements/tags" && req.method === "GET") {
    const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
    if (!networkId) return jsonError("network_id_required", 400);
    const tagParams: unknown[] = [networkId];
    const tagSql = addTaskVisibilityScope("SELECT tags_json FROM requirements WHERE network_id=?1", tagParams, taskCaller(ctx));
    const rows = db.all<{ tags_json: string | null }>(tagSql, ...tagParams);
    // counts:调用者看得见的卡里(含归档)每个标签用了几张;colors:只回这些标签的颜色(看不见的卡上的标签不外泄)。
    // can_manage:这个调用者能不能用 /tags/ops。旧 App 只读 tags,多出的字段忽略。
    const counts: Record<string, number> = {};
    for (const row of rows) for (const tag of storedTags(row.tags_json)) counts[tag] = (counts[tag] ?? 0) + 1;
    const tags = Object.keys(counts).sort();
    const colors: Record<string, string> = {};
    for (const row of db.all<{ name: string; color: string }>("SELECT name, color FROM network_tags WHERE network_id = ?1", networkId)) {
      if (counts[row.name]) colors[row.name] = row.color;
    }
    return Response.json({ ok: true, networkId, tags, counts, colors, can_manage: canManageTags(ctx, networkId) });
  }

  if (url.pathname === "/api/requirements/tags/ops") {
    if (req.method !== "POST") return jsonError("not_found", 404);
    return handleTagOp(ctx);
  }

  // 仪表盘聚合(requirements-stats.ts):一个网络、调用者看得见的卡(与列表同一个可见范围),含归档的卡 ——
  // 完成的卡常被归档,不算它们「今天完成了多少」就会偏少。
  if (url.pathname === "/api/requirements/stats" && req.method === "GET") {
    const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
    if (!networkId) return jsonError("network_id_required", 400);
    const sq = parseStatsQuery(url.searchParams, Date.now());
    if ("error" in sq) return jsonError(sq.error, 400);
    const statsParams: unknown[] = [networkId];
    const statsSql = addTaskVisibilityScope(
      "SELECT requirement_id, seq, title, project_id, column_name, archived, created_at, completed_at, completed_at_approx, completed_by_json FROM requirements WHERE network_id = ?1",
      statsParams, taskCaller(ctx),
    );
    const rows = db.all<StatsRow>(statsSql, ...statsParams);
    return conditionalJson(ctx.req, { ok: true, networkId, ...aggregateStats(rows, sq, hiddenNodeFilter(ctx, networkId)) });
  }

  if (url.pathname === "/api/requirements/events" && req.method === "GET") return listEvents(ctx);

  if (url.pathname === '/api/requirements/people' && req.method === 'GET') {
    const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
    if (!networkId) return jsonError('network_id_required', 400);
    // name = 显示用的名字(没设 display_name 时回落到用户名 / alias,旧 app 只读它);display_name 单独给出、没设为 ""
    // —— 分享图等对外场景据此判断「只有用户名」,不把 admin 之类的账号名印出去。
    // 成员的 display_name 等于用户名也算「没设」:register() 在没给显示名时存的就是 username(auth.ts),
    // 否则没设过显示名的账号(比如 admin)照样把账号名当显示名送出去。
    const users = db.all<{ id: string; name: string; display_name: string }>(
      "SELECT u.user_id AS id, COALESCE(NULLIF(u.display_name,''), u.username) AS name, CASE WHEN u.display_name IS NULL OR u.display_name = '' OR u.display_name = u.username THEN '' ELSE u.display_name END AS display_name FROM network_members m JOIN users u ON u.user_id=m.user_id WHERE m.network_id=?1 ORDER BY name, id", networkId,
    );
    const hidden = hiddenNodeFilter(ctx, networkId);
    const nodes = db.all<{ id: string; name: string; display_name: string }>(
      "SELECT node_id AS id, COALESCE(NULLIF(display_name,''), NULLIF(alias,''), node_name) AS name, COALESCE(display_name,'') AS display_name FROM nodes WHERE network_id=?1 ORDER BY name, id", networkId,
    ).filter(row => !hidden?.(row.id));
    return Response.json({ ok: true, people: [...users.map(row => ({ ...row, kind: 'user', networkId })), ...nodes.map(row => ({ ...row, kind: 'node', networkId }))] });
  }

  if (url.pathname === "/api/requirements" && req.method === "GET") {
    const params: unknown[] = [];
    // 只拼 FROM … WHERE:同一组条件既用来读整行,也用来(搜索时)先读轻量列。
    let sql = "FROM requirements WHERE 1=1";
    sql = addHumanNetworkScope(sql, params, ctx.scope);
    sql = addTaskVisibilityScope(sql, params, taskCaller(ctx));
    const filtered = listFilters(url, sql, params, ctx);
    if (typeof filtered !== "string") return filtered;
    // q= / limit / cursor(requirements-search.ts)。都不带 = 旧行为:最新 500 张、同样的顺序。
    const lq = parseListQuery(url.searchParams);
    if ("error" in lq) return jsonError(lq.error, 400);
    const view = url.searchParams.get("view");
    if (view !== null && view !== "full" && view !== "summary") return jsonError("invalid_view", 400);
    const changes = url.searchParams.get("changes") === "1";
    if (changes && url.searchParams.get("updated_since") === null) return jsonError("updated_since_required", 400);
    // changes 模式:server_time 取在读表之前,下次拿它当 updated_since,读表期间的写入不会漏(>= 会重复回一次,客户端按 id 覆盖)。
    const serverTime = new Date().toISOString();
    const cacheKey = changes || url.searchParams.get("q") ? null : listCacheKey(ctx);
    const acl = cacheKey ? listCacheAcl(ctx) : null;
    const generation = requirementsGeneration;
    const cached = cacheKey && acl !== null ? listCache.get(cacheKey) : undefined;
    if (cached && cached.generation === generation && cached.acl === acl && Date.now() - cached.at < LIST_CACHE_MAX_AGE_MS) {
      listCache.delete(cacheKey!);
      listCache.set(cacheKey!, cached);
      return conditionalBody(ctx.req, cached.body, cached.etag);
    }
    const page = listPage(ctx, filtered, params, lq);
    const rows = page.rows.map(row => toPublicFor(ctx, row));
    // capabilities:客户端按这个决定显示哪些功能(预计完成能不能带时刻、有没有项目…),不用靠猜字段。
    // has_more / next_cursor:后面还有没有(带 cursor=next_cursor 再读一页)。旧客户端不认识,忽略即可。
    const payload: Record<string, unknown> = { ok: true, requirements: view === "summary" ? rows.map(toSummary) : rows, capabilities: REQUIREMENT_CAPABILITIES, has_more: page.hasMore, next_cursor: page.nextCursor };
    if (view === "summary") payload.view = "summary";
    if (changes) {
      const since = new Date(Date.parse(url.searchParams.get("updated_since")!)).toISOString();
      payload.deleted = deletedSince(ctx, since);
      payload.server_time = serverTime;
      payload.tombstones_since = new Date(Date.parse(serverTime) - TOMBSTONE_RETENTION_MS).toISOString();
    }
    const body = JSON.stringify(payload);
    const etag = bodyEtag(body);
    if (cacheKey && acl !== null) rememberList(cacheKey, { generation, acl, at: Date.now(), body, etag });
    return conditionalBody(ctx.req, body, etag);
  }

  if (url.pathname === "/api/requirements" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    return createRequirement(ctx, body);
  }

  // 按 external_ref 建或改(同步用,幂等):同一网络里已有这个 external_ref → 按 PATCH 语义改它
  // (省略的字段保留,包括状态);没有 → 新建。重复同步同一个 issue 只会改,不会重复建。
  if (url.pathname === "/api/requirements/upsert" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    const ref = externalRef(body.external_ref);
    if (!ref) return jsonError("external_ref_required", 400);
    const networkId = writeNetwork(body, ctx);
    if (!networkId) return jsonError("network_id_required", 400);
    if (!canWrite(ctx, networkId)) return jsonError("permission_denied", 403);
    // scoped 成员不能用同步接口:external_ref 的唯一索引会把「这个 ref 已经有卡」泄露出去。固定错误,不看 ref。
    if (taskCaller(ctx) && isTaskScoped(ctx.auth!.userId, networkId)) return jsonError("upsert_not_allowed", 403);
    const existing = rowByExternalRef(networkId, ref);
    if (!existing) {
      const res = await createRequirement(ctx, body);
      if (res.status !== 201) return res;
      const data = await res.json() as Record<string, unknown>;
      return Response.json({ ...data, created: true }, { status: 201 });
    }
    const { external_ref: _ref, network_id: _net, client_id: _client, ...patch } = body;
    if (!PATCH_FIELDS.some(k => Object.prototype.hasOwnProperty.call(patch, k))) return Response.json({ ok: true, requirement: toPublicFor(ctx, existing), created: false });
    const res = patchRequirement(ctx, existing, patch);
    if (res.status !== 200) return res;
    const data = await res.json() as Record<string, unknown>;
    return Response.json({ ...data, created: false });
  }

  const itemMatch = url.pathname.match(/^\/api\/requirements\/([^/]+)\/checklist\/([^/]+)$/);
  if (itemMatch) {
    if (req.method !== "PATCH") return jsonError("not_found", 404);
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    if (typeof body.done !== "boolean") return jsonError("invalid_done", 400);
    const row = scopedRow(ctx, decodeURIComponent(itemMatch[1]));
    if (row instanceof Response) return row;
    if (!canWrite(ctx, row.network_id)) return jsonError("permission_denied", 403);
    if (!canEditTask(taskCaller(ctx), row) && !canParticipantEditTask(taskCaller(ctx), row)) return taskDenied(ctx, row, "task_read_only");
    // 读-改-写在同一个同步段里完成(中间没有 await),同一进程里的两次勾选不会交错。
    const items = storedChecklist(row.checklist_json);
    const itemId = decodeURIComponent(itemMatch[2]);
    const item = items.find(entry => entry.id === itemId);
    if (!item) return jsonError("checklist_item_not_found", 404);
    const was = item.done;
    item.done = body.done;
    const at = new Date().toISOString();
    const actor = JSON.stringify(actorOf(ctx));
    const updated = db.transaction(() => {
      db.run("UPDATE requirements SET checklist_json = ?1, updated_at = ?2, updated_by_json = ?3 WHERE requirement_id = ?4", [JSON.stringify(items), at, actor, row.requirement_id]);
      // 重复勾同一个值(done 是显式值,幂等)不算一次改动,不记。
      if (was !== item.done) recordRequirementEvents(db, row, actor, [{ kind: "changed", field: "checklist_item", old: { ...item, done: was }, new: { ...item } }], at);
      return db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, row.requirement_id)!;
    });
    notifyIfParticipant(ctx, row, updated);
    return Response.json({ ok: true, requirement: toPublicFor(ctx, updated) });
  }

  const match = url.pathname.match(/^\/api\/requirements\/([^/]+)$/);
  if (!match) return jsonError("not_found", 404);
  const id = decodeURIComponent(match[1]);
  if (req.method === "GET") {
    const row = scopedRow(ctx, id);
    return row instanceof Response ? row : Response.json({ ok: true, requirement: toPublicFor(ctx, row) });
  }
  if (req.method === "DELETE") {
    // 删除只给人(节点令牌在入口已被拒):Agent 用 archived 归档。
    const row = scopedRow(ctx, id);
    if (row instanceof Response) return row;
    if (!canWrite(ctx, row.network_id)) return jsonError("permission_denied", 403);
    if (!canDeleteTask(taskCaller(ctx), row)) return taskDenied(ctx, row, "task_delete_denied");
    // 子需求不跟着删:先解挂(变成顶层),再删父卡。
    const deletedAt = new Date().toISOString();
    db.transaction(() => {
      db.run("UPDATE requirements SET parent_id = NULL, updated_at = ?2 WHERE parent_id = ?1", [row.requirement_id, deletedAt]);
      db.run("DELETE FROM requirements WHERE requirement_id = ?1", [row.requirement_id]);
      recordTombstone(row, deletedAt);
      // 卡没了,动态里还要画得出「谁删了 #N 标题」:标题 / 短号随行存(seq、title 列)。
      recordRequirementEvents(db, row, JSON.stringify(actorOf(ctx)), [{ kind: "deleted", field: null, old: null, new: null }], deletedAt);
    });
    // 硬删除以前不留痕(RFC-038 §9.1):记下是谁删了哪张(标题 + 短号),卡本身已经没了。
    if (ctx.auth) logAudit(ctx.auth.userId, ctx.auth.username || null, "requirement_deleted", "requirement", row.requirement_id, JSON.stringify({ title: row.title, seq: row.seq ?? null }).slice(0, 1000), undefined, row.network_id);
    return Response.json({ ok: true, deleted: row.requirement_id });
  }
  if (req.method !== "PATCH") return jsonError("not_found", 404);
  let body: Record<string, unknown>;
  try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
  if (!PATCH_FIELDS.some(k => Object.prototype.hasOwnProperty.call(body, k))) return jsonError("empty_patch", 400);
  const row = scopedRow(ctx, id);
  if (row instanceof Response) return row;
  return patchRequirement(ctx, row, body);
}
