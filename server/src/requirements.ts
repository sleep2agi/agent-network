// 需求池。长期卡片，存在 Hub 上，手机和电脑读同一份。
// 不是 tasks：tasks 是正在派给节点的活，状态由节点收尾。
import { db } from "./db.js";
import { addNetworkScope, canRestWriteNetwork, resolveRestWriteNetworkId, type RestNetworkScope } from "./network-scope.js";

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

function toPublic(row: Row) {
  return {
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

const SELECT = "requirement_id, network_id, title, column_name, priority, due_on, assignee, issues_json, created_at";

export async function handleRequirementsRequest(ctx: RequirementsRequestContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname !== "/api/requirements" && !url.pathname.startsWith("/api/requirements/")) return null;
  if (ctx.isNodeToken) return jsonError("user_token_required", 403);

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
    if (clientId) {
      const existing = db.get<Row>(
        `SELECT ${SELECT} FROM requirements WHERE network_id = ?1 AND client_id = ?2`,
        networkId, clientId,
      );
      if (existing) return Response.json({ ok: true, requirement: toPublic(existing) });
    }
    const id = `req_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    try {
      db.run(
        `INSERT INTO requirements
         (requirement_id, network_id, title, column_name, priority, due_on, assignee, client_id, issues_json, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
        [id, networkId, name, column, priority, due || null, assignee, clientId || null, JSON.stringify(issues), ctx.auth?.userId ?? null, createdAt],
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

  const match = url.pathname.match(/^\/api\/requirements\/([^/]+)$/);
  if (!match || req.method !== "PATCH") return jsonError("not_found", 404);
  const id = decodeURIComponent(match[1]);
  let body: Record<string, unknown>;
  try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
  const hasColumn = typeof body.column === "string";
  const hasIssues = Object.prototype.hasOwnProperty.call(body, "issues");
  if (!hasColumn && !hasIssues) return jsonError("invalid_column", 400);
  if (hasColumn && !COLUMNS.has(String(body.column))) return jsonError("invalid_column", 400);
  const issues = hasIssues ? normalizeIssues(body.issues) : null;
  if (hasIssues && issues === null) return jsonError("invalid_issues", 400);
  const params: unknown[] = [id];
  let sql = `SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`;
  sql = addNetworkScope(sql, params, ctx.scope);
  const row = db.get<Row>(sql, ...params);
  if (!row) return jsonError("requirement_not_found", 404);
  if (!canWrite(ctx, row.network_id)) return jsonError("permission_denied", 403);
  const updatedAt = new Date().toISOString();
  if (hasColumn && hasIssues) {
    db.run(
      "UPDATE requirements SET column_name = ?1, issues_json = ?2, updated_at = ?3 WHERE requirement_id = ?4",
      [body.column, JSON.stringify(issues), updatedAt, row.requirement_id],
    );
  } else if (hasColumn) {
    db.run(
      "UPDATE requirements SET column_name = ?1, updated_at = ?2 WHERE requirement_id = ?3",
      [body.column, updatedAt, row.requirement_id],
    );
  } else {
    db.run(
      "UPDATE requirements SET issues_json = ?1, updated_at = ?2 WHERE requirement_id = ?3",
      [JSON.stringify(issues), updatedAt, row.requirement_id],
    );
  }
  const updated = db.get<Row>(`SELECT ${SELECT} FROM requirements WHERE requirement_id = ?1`, row.requirement_id)!;
  return Response.json({ ok: true, requirement: toPublic(updated) });
}
