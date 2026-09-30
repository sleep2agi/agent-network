// 需求池。长期卡片，存在 Hub 上，手机和电脑读同一份。
// 不是 tasks：tasks 是正在派给节点的活，状态由节点收尾。
import { createHash } from "node:crypto";
import { encodeCursor, matchesTerms, parseListQuery, type ListQuery, type NameMaps } from "./requirements-search.js";
import { db } from "./db.js";
import { normalizeTags, storedTags } from "./requirement-tags.js";
import { addHumanNetworkScope, canRestWriteNetwork, canRestWriteNetworkAsHuman, resolveRestWriteNetworkId, type RestNetworkScope } from "./network-scope.js";
import { isAgentRestricted, visibleAgents } from "./agent-access.js";
import { ensureRequirementIndexes, ensureRequirementProjects, ensureRequirementSeq, migrateRequirementAgentOwners, migrateRequirementPriorityCheck, nextRequirementSeq } from "./requirements-migrate.js";

// 启动迁移:旧库里节点当负责人的卡,节点挪到 agent_owner(列由 db.ts 的加列循环加上)。
// 放在这里而不是 db.ts:db.ts 每多一行,文档里钉着的行号就漂一次。
migrateRequirementPriorityCheck(db);
migrateRequirementAgentOwners(db);
ensureRequirementProjects(db);
ensureRequirementIndexes(db);
ensureRequirementSeq(db);

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
    const rows = db.all<ProjectRow>(`SELECT ${PROJECT_SELECT} FROM requirement_projects WHERE network_id = ?1 ORDER BY sort, created_at`, networkId);
    return Response.json({ ok: true, projects: rows.map(projectPublic) });
  }
  if (!canWrite(ctx, networkId)) return jsonError("permission_denied", 403);
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
    db.run("UPDATE requirements SET project_id = NULL WHERE project_id = ?1", [current.project_id]);
    db.run("DELETE FROM requirement_projects WHERE project_id = ?1", [current.project_id]);
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
function toPublicFor(ctx: RequirementsRequestContext, row: Row) {
  const pub = toPublic(row);
  const hidden = hiddenNodeFilter(ctx, row.network_id);
  if (!hidden) return pub;
  return {
    ...pub,
    owner: isHiddenRef(pub.owner, hidden) ? null : pub.owner,
    agent_owner: isHiddenRef(pub.agent_owner, hidden) ? null : pub.agent_owner,
    participants: Array.isArray(pub.participants) ? pub.participants.filter((ref: unknown) => !isHiddenRef(ref, hidden)) : pub.participants,
    created_by: isHiddenRef(pub.created_by, hidden) ? null : pub.created_by,
    updated_by: isHiddenRef(pub.updated_by, hidden) ? null : pub.updated_by,
  };
}

const SELECT = "requirement_id, network_id, title, column_name, priority, due_on, assignee, issues_json, tags_json, created_at, owner_json, participants_json, agent_owner_json, description, checklist_json, project_id, external_ref, external_url, archived, created_by, created_by_json, updated_by_json, updated_at, parent_id, start_on, seq, " +
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
  const etag = `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  // private:按用户可见范围生成,不能被共享缓存复用;no-cache:每次都要回来验证,不会拿旧表当新的。
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, "Content-Type": "application/json;charset=utf-8" } });
}

function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some(tag => tag.trim() === "*" || bare(tag) === bare(etag));
}

// search:GET 认 q=(服务端搜索,语义同 App 的任务搜索);paging:认 limit / cursor,响应带 has_more / next_cursor。
export const REQUIREMENT_CAPABILITIES = ["agent_owner", "description", "checklist", "projects", "due_datetime", "external_ref", "archived", "agent_api", "sub_requirements", "tags", "priority_lowest", "start_date", "requirement_seq", "search", "paging"] as const;

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
  let projectId: string | null = null;
  if (body.project_id !== undefined) {
    try { projectId = projectRef(body.project_id, networkId); } catch (e) { return jsonError((e as Error).message, 400); }
  }
  const ref = body.external_ref === undefined ? null : externalRef(body.external_ref);
  if (ref === undefined) return jsonError("invalid_external_ref", 400);
  const extUrl = body.external_url === undefined ? null : externalUrl(body.external_url);
  if (extUrl === undefined) return jsonError("invalid_external_url", 400);
  const parentId = body.parent_id === undefined ? null : parentIdOf(body.parent_id);
  if (parentId === undefined) return jsonError("invalid_parent_id", 400);
  if (parentId) {
    const err = parentError(networkId, parentId, null);
    if (err) return jsonError(err, 400);
  }
  if (ref) {
    const existing = rowByExternalRef(networkId, ref);
    // 同一个外部条目再建一次 = 冲突,回已有的 id(同步方改用 upsert,或按这个 id PATCH)。
    if (existing) return Response.json({ ok: false, error: "external_ref_exists", existing_id: existing.requirement_id }, { status: 409 });
  }
  if (clientId) {
    const existing = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE network_id = ?1 AND client_id = ?2`, networkId, clientId);
    if (existing) return Response.json({ ok: true, requirement: toPublicFor(ctx, existing) });
  }
  const id = `req_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  let people;
  try { people = assignments(body, networkId, undefined, hiddenNodeFilter(ctx, networkId)); } catch (e) { return jsonError((e as Error).message, 400); }
  const actor = JSON.stringify(actorOf(ctx));
  try {
    // 领号和插入在同一个事务里:插入被唯一索引挡下时,号一起回滚,不留空洞。
    db.transaction(() => db.run(
      `INSERT INTO requirements
       (requirement_id, network_id, title, column_name, priority, due_on, assignee, client_id, issues_json, created_by, created_at, updated_at, owner_json, participants_json, agent_owner_json, description, checklist_json, project_id, external_ref, external_url, created_by_json, updated_by_json, archived, parent_id, tags_json, start_on, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, 0, ?21, ?22, ?23, ?24)`,
      [id, networkId, name, column, priority, due || null, assignee, clientId || null, JSON.stringify(issues), ctx.auth?.userId ?? null, createdAt, people.ownerJson, people.participantsJson, people.agentOwnerJson, description || null, JSON.stringify(checklist), projectId, ref, extUrl, actor, parentId, JSON.stringify(tags), start || null, nextRequirementSeq(db, networkId)],
    ));
  } catch {
    // 并发的同一个 external_ref / client_id:唯一索引挡住了第二个,回已有的那条。
    if (ref) {
      const existing = rowByExternalRef(networkId, ref);
      if (existing) return Response.json({ ok: false, error: "external_ref_exists", existing_id: existing.requirement_id }, { status: 409 });
    }
    if (!clientId) return jsonError("insert_failed", 500);
    const existing = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE network_id = ?1 AND client_id = ?2`, networkId, clientId);
    if (!existing) return jsonError("insert_failed", 500);
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
      const err = parentError(row.network_id, next, row.requirement_id);
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
  db.run(
    `UPDATE requirements SET column_name = ?1, updated_at = ?2, title = ?7, priority = ?8, due_on = ?9, assignee = ?10, owner_json = ?4, participants_json = ?5, issues_json = ?6,
       agent_owner_json = ?11, description = ?12, checklist_json = ?13, project_id = ?14, external_ref = ?15, external_url = ?16, archived = ?17, updated_by_json = ?18, parent_id = ?19, tags_json = ?20, start_on = ?21
     WHERE requirement_id = ?3`,
    [has("column") ? body.column : row.column_name, updatedAt, row.requirement_id, people.ownerJson, people.participantsJson, has("issues") ? JSON.stringify(issues) : row.issues_json, name, priority, due || null, assignee, people.agentOwnerJson,
      has("description") ? (description || null) : row.description, has("checklist") ? JSON.stringify(checklist) : row.checklist_json, projectId, ref, extUrl, archived, JSON.stringify(actorOf(ctx)), parentId, has("tags") ? JSON.stringify(tags) : row.tags_json, start || null],
  );
  const updated = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, row.requirement_id)!;
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
  if (q.get("archived") === "true") sql += " AND COALESCE(archived, 0) = 1";
  else if (q.get("include_archived") !== "1") sql += " AND COALESCE(archived, 0) = 0";
  return sql;
}

const LIST_ORDER = " ORDER BY created_at DESC, requirement_id DESC";
type LightRow = { requirement_id: string; network_id: string; created_at: string; title: string; description: string | null; assignee: string | null; tags_json: string | null; project_id: string | null; owner_json: string | null; agent_owner_json: string | null; participants_json: string | null };
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
    const light = db.all<LightRow>(`SELECT requirement_id, network_id, created_at, title, description, assignee, tags_json, project_id, owner_json, agent_owner_json, participants_json ${where}${LIST_ORDER}`, ...params);
    const maps = new Map<string, NameMaps>();
    const hits: string[] = [];
    for (const r of light) {
      let m = maps.get(r.network_id);
      if (!m) maps.set(r.network_id, m = searchNameMaps(ctx, r.network_id));
      const row = { name: r.title, description: r.description || "", assignee: r.assignee || "", tags: storedTags(r.tags_json), project_id: r.project_id, owner: parseRef(r.owner_json), agent_owner: parseRef(r.agent_owner_json), participants: parseRef(r.participants_json) ?? [] };
      if (matchesTerms(row, lq.terms, m)) hits.push(r.requirement_id);
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

export async function handleRequirementsRequest(ctx: RequirementsRequestContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname !== "/api/requirements" && !url.pathname.startsWith("/api/requirements/")) return null;
  // 节点令牌只能做 NODE_TOKEN_OPERATIONS 里的事(读 / 建 / 改 / 勾子任务 / upsert / 读项目),
  // 而且只在它绑定的网络里 —— 范围由 scope 强制,写入再由 canWrite 核一次。
  if (ctx.isNodeToken && !NODE_TOKEN_OPERATIONS.has(operationOf(req, url))) return jsonError("user_token_required", 403);

  if (url.pathname === "/api/requirements/projects" || url.pathname.startsWith("/api/requirements/projects/")) return handleProjects(ctx);

  if (url.pathname === "/api/requirements/tags" && req.method === "GET") {
    const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
    if (!networkId) return jsonError("network_id_required", 400);
    const rows = db.all<{ tags_json: string | null }>("SELECT tags_json FROM requirements WHERE network_id=?1", networkId);
    const tags = [...new Set(rows.flatMap(row => storedTags(row.tags_json)))].sort();
    return Response.json({ ok: true, networkId, tags });
  }

  if (url.pathname === '/api/requirements/people' && req.method === 'GET') {
    const networkId = resolveRestWriteNetworkId(ctx.scope, ctx.auth, ctx.isAdmin);
    if (!networkId) return jsonError('network_id_required', 400);
    const users = db.all<{ id: string; name: string }>(
      "SELECT u.user_id AS id, COALESCE(NULLIF(u.display_name,''), u.username) AS name FROM network_members m JOIN users u ON u.user_id=m.user_id WHERE m.network_id=?1 ORDER BY name, id", networkId,
    );
    const hidden = hiddenNodeFilter(ctx, networkId);
    const nodes = db.all<{ id: string; name: string }>(
      "SELECT node_id AS id, COALESCE(NULLIF(display_name,''), NULLIF(alias,''), node_name) AS name FROM nodes WHERE network_id=?1 ORDER BY name, id", networkId,
    ).filter(row => !hidden?.(row.id));
    return Response.json({ ok: true, people: [...users.map(row => ({ ...row, kind: 'user', networkId })), ...nodes.map(row => ({ ...row, kind: 'node', networkId }))] });
  }

  if (url.pathname === "/api/requirements" && req.method === "GET") {
    const params: unknown[] = [];
    // 只拼 FROM … WHERE:同一组条件既用来读整行,也用来(搜索时)先读轻量列。
    let sql = "FROM requirements WHERE 1=1";
    sql = addHumanNetworkScope(sql, params, ctx.scope);
    const filtered = listFilters(url, sql, params, ctx);
    if (typeof filtered !== "string") return filtered;
    // q= / limit / cursor(requirements-search.ts)。都不带 = 旧行为:最新 500 张、同样的顺序。
    const lq = parseListQuery(url.searchParams);
    if ("error" in lq) return jsonError(lq.error, 400);
    const page = listPage(ctx, filtered, params, lq);
    // capabilities:客户端按这个决定显示哪些功能(预计完成能不能带时刻、有没有项目…),不用靠猜字段。
    // has_more / next_cursor:后面还有没有(带 cursor=next_cursor 再读一页)。旧客户端不认识,忽略即可。
    return conditionalJson(ctx.req, { ok: true, requirements: page.rows.map(row => toPublicFor(ctx, row)), capabilities: REQUIREMENT_CAPABILITIES, has_more: page.hasMore, next_cursor: page.nextCursor });
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
    // 读-改-写在同一个同步段里完成(中间没有 await),同一进程里的两次勾选不会交错。
    const items = storedChecklist(row.checklist_json);
    const itemId = decodeURIComponent(itemMatch[2]);
    const item = items.find(entry => entry.id === itemId);
    if (!item) return jsonError("checklist_item_not_found", 404);
    item.done = body.done;
    db.run("UPDATE requirements SET checklist_json = ?1, updated_at = ?2, updated_by_json = ?3 WHERE requirement_id = ?4", [JSON.stringify(items), new Date().toISOString(), JSON.stringify(actorOf(ctx)), row.requirement_id]);
    const updated = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, row.requirement_id)!;
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
    // 子需求不跟着删:先解挂(变成顶层),再删父卡。
    db.run("UPDATE requirements SET parent_id = NULL WHERE parent_id = ?1", [row.requirement_id]);
    db.run("DELETE FROM requirements WHERE requirement_id = ?1", [row.requirement_id]);
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
