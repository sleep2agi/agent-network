import { db } from "./db.js";
import { getUserNetworkRole } from "./auth.js";
import { pushEvent } from "./push.js";
import { parseExternalSchedulePatch, type ExternalSchedulePatch } from "./shared/external-schedule-contract.js";

type Auth = {
  userId: string;
  networkId: string | null;
  username: string;
  tokenId: string | null;
} | null;

export type ExternalScheduleEditContext = {
  req: Request;
  url: URL;
  auth: Auth;
  isUserToken: boolean;
  isNodeToken: boolean;
};

type NodeRow = {
  node_id: string;
  alias: string | null;
  network_id: string | null;
  owner_user_id: string | null;
};

type EditRow = {
  intent_id: string;
  network_id: string;
  node_id: string;
  schedule_id: string;
  base_revision: number;
  patch_json: string;
  status: string;
  expires_at: number;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
  created_by_user: string;
  created_by_token: string;
  consumed_by_token: string | null;
  result_revision: number | null;
  error_code: string | null;
};

const INTENT_TTL_MS = 5 * 60_000;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SCHEDULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function error(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, ...extra }, { status });
}

async function bodyObject(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
  return value as Record<string, unknown>;
}

function exactKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(obj).every((key) => set.has(key));
}

function nodeRow(nodeId: string): NodeRow | null {
  return db.get<NodeRow>(
    "SELECT node_id, alias, network_id, owner_user_id FROM nodes WHERE node_id = ?1",
    nodeId,
  ) ?? null;
}

function requireOwner(ctx: ExternalScheduleEditContext, node: NodeRow, networkId: unknown): Response | null {
  if (!ctx.isUserToken || !ctx.auth?.tokenId) return error("user_token_required", 403);
  if (!node.owner_user_id) return error("node_owner_unclaimed", 409);
  if (ctx.auth.userId !== node.owner_user_id) return error("node_owner_required", 403);
  if (typeof networkId !== "string" || networkId !== node.network_id) return error("cross_network_node", 403);
  if (!getUserNetworkRole(ctx.auth.userId, networkId)) return error("network_membership_required", 403);
  return null;
}

function requireBoundNode(ctx: ExternalScheduleEditContext, node: NodeRow): Response | null {
  if (!ctx.isNodeToken || !ctx.auth?.tokenId) return error("network_token_required", 403);
  const token = db.get<{ token_id: string; user_id: string; network_id: string | null; name: string; bound_node_id: string | null }>(
    "SELECT token_id, user_id, network_id, name, bound_node_id FROM api_tokens WHERE token_id = ?1",
    ctx.auth.tokenId,
  );
  if (!token || token.bound_node_id !== node.node_id || token.network_id !== node.network_id || token.user_id !== node.owner_user_id) {
    return error("node_token_binding_required", 403);
  }
  return null;
}

function reportedSchedule(node: NodeRow, scheduleId: string): Record<string, unknown> | null {
  const row = db.get<{ external_schedules: string }>(
    `SELECT external_schedules FROM sessions
     WHERE node_id = ?1 AND network_id = ?2 AND external_schedules IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    node.node_id,
    node.network_id,
  );
  if (!row) return null;
  try {
    const snapshot = JSON.parse(row.external_schedules) as any;
    if (!Array.isArray(snapshot?.schedules)) return null;
    return snapshot.schedules.find((entry: any) => entry?.id === scheduleId) ?? null;
  } catch {
    return null;
  }
}

function publicEdit(row: EditRow): Record<string, unknown> {
  let patch: ExternalSchedulePatch = {};
  try { patch = JSON.parse(row.patch_json); } catch {}
  return {
    intent_id: row.intent_id,
    node_id: row.node_id,
    schedule_id: row.schedule_id,
    base_revision: row.base_revision,
    patch,
    status: row.status,
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    delivered_at: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    acked_at: row.acked_at ? new Date(row.acked_at).toISOString() : null,
    result_revision: row.result_revision,
    error_code: row.error_code,
  };
}

function audit(
  userId: string | null,
  username: string | null,
  action: string,
  intentId: string,
  networkId: string,
  detail: Record<string, unknown>,
): void {
  db.run(
    `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
     VALUES (?1, ?2, ?3, 'external_schedule_edit', ?4, ?5, ?6)`,
    [userId, username, action, intentId, JSON.stringify(detail), networkId],
  );
}

function expireOpenIntents(node: NodeRow, now: number): void {
  const expired = db.all<EditRow>(
    "SELECT * FROM external_schedule_edits WHERE node_id = ?1 AND network_id = ?2 AND status IN ('pending', 'delivered') AND expires_at <= ?3",
    node.node_id,
    node.network_id,
    now,
  );
  for (const row of expired) {
    const changed = db.run(
      "UPDATE external_schedule_edits SET status = 'expired', acked_at = ?1, error_code = 'intent_expired' WHERE intent_id = ?2 AND status IN ('pending', 'delivered') AND expires_at <= ?1",
      [now, row.intent_id],
    );
    if (changed.changes === 1) {
      audit(row.created_by_user, null, "external_schedule.edit_expired", row.intent_id, row.network_id, {
        node_id: row.node_id, schedule_id: row.schedule_id, base_revision: row.base_revision, error_code: "intent_expired",
      });
    }
  }
}

export async function handleExternalScheduleEditRequest(ctx: ExternalScheduleEditContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/nodes\/([^/]+)\/external-schedule-edits(?:\/(pending|[^/]+)(?:\/(ack))?)?$/);
  if (!match) return null;
  const nodeId = decodeURIComponent(match[1]);
  if (!NODE_ID_RE.test(nodeId)) return error("invalid_node_id", 400);
  const tail = match[2] || null;
  const ack = match[3] === "ack";
  const node = nodeRow(nodeId);
  if (!node) return error("node_not_found", 404);

  if (tail === "pending" && ctx.req.method === "GET") {
    const denied = requireBoundNode(ctx, node);
    if (denied) return denied;
    const now = Date.now();
    const intent = db.transaction(() => {
      expireOpenIntents(node, now);
      const already = db.get<EditRow>(
        `SELECT * FROM external_schedule_edits
         WHERE node_id = ?1 AND network_id = ?2 AND status = 'delivered' AND consumed_by_token = ?3
         ORDER BY delivered_at ASC LIMIT 1`,
        node.node_id, node.network_id, ctx.auth!.tokenId,
      );
      if (already) return already;
      const pending = db.get<EditRow>(
        `SELECT * FROM external_schedule_edits
         WHERE node_id = ?1 AND network_id = ?2 AND status = 'pending' AND expires_at > ?3
         ORDER BY created_at ASC LIMIT 1`,
        node.node_id, node.network_id, now,
      );
      if (!pending) return null;
      const claimed = db.run(
        `UPDATE external_schedule_edits SET status = 'delivered', delivered_at = ?1, consumed_by_token = ?2
         WHERE intent_id = ?3 AND status = 'pending' AND expires_at > ?1`,
        [now, ctx.auth!.tokenId, pending.intent_id],
      );
      if (claimed.changes !== 1) return null;
      audit(pending.created_by_user, null, "external_schedule.edit_delivered", pending.intent_id, pending.network_id, {
        node_id: pending.node_id, schedule_id: pending.schedule_id, base_revision: pending.base_revision,
      });
      return { ...pending, status: "delivered", delivered_at: now, consumed_by_token: ctx.auth!.tokenId };
    });
    return Response.json({ ok: true, intent: intent ? publicEdit(intent) : null });
  }

  if (tail && tail !== "pending" && ack && ctx.req.method === "POST") {
    const denied = requireBoundNode(ctx, node);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await bodyObject(ctx.req); } catch { return error("invalid_json", 400); }
    if (!exactKeys(body, ["status", "result_revision", "error_code"])) return error("invalid_ack", 400);
    if (body.status !== "applied" && body.status !== "rejected") return error("invalid_ack", 400);
    if (body.status === "applied" && !Number.isSafeInteger(body.result_revision)) return error("invalid_result_revision", 400);
    if (body.status === "rejected" && body.result_revision !== undefined) return error("invalid_ack", 400);
    if (body.error_code !== undefined && (typeof body.error_code !== "string" || !/^[a-z0-9_]{1,64}$/.test(body.error_code))) return error("invalid_error_code", 400);
    const now = Date.now();
    const result = db.transaction(() => {
      const row = db.get<EditRow>("SELECT * FROM external_schedule_edits WHERE intent_id = ?1", tail);
      if (!row || row.node_id !== node.node_id || row.network_id !== node.network_id || row.consumed_by_token !== ctx.auth!.tokenId) {
        return { error: "intent_not_found", status: 404 } as const;
      }
      if (row.status === "applied" || row.status === "rejected") {
        const requestedRevision = body.status === "applied" ? Number(body.result_revision) : null;
        const requestedError = body.error_code ?? null;
        if (row.status === body.status && row.result_revision === requestedRevision && row.error_code === requestedError) {
          return { row, idempotent: true } as const;
        }
        return { error: "intent_already_terminal", status: 409 } as const;
      }
      if (row.status !== "delivered") return { error: "intent_not_delivered", status: 409 } as const;
      if (body.status === "applied" && Number(body.result_revision) !== row.base_revision + 1) {
        return { error: "invalid_result_revision", status: 409 } as const;
      }
      const changed = db.run(
        `UPDATE external_schedule_edits SET status = ?1, acked_at = ?2, result_revision = ?3, error_code = ?4
         WHERE intent_id = ?5 AND status = 'delivered' AND consumed_by_token = ?6`,
        [body.status, now, body.status === "applied" ? Number(body.result_revision) : null, body.error_code ?? null, row.intent_id, ctx.auth!.tokenId],
      );
      if (changed.changes !== 1) return { error: "intent_state_conflict", status: 409 } as const;
      audit(row.created_by_user, null, `external_schedule.edit_${body.status}`, row.intent_id, row.network_id, {
        node_id: row.node_id, schedule_id: row.schedule_id, base_revision: row.base_revision,
        result_revision: body.status === "applied" ? Number(body.result_revision) : null,
        error_code: body.error_code ?? null,
      });
      return { row: { ...row, status: String(body.status), acked_at: now, result_revision: body.status === "applied" ? Number(body.result_revision) : null, error_code: body.error_code ?? null } } as const;
    });
    if ("error" in result) return error(result.error, result.status);
    return Response.json({ ok: true, intent: publicEdit(result.row), ...(result.idempotent ? { idempotent: true } : {}) });
  }

  if (tail) return error("not_found", 404);

  if (ctx.req.method === "GET") {
    const denied = requireOwner(ctx, node, ctx.url.searchParams.get("network_id"));
    if (denied) return denied;
    const rows = db.all<EditRow>(
      "SELECT * FROM external_schedule_edits WHERE node_id = ?1 AND network_id = ?2 AND created_by_user = ?3 ORDER BY created_at DESC LIMIT 100",
      node.node_id, node.network_id, ctx.auth!.userId,
    );
    return Response.json({ ok: true, edits: rows.map(publicEdit) });
  }

  if (ctx.req.method !== "POST") return error("method_not_allowed", 405);
  let body: Record<string, unknown>;
  try { body = await bodyObject(ctx.req); } catch { return error("invalid_json", 400); }
  if (!exactKeys(body, ["network_id", "schedule_id", "base_revision", "patch"])) return error("invalid_request", 400);
  const denied = requireOwner(ctx, node, body.network_id);
  if (denied) return denied;
  if (typeof body.schedule_id !== "string" || !SCHEDULE_ID_RE.test(body.schedule_id)) return error("invalid_schedule_id", 400);
  if (!Number.isSafeInteger(body.base_revision) || Number(body.base_revision) < 0) return error("invalid_revision", 400);
  let patch: ExternalSchedulePatch;
  try { patch = parseExternalSchedulePatch(body.patch); } catch (e: any) { return error(String(e?.message || "invalid_patch"), 400); }
  const schedule = reportedSchedule(node, body.schedule_id);
  if (!schedule) return error("schedule_not_found", 404);
  if (schedule.kind !== "cron" || schedule.editable !== true || !Number.isSafeInteger(schedule.revision)) return error("schedule_read_only", 409);
  if (Number(schedule.revision) !== Number(body.base_revision)) return error("revision_conflict", 409, { current_revision: schedule.revision });

  const intentId = `sei_${crypto.randomUUID()}`;
  const now = Date.now();
  try {
    db.transaction(() => {
      // Re-read ownership + snapshot inside the write transaction so a
      // concurrent owner/snapshot change cannot slip between preflight and INSERT.
      const currentNode = nodeRow(node.node_id);
      if (!currentNode || currentNode.owner_user_id !== ctx.auth!.userId || currentNode.network_id !== node.network_id) throw new Error("node_owner_changed");
      const current = reportedSchedule(currentNode, body.schedule_id as string);
      if (!current || current.editable !== true || current.kind !== "cron") throw new Error("schedule_read_only");
      if (Number(current.revision) !== Number(body.base_revision)) throw new Error("revision_conflict");
      db.run(
        `INSERT INTO external_schedule_edits
         (intent_id, network_id, node_id, schedule_id, base_revision, patch_json, status, expires_at, created_at, created_by_user, created_by_token)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10)`,
        [intentId, node.network_id, node.node_id, body.schedule_id, body.base_revision, JSON.stringify(patch), now + INTENT_TTL_MS, now, ctx.auth!.userId, ctx.auth!.tokenId],
      );
      audit(ctx.auth!.userId, ctx.auth!.username, "external_schedule.edit_requested", intentId, node.network_id!, {
        node_id: node.node_id, schedule_id: body.schedule_id, base_revision: body.base_revision, fields: Object.keys(patch).sort(),
      });
    });
  } catch (e: any) {
    const code = String(e?.message || "edit_create_failed");
    if (/UNIQUE|duplicate key/i.test(code)) return error("edit_in_flight", 409);
    if (code === "revision_conflict") return error(code, 409);
    if (code === "schedule_read_only") return error(code, 409);
    if (code === "node_owner_changed") return error(code, 409);
    throw e;
  }
  try { pushEvent(node.alias || node.node_id, { type: "external_schedule_edit", intent_id: intentId }, node.network_id); } catch {}
  const created = db.get<EditRow>("SELECT * FROM external_schedule_edits WHERE intent_id = ?1", intentId)!;
  return Response.json({ ok: true, intent: publicEdit(created) }, { status: 202 });
}
