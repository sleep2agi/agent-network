// 需求池。长期卡片，存在 Hub 上，手机和电脑读同一份。
// 不是 tasks：tasks 是正在派给节点的活，状态由节点收尾。
import { db } from "./db.js";
import { addNetworkScope, canRestWriteNetwork, resolveRestWriteNetworkId, type RestNetworkScope } from "./network-scope.js";
import { migrateRequirementAgentOwners } from "./requirements-migrate.js";

// 启动迁移:旧库里节点当负责人的卡,节点挪到 agent_owner(列由 db.ts 的加列循环加上)。
// 放在这里而不是 db.ts:db.ts 每多一行,文档里钉着的行号就漂一次。
migrateRequirementAgentOwners(db);

type RequestAuth = { userId: string; networkId: string | null; username: string } | null;

export type RequirementsRequestContext = {
  req: Request;
  url: URL;
  auth: RequestAuth;
  isAdmin: boolean;
  isNodeToken: boolean;
  scope: RestNetworkScope;
};

const COLUMNS = new Set(["pool", "doing", "done"]);
const PRIORITIES = new Set(["high", "normal", "low"]);
const DUE = /^\d{4}-\d{2}-\d{2}$/;

type Row = {
  owner_json: string | null;
  agent_owner_json: string | null;
  description: string | null;
  checklist_json: string | null;
  participants_json: string;
  requirement_id: string;
  network_id: string;
  title: string;
  column_name: string;
  priority: string;
  due_on: string | null;
  assignee: string | null;
  issues_json: string | null;
  created_at: string;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

function dueOk(due: string): boolean {
  if (!DUE.test(due)) return false;
  const [y, m, d] = due.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
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

function toPublic(row: Row) {
  return {
    owner: row.owner_json ? JSON.parse(row.owner_json) : null,
    // 负责 Agent(执行者)。字段总在:客户端靠它判断这个 Hub 分不分「负责人 / 负责 Agent」。
    agent_owner: row.agent_owner_json ? JSON.parse(row.agent_owner_json) : null,
    // 描述(markdown)与子任务。字段总在:客户端靠它判断这个 Hub 支不支持。
    description: row.description || "",
    checklist: storedChecklist(row.checklist_json),
    participants: JSON.parse(row.participants_json || '[]'),
    id: row.requirement_id,
    name: row.title,
    priority: row.priority,
    assignee: row.assignee || "",
    due: row.due_on || "",
    column: row.column_name,
    createdAt: row.created_at,
    issues: storedIssues(row.issues_json),
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
  return !ctx.isNodeToken && canRestWriteNetwork(ctx.auth, networkId, ctx.isAdmin);
}

const SELECT = "requirement_id, network_id, title, column_name, priority, due_on, assignee, issues_json, created_at, owner_json, participants_json, agent_owner_json, description, checklist_json";

type PersonRef = { kind: 'user' | 'node'; id: string };
function personRef(value: unknown, networkId: string): PersonRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_person');
  const row = value as Record<string, unknown>;
  if ((row.kind !== 'user' && row.kind !== 'node') || typeof row.id !== 'string' || !row.id.trim()) throw new Error('invalid_person');
  const exists = row.kind === 'user'
    ? db.get("SELECT 1 FROM network_members m JOIN users u ON u.user_id=m.user_id WHERE m.network_id=?1 AND m.user_id=?2", networkId, row.id)
    : db.get("SELECT 1 FROM nodes WHERE network_id=?1 AND node_id=?2", networkId, row.id);
  if (!exists) throw new Error('person_not_in_network');
  return { kind: row.kind, id: row.id };
}

// 负责人只能是人类,负责 Agent 只能是节点;参与人两种都行。库里旧的节点负责人照样读出来(启动迁移会挪走),
// 只有这次请求显式写了 owner / agent_owner 才校验种类。
function assignments(body: Record<string, unknown>, networkId: string, current?: Row) {
  let owner = current?.owner_json ? JSON.parse(current.owner_json) : null;
  if ('owner' in body) {
    owner = body.owner === null ? null : personRef(body.owner, networkId);
    if (owner && owner.kind !== 'user') throw new Error('owner_must_be_human');
  }
  let agentOwner = current?.agent_owner_json ? JSON.parse(current.agent_owner_json) : null;
  if ('agent_owner' in body) {
    agentOwner = body.agent_owner === null ? null : personRef(body.agent_owner, networkId);
    if (agentOwner && agentOwner.kind !== 'node') throw new Error('agent_owner_must_be_agent');
  }
  let participants = current ? JSON.parse(current.participants_json || '[]') : [];
  if ('participants' in body) {
    if (!Array.isArray(body.participants) || body.participants.length > 100) throw new Error('invalid_participants');
    const refs = body.participants.map(value => personRef(value, networkId));
    participants = [...new Map(refs.map(ref => [`${ref.kind}:${ref.id}`, ref])).values()];
  }
  return {
    ownerJson: owner === null ? null : JSON.stringify(owner),
    agentOwnerJson: agentOwner === null ? null : JSON.stringify(agentOwner),
    participantsJson: JSON.stringify(participants),
  };
}

/** 节点令牌可用的操作。空 = 与之前一样全部拒绝(本 PR 不放宽)。候选:'read' | 'patch' | 'checklist_item'。 */
const NODE_TOKEN_OPERATIONS: ReadonlySet<string> = new Set<string>();
function operationOf(req: Request, url: URL): string {
  if (req.method === "GET") return "read";
  if (/^\/api\/requirements\/[^/]+\/checklist\/[^/]+$/.test(url.pathname)) return "checklist_item";
  if (req.method === "PATCH") return "patch";
  return "create";
}

export async function handleRequirementsRequest(ctx: RequirementsRequestContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname !== "/api/requirements" && !url.pathname.startsWith("/api/requirements/")) return null;
  // 节点令牌(Agent)现在一律拒绝。以后要让 Agent 读写描述、勾子任务,把对应操作加进
  // NODE_TOKEN_OPERATIONS(并给 canWrite 加上节点所属网络的判断)即可 —— 路由和请求体不用改。
  if (ctx.isNodeToken && !NODE_TOKEN_OPERATIONS.has(operationOf(req, url))) return jsonError("user_token_required", 403);

  if (url.pathname === '/api/requirements/people' && req.method === 'GET') {
    const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
    if (!networkId) return jsonError('network_id_required', 400);
    const users = db.all<{ id: string; name: string }>(
      "SELECT u.user_id AS id, COALESCE(NULLIF(u.display_name,''), u.username) AS name FROM network_members m JOIN users u ON u.user_id=m.user_id WHERE m.network_id=?1 ORDER BY name, id", networkId,
    );
    const nodes = db.all<{ id: string; name: string }>(
      "SELECT node_id AS id, COALESCE(NULLIF(display_name,''), NULLIF(alias,''), node_name) AS name FROM nodes WHERE network_id=?1 ORDER BY name, id", networkId,
    );
    return Response.json({ ok: true, people: [...users.map(row => ({ ...row, kind: 'user', networkId })), ...nodes.map(row => ({ ...row, kind: 'node', networkId }))] });
  }

  if (url.pathname === "/api/requirements" && req.method === "GET") {
    const params: unknown[] = [];
    let sql = `SELECT ${SELECT} FROM requirements WHERE 1=1`;
    sql = addNetworkScope(sql, params, ctx.scope);
    sql += " ORDER BY created_at DESC LIMIT 500";
    const rows = db.all<Row>(sql, ...params).map(toPublic);
    return Response.json({ ok: true, requirements: rows });
  }

  if (url.pathname === "/api/requirements" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    const networkId = writeNetwork(body, ctx);
    if (!networkId) return jsonError("network_id_required", 400);
    if (!canWrite(ctx, networkId)) return jsonError("permission_denied", 403);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return jsonError("invalid_name", 400);
    const priority = typeof body.priority === "string" ? body.priority : "normal";
    if (!PRIORITIES.has(priority)) return jsonError("invalid_priority", 400);
    const due = typeof body.due === "string" ? body.due.trim() : "";
    if (due && !dueOk(due)) return jsonError("invalid_due", 400);
    const assignee = typeof body.assignee === "string" ? body.assignee.trim().slice(0, 80) : "";
    const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
    if (clientId && !/^[A-Za-z0-9._-]{1,80}$/.test(clientId)) return jsonError("invalid_client_id", 400);
    const column = typeof body.column === "string" && COLUMNS.has(body.column) ? body.column : "pool";
    const issues = body.issues === undefined ? [] : normalizeIssues(body.issues);
    if (issues === null) return jsonError("invalid_issues", 400);
    const description = body.description === undefined ? "" : normalizeDescription(body.description);
    if (description === null) return jsonError("invalid_description", 400);
    const checklist = body.checklist === undefined ? [] : normalizeChecklist(body.checklist);
    if (checklist === null) return jsonError("invalid_checklist", 400);
    if (clientId) {
      const existing = db.get<Row>(
        `SELECT ${SELECT} FROM requirements WHERE network_id = ?1 AND client_id = ?2`,
        networkId, clientId,
      );
      if (existing) return Response.json({ ok: true, requirement: toPublic(existing) });
    }
    const id = `req_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    let people;
    try { people = assignments(body, networkId); } catch (e) { return jsonError((e as Error).message, 400); }
    try {
      db.run(
        `INSERT INTO requirements
         (requirement_id, network_id, title, column_name, priority, due_on, assignee, client_id, issues_json, created_by, created_at, updated_at, owner_json, participants_json, agent_owner_json, description, checklist_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?14, ?15, ?16)`,
        [id, networkId, name, column, priority, due || null, assignee, clientId || null, JSON.stringify(issues), ctx.auth?.userId ?? null, createdAt, people.ownerJson, people.participantsJson, people.agentOwnerJson, description || null, JSON.stringify(checklist)],
      );
    } catch {
      if (!clientId) return jsonError("insert_failed", 500);
      const existing = db.get<Row>(
        `SELECT ${SELECT} FROM requirements WHERE network_id = ?1 AND client_id = ?2`,
        networkId, clientId,
      );
      if (!existing) return jsonError("insert_failed", 500);
      return Response.json({ ok: true, requirement: toPublic(existing) });
    }
    const created = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, id)!;
    return Response.json({ ok: true, requirement: toPublic(created) }, { status: 201 });
  }

  const itemMatch = url.pathname.match(/^\/api\/requirements\/([^/]+)\/checklist\/([^/]+)$/);
  if (itemMatch) {
    if (req.method !== "PATCH") return jsonError("not_found", 404);
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    if (typeof body.done !== "boolean") return jsonError("invalid_done", 400);
    const params: unknown[] = [decodeURIComponent(itemMatch[1])];
    let sql = `SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`;
    sql = addNetworkScope(sql, params, ctx.scope);
    const row = db.get<Row>(sql, ...params);
    if (!row) return jsonError("requirement_not_found", 404);
    if (!canWrite(ctx, row.network_id)) return jsonError("permission_denied", 403);
    // 读-改-写在同一个同步段里完成(中间没有 await),同一进程里的两次勾选不会交错。
    const items = storedChecklist(row.checklist_json);
    const itemId = decodeURIComponent(itemMatch[2]);
    const item = items.find(entry => entry.id === itemId);
    if (!item) return jsonError("checklist_item_not_found", 404);
    item.done = body.done;
    db.run("UPDATE requirements SET checklist_json = ?1, updated_at = ?2 WHERE requirement_id = ?3", [JSON.stringify(items), new Date().toISOString(), row.requirement_id]);
    const updated = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, row.requirement_id)!;
    return Response.json({ ok: true, requirement: toPublic(updated) });
  }

  const match = url.pathname.match(/^\/api\/requirements\/([^/]+)$/);
  if (!match || req.method !== "PATCH") return jsonError("not_found", 404);
  const id = decodeURIComponent(match[1]);
  let body: Record<string, unknown>;
  try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
  const hasColumn = 'column' in body;
  const hasIssues = Object.prototype.hasOwnProperty.call(body, "issues");
  const hasName = 'name' in body;
  const hasPriority = 'priority' in body;
  const hasDue = 'due' in body;
  const hasAssignee = 'assignee' in body;
  const hasDescription = 'description' in body;
  const hasChecklist = 'checklist' in body;
  if (!hasColumn && !hasIssues && !hasName && !hasPriority && !hasDue && !hasAssignee && !('owner' in body) && !('agent_owner' in body) && !('participants' in body) && !hasDescription && !hasChecklist) return jsonError('empty_patch', 400);
  const description = hasDescription ? normalizeDescription(body.description) : null;
  if (hasDescription && description === null) return jsonError("invalid_description", 400);
  const checklist = hasChecklist ? normalizeChecklist(body.checklist) : null;
  if (hasChecklist && checklist === null) return jsonError("invalid_checklist", 400);
  if (hasColumn && !COLUMNS.has(String(body.column))) return jsonError("invalid_column", 400);
  const issues = hasIssues ? normalizeIssues(body.issues) : null;
  if (hasIssues && issues === null) return jsonError("invalid_issues", 400);
  const params: unknown[] = [id];
  let sql = `SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`;
  sql = addNetworkScope(sql, params, ctx.scope);
  const row = db.get<Row>(sql, ...params);
  if (!row) return jsonError("requirement_not_found", 404);
  if (!canWrite(ctx, row.network_id)) return jsonError("permission_denied", 403);
  let name = row.title;
  if (hasName) {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return jsonError("invalid_name", 400);
  }
  let priority = row.priority;
  if (hasPriority) {
    if (typeof body.priority !== "string" || !PRIORITIES.has(body.priority)) return jsonError("invalid_priority", 400);
    priority = body.priority;
  }
  let due = row.due_on || "";
  if (hasDue) {
    if (typeof body.due !== "string") return jsonError("invalid_due", 400);
    due = body.due.trim();
    if (due && !dueOk(due)) return jsonError("invalid_due", 400);
  }
  let assignee = row.assignee || "";
  if (hasAssignee) {
    if (typeof body.assignee !== "string") return jsonError("invalid_assignee", 400);
    assignee = body.assignee.trim().slice(0, 80);
  }
  let people;
  try { people = assignments(body, row.network_id, row); } catch (e) { return jsonError((e as Error).message, 400); }
  const updatedAt = new Date().toISOString();
  db.run(
    "UPDATE requirements SET column_name = ?1, updated_at = ?2, title = ?7, priority = ?8, due_on = ?9, assignee = ?10, owner_json = ?4, participants_json = ?5, issues_json = ?6, agent_owner_json = ?11, description = ?12, checklist_json = ?13 WHERE requirement_id = ?3",
    [hasColumn ? body.column : row.column_name, updatedAt, row.requirement_id, people.ownerJson, people.participantsJson, hasIssues ? JSON.stringify(issues) : row.issues_json, name, priority, due || null, assignee, people.agentOwnerJson,
      hasDescription ? (description || null) : row.description, hasChecklist ? JSON.stringify(checklist) : row.checklist_json],
  );
  const updated = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, row.requirement_id)!;
  return Response.json({ ok: true, requirement: toPublic(updated) });
}
