import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { registerTools } from "./tools.js";
import { db, logTaskEvent, logAudit } from "./db.js";
import { createSSEStream, pushEvent, pushBroadcast, getSSEStats } from "./push.js";
import { register, login, resolveToken, getUserNetworks, createNetwork, type AuthUser } from "./auth.js";

const PORT = Number(process.env.PORT) || 9200;
const AUTH_TOKEN = process.env.COMMHUB_AUTH_TOKEN;

// ── Factory: 每个请求创建新的 McpServer（stateless 模式）──
function createServer(clientIP?: string, enforceNetworkId?: string | null): McpServer {
  const server = new McpServer({
    name: "commhub",
    version: "0.5.0",
  });
  registerTools(server, clientIP, enforceNetworkId);
  return server;
}

// ── Auth helper ─────────────────────────────────────
function requireAuth(req: Request): Response | null {
  const header = req.headers.get("Authorization")?.replace("Bearer ", "");
  const url = new URL(req.url);
  const token = header || url.searchParams.get("token") || "";

  // V3: check api_tokens first
  if (token) {
    const resolved = resolveToken(token);
    if (resolved) return null; // valid user token
  }

  // Legacy: check global COMMHUB_AUTH_TOKEN
  if (!AUTH_TOKEN) return null; // no token = open mode (dev)
  if (token === AUTH_TOKEN) return null;

  return Response.json({ error: "unauthorized" }, { status: 401 });
}

// Extract user + network from request token (for authorization)
function resolveRequestAuth(req: Request): { userId: string; networkId: string | null; username: string } | null {
  const header = req.headers.get("Authorization")?.replace("Bearer ", "");
  const url = new URL(req.url);
  const token = header || url.searchParams.get("token") || "";
  if (!token) return null;
  const resolved = resolveToken(token);
  if (!resolved) return null;
  return { userId: resolved.user.user_id, networkId: resolved.networkId, username: resolved.user.username };
}

// ── REST input schema ───────────────────────────────
const TaskSchema = z.object({
  alias: z.string().min(1).max(200),
  task: z.string().min(1).max(10000),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
  from: z.string().max(200).optional(),
});

const BroadcastSchema = z.object({
  message: z.string().min(1).max(10000),
  filter_server: z.string().max(200).optional(),
  filter_status: z.string().max(50).optional(),
});

// ── HTTP Server (Bun native) ────────────────────────
const CORS_ORIGINS = process.env.COMMHUB_CORS_ORIGINS
  ? process.env.COMMHUB_CORS_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:3000", "http://localhost:3001"];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed = CORS_ORIGINS.includes(origin)
    || origin === "https://agent-network.vansin.me"
    || origin === "https://agent-network-dashboard.vercel.app"
    ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(req: Request, res: Response): Response {
  const headers = corsHeaders(req);
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}

// ── WebSocket tmux sessions ────────────────────────
const wsTmuxIntervals = new Map<object, ReturnType<typeof setInterval>>();


// ── Task expiration patrol (every 5 minutes) ──
setInterval(() => {
  try {
    const result = db.run(
      `UPDATE tasks SET status = 'expired', completed_at = datetime('now')
       WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
         AND status IN ('created', 'delivered')`
    );
    if (result.changes > 0) {
      console.log(`[patrol] expired ${result.changes} stale task(s)`);
      // Log events for expired tasks
      const expired = db.query<{ task_id: string }, []>(
        "SELECT task_id FROM tasks WHERE status = 'expired' AND completed_at >= datetime('now', '-1 minute')"
      ).all();
      for (const t of expired) logTaskEvent(t.task_id, null, "expired", "patrol");
    }
  } catch {}
}, 5 * 60 * 1000);

Bun.serve({
  port: PORT,
  idleTimeout: 255, // max value: keep SSE connections alive (seconds)

  async fetch(req, server) {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ── CORS preflight ──
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    // ── WebSocket: tmux terminal ──
    const wsMatch = url.pathname.match(/^\/ws\/tmux\/([a-zA-Z0-9_-]+)$/);
    if (wsMatch) {
      const authErr = requireAuth(req);
      if (authErr) return withCors(req, authErr);
      if (server.upgrade(req, { data: { tmuxName: wsMatch[1] } })) return;
    }

    // ── MCP Streamable HTTP endpoint ──
    if (url.pathname === "/mcp") {
      const authErr = requireAuth(req);
      if (authErr) return withCors(req, authErr);
      const fwd = req.headers.get("x-forwarded-for");
      const clientIP = fwd ? fwd.split(",")[0].trim() : (req.headers.get("x-real-ip") ?? "unknown");
      // V3: resolve token → enforce network_id in all MCP tools
      const authCtx = resolveRequestAuth(req);
      const enforceNetId = authCtx?.networkId || null;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createServer(clientIP, enforceNetId);
      await server.connect(transport);
      const response = await transport.handleRequest(req);
      // Disconnect after response to prevent McpServer leak
      setImmediate(() => server.close().catch(() => {}));
      return response;
    }

    // ── SSE push: Agent 实时接收任务推送 ──
    // GET /events/知识哥 → 保持长连接，send_task 时秒推
    const eventsMatch = url.pathname.match(/^\/events\/(.+)$/);
    if (eventsMatch && req.method === "GET") {
      const authErr = requireAuth(req);
      if (authErr) return authErr;
      const sessionName = decodeURIComponent(eventsMatch[1]);
      return createSSEStream(sessionName);
    }

    // ── V3: Auth endpoints (public) ──
    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const result = register(body.username, body.password, body.email, body.display_name);
        if (result.ok) logAudit(result.user!.user_id, body.username, "register", "user", result.user!.user_id);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const result = login(body.username, body.password);
        if (result.ok) logAudit(result.user!.user_id, body.username, "login", "user", result.user!.user_id);
        else logAudit(null, body.username, "login_failed", "user", null, "invalid credentials");
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 401 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const networks = getUserNetworks(resolved.user.user_id);
      return withCors(req, Response.json({ ok: true, user: resolved.user, networks, current_network: resolved.networkId }));
    }

    if (url.pathname === "/api/auth/me" && req.method === "PUT") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        const updates: string[] = [];
        const params: any[] = [];
        if (body.display_name) { updates.push(`display_name = ?${params.length + 1}`); params.push(body.display_name); }
        if (body.email) { updates.push(`email = ?${params.length + 1}`); params.push(body.email); }
        if (updates.length > 0) {
          updates.push(`updated_at = datetime('now')`);
          params.push(resolved.user.user_id);
          db.run(`UPDATE users SET ${updates.join(", ")} WHERE user_id = ?${params.length}`, params);
        }
        // Re-fetch
        const user = db.query<any, [string]>("SELECT user_id, username, display_name, email, role FROM users WHERE user_id = ?1").get(resolved.user.user_id);
        return withCors(req, Response.json({ ok: true, user }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3: Network management ──
    if (url.pathname === "/api/networks" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const networks = getUserNetworks(resolved.user.user_id);
      return withCors(req, Response.json({ ok: true, networks }));
    }

    if (url.pathname === "/api/networks" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        const result = createNetwork(resolved.user.user_id, body.name, body.description);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3: Admin APIs (require auth) ──
    if (url.pathname === "/api/users" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved || resolved.user.role !== "admin") {
        return withCors(req, Response.json({ ok: false, error: "admin required" }, { status: 403 }));
      }
      const users = db.query("SELECT user_id, username, display_name, email, role, created_at FROM users ORDER BY created_at").all();
      return withCors(req, Response.json({ ok: true, users }));
    }

    const netDetailMatch = url.pathname.match(/^\/api\/networks\/([^/]+)$/);
    if (netDetailMatch && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const networkId = netDetailMatch[1];
      const network = db.query<any, [string]>("SELECT * FROM networks WHERE network_id = ?1").get(networkId);
      if (!network) return withCors(req, Response.json({ ok: false, error: "network not found" }, { status: 404 }));
      // Ownership check: only owner or admin can view
      if (network.owner_id !== resolved.user.user_id && resolved.user.role !== "admin") {
        return withCors(req, Response.json({ ok: false, error: "access denied" }, { status: 403 }));
      }
      // Get network stats
      const nodeCount = db.query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM nodes WHERE network_id = ?1").get(networkId);
      const sessionCount = db.query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM sessions WHERE network_id = ?1").get(networkId);
      const taskStats = db.query<any, [string]>("SELECT status, COUNT(*) as count FROM tasks WHERE network_id = ?1 GROUP BY status").all(networkId);
      return withCors(req, Response.json({
        ok: true, network,
        stats: { nodes: nodeCount?.cnt || 0, sessions: sessionCount?.cnt || 0, tasks: taskStats },
      }));
    }

    // ── REST: health (public, no auth) ──
    if (url.pathname === "/health") {
      const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM sessions").get();
      const sse = getSSEStats();
      return withCors(req, Response.json({
        ok: true,
        version: "0.4.1",
        transport: "streamable-http",
        sessions: count?.cnt ?? 0,
        sse_connections: sse.total,
        sse_sessions: sse.sessions,
        auth: AUTH_TOKEN ? "enabled" : "disabled",
        uptime: process.uptime(),
      }));
    }

    // ── All REST /api endpoints require auth (if token configured) ──
    const authErr = requireAuth(req);
    if (authErr) return withCors(req, authErr);

    // ── REST: all sessions status ──
    if (url.pathname === "/api/status") {
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      db.run("UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'", [cutoff]);
      const netFilter = url.searchParams.get("network_id");
      const sql = netFilter
        ? "SELECT * FROM sessions WHERE network_id = ?1 ORDER BY updated_at DESC"
        : "SELECT * FROM sessions ORDER BY updated_at DESC";
      const sessions = netFilter ? db.query(sql).all(netFilter) : db.query(sql).all();
      return withCors(req, Response.json({ ok: true, sessions }));
    }

    // ── REST: send task ──
    if (url.pathname === "/api/task" && req.method === "POST") {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return withCors(req, Response.json({ error: "invalid JSON" }, { status: 400 }));
      }
      const parsed = TaskSchema.safeParse(raw);
      if (!parsed.success) {
        return withCors(req, Response.json({ error: "invalid input", details: parsed.error.format() }, { status: 400 }));
      }
      const body = parsed.data;
      const id = crypto.randomUUID();
      const fromSession = body.from || "api";
      db.run(
        `INSERT INTO inbox (id, session_name, type, priority, content, from_session)
         VALUES (?1, ?2, 'task', ?3, ?4, ?5)`,
        [id, body.alias, body.priority, body.task, fromSession]
      );
      // SSE push: 秒达
      const pending = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(body.alias);
      pushEvent(body.alias, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority: body.priority, from: fromSession });
      return withCors(req, Response.json({ ok: true, message_id: id }));
    }

    // ── REST: broadcast ──
    if (url.pathname === "/api/broadcast" && req.method === "POST") {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return withCors(req, Response.json({ error: "invalid JSON" }, { status: 400 }));
      }
      const parsed = BroadcastSchema.safeParse(raw);
      if (!parsed.success) {
        return withCors(req, Response.json({ error: "invalid input", details: parsed.error.format() }, { status: 400 }));
      }
      const body = parsed.data;
      let sql = "SELECT alias FROM sessions WHERE alias IS NOT NULL";
      const params: any[] = [];
      if (body.filter_server) { sql += " AND server = ?"; params.push(body.filter_server); }
      if (body.filter_status) { sql += " AND status = ?"; params.push(body.filter_status); }
      const targets = db.query<{ alias: string }, any[]>(sql).all(...params);
      const ids: string[] = [];
      for (const t of targets) {
        const id = crypto.randomUUID();
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session)
           VALUES (?1, ?2, 'broadcast', 'normal', ?3, 'api')`,
          [id, t.alias, body.message]
        );
        ids.push(id);
      }
      pushBroadcast(targets.map(t => t.alias), { type: "broadcast", inbox_count: 1, message: body.message.slice(0, 200) });
      return withCors(req, Response.json({ ok: true, recipients: targets.length, message_ids: ids }));
    }

    // ── REST: tmux capture-pane ──
    const tmuxCapture = url.pathname.match(/^\/api\/tmux\/([a-zA-Z0-9_-]+)$/);
    if (tmuxCapture && req.method === "GET") {
      const name = tmuxCapture[1];
      const lines = Number(url.searchParams.get("lines")) || 30;
      try {
        const proc = Bun.spawn(["tmux", "capture-pane", "-t", name, "-p"], {
          stdout: "pipe", stderr: "pipe",
        });
        const text = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) {
          return withCors(req, Response.json({ ok: false, error: err.trim() || `exit ${code}` }, { status: 400 }));
        }
        const trimmed = text.split("\n").slice(-lines).join("\n");
        return withCors(req, Response.json({ ok: true, tmux_name: name, lines: lines, output: trimmed }));
      } catch (e) {
        return withCors(req, Response.json({ ok: false, error: (e as Error).message }, { status: 500 }));
      }
    }

    // ── REST: tmux send-keys ──
    const tmuxSend = url.pathname.match(/^\/api\/tmux\/([a-zA-Z0-9_-]+)\/send$/);
    if (tmuxSend && req.method === "POST") {
      const name = tmuxSend[1];
      let body: { text?: string; enter?: boolean };
      try { body = await req.json(); } catch {
        return withCors(req, Response.json({ error: "invalid JSON" }, { status: 400 }));
      }
      if (!body.text || typeof body.text !== "string") {
        return withCors(req, Response.json({ error: "text is required" }, { status: 400 }));
      }
      const args = ["tmux", "send-keys", "-t", name, body.text];
      if (body.enter !== false) args.push("Enter");
      try {
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) {
          return withCors(req, Response.json({ ok: false, error: err.trim() || `exit ${code}` }, { status: 400 }));
        }
        return withCors(req, Response.json({ ok: true, sent: body.text }));
      } catch (e) {
        return withCors(req, Response.json({ ok: false, error: (e as Error).message }, { status: 500 }));
      }
    }

    // ── REST: recent messages (for Dashboard communication graph) ──
    if (url.pathname === "/api/messages") {
      const limit = Number(url.searchParams.get("limit")) || 100;
      const since = url.searchParams.get("since") ?? new Date(Date.now() - 3600000).toISOString().replace("T", " ").slice(0, 19);
      const rows = db.query(
        "SELECT id, session_name as to_alias, from_session as from_alias, type, priority, content, created_at FROM inbox WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT ?2"
      ).all(since, limit);
      return withCors(req, Response.json({ ok: true, messages: rows }));
    }

    // ── REST: stats summary ──
    if (url.pathname === "/api/stats") {
      const n = url.searchParams.get("network_id");
      // Parameterized queries to prevent SQL injection
      const taskStats = n
        ? db.query<any, [string]>("SELECT status, COUNT(*) as count FROM tasks WHERE network_id = ?1 GROUP BY status").all(n)
        : db.query<any, []>("SELECT status, COUNT(*) as count FROM tasks GROUP BY status").all();
      const sessionStats = n
        ? db.query<any, [string]>("SELECT status, COUNT(*) as count FROM sessions WHERE network_id = ?1 GROUP BY status").all(n)
        : db.query<any, []>("SELECT status, COUNT(*) as count FROM sessions GROUP BY status").all();
      const totalTasks = n
        ? db.query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM tasks WHERE network_id = ?1").get(n)
        : db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM tasks").get();
      const totalNodes = n
        ? db.query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM nodes WHERE network_id = ?1").get(n)
        : db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM nodes").get();
      const recentTasks = n
        ? db.query<any, [string]>("SELECT task_id, from_name, to_name, status, created_at FROM tasks WHERE network_id = ?1 ORDER BY created_at DESC LIMIT 5").all(n)
        : db.query<any, []>("SELECT task_id, from_name, to_name, status, created_at FROM tasks ORDER BY created_at DESC LIMIT 5").all();
      return withCors(req, Response.json({
        ok: true,
        network_id: n || null,
        tasks: { total: totalTasks?.cnt || 0, by_status: taskStats },
        sessions: { by_status: sessionStats },
        nodes: { total: totalNodes?.cnt || 0 },
        recent_tasks: recentTasks,
      }));
    }

    // ── REST: audit log (V3) ──
    if (url.pathname === "/api/audit-log") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const action = url.searchParams.get("action");
      const userId = url.searchParams.get("user_id");
      let sql = "SELECT * FROM audit_log WHERE 1=1";
      const params: any[] = [];
      // Non-admin can only see own logs
      if (resolved.user.role !== "admin") { sql += ` AND user_id = ?${params.length + 1}`; params.push(resolved.user.user_id); }
      if (action) { sql += ` AND action = ?${params.length + 1}`; params.push(action); }
      if (userId && resolved.user.role === "admin") { sql += ` AND user_id = ?${params.length + 1}`; params.push(userId); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const logs = db.query(sql).all(...params);
      return withCors(req, Response.json({ ok: true, logs, count: logs.length }));
    }

    // ── REST: task events (V2 Sprint 2) ──
    if (url.pathname === "/api/task_events") {
      const taskId = url.searchParams.get("task_id");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
      let sql = "SELECT * FROM task_events";
      const params: any[] = [];
      if (taskId) { sql += " WHERE task_id = ?1"; params.push(taskId); }
      sql += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);
      const rows = db.query(sql).all(...params);
      return withCors(req, Response.json({ ok: true, events: rows, count: rows.length }));
    }

    // ── REST: nodes table (V2 Sprint 2) ──
    if (url.pathname === "/api/nodes") {
      const nodeId = url.searchParams.get("node_id");
      const alias = url.searchParams.get("alias");
      const netFilter = url.searchParams.get("network_id");
      let sql = "SELECT * FROM nodes WHERE 1=1";
      const params: any[] = [];
      if (netFilter) { sql += ` AND network_id = ?${params.length + 1}`; params.push(netFilter); }
      if (nodeId) { sql += ` AND node_id = ?${params.length + 1}`; params.push(nodeId); }
      if (alias) { sql += ` AND alias = ?${params.length + 1}`; params.push(alias); }
      sql += " ORDER BY updated_at DESC";
      const rows = db.query(sql).all(...params);
      return withCors(req, Response.json({ ok: true, nodes: rows, count: rows.length }));
    }

    // ── REST: tasks table (V2) ──
    if (url.pathname === "/api/tasks") {
      const taskId = url.searchParams.get("task_id");
      const status = url.searchParams.get("status");
      const toName = url.searchParams.get("to_name");
      const fromName = url.searchParams.get("from_name");
      const netFilter = url.searchParams.get("network_id");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

      let sql = "SELECT * FROM tasks WHERE 1=1";
      const params: any[] = [];
      if (netFilter) { sql += ` AND network_id = ?${params.length + 1}`; params.push(netFilter); }
      if (taskId) { sql += ` AND task_id = ?${params.length + 1}`; params.push(taskId); }
      if (status) { sql += ` AND status = ?${params.length + 1}`; params.push(status); }
      if (toName) { sql += ` AND to_name = ?${params.length + 1}`; params.push(toName); }
      if (fromName) { sql += ` AND from_name = ?${params.length + 1}`; params.push(fromName); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);

      const rows = db.query(sql).all(...params);
      const stats = netFilter
        ? db.query<any, [string]>("SELECT status, COUNT(*) as count FROM tasks WHERE network_id = ?1 GROUP BY status").all(netFilter)
        : db.query<any, []>("SELECT status, COUNT(*) as count FROM tasks GROUP BY status").all();
      return withCors(req, Response.json({ ok: true, tasks: rows, count: rows.length, stats }));
    }

    // ── REST: recent completions ──
    if (url.pathname === "/api/completions") {
      const since = url.searchParams.get("since") ?? new Date(Date.now() - 86400000).toISOString();
      const rows = db.query("SELECT * FROM completions WHERE completed_at >= ?1 ORDER BY completed_at DESC LIMIT 100").all(since);
      return withCors(req, Response.json({ ok: true, completions: rows }));
    }

    return withCors(req, new Response(
      `CommHub MCP Server v0.4.1 (Streamable HTTP + SSE Push)

Endpoints:
  POST /mcp               - MCP Streamable HTTP (for Claude Code / Codex)
  GET  /events/:session   - SSE realtime push (Agent subscribes here)
  GET  /health            - Health check
  GET  /api/status        - All sessions ${AUTH_TOKEN ? "(auth required)" : ""}
  POST /api/task          - Send task via REST ${AUTH_TOKEN ? "(auth required)" : ""}
  GET  /api/tasks         - Tasks table (V2) ${AUTH_TOKEN ? "(auth required)" : ""}
  GET  /api/completions   - Recent completions ${AUTH_TOKEN ? "(auth required)" : ""}
  GET  /api/tmux/:name    - Capture tmux pane output ${AUTH_TOKEN ? "(auth required)" : ""}
  POST /api/tmux/:name/send - Send keys to tmux ${AUTH_TOKEN ? "(auth required)" : ""}

Auth: ${AUTH_TOKEN ? "Bearer token enabled (set COMMHUB_AUTH_TOKEN)" : "disabled (set COMMHUB_AUTH_TOKEN to enable)"}
`,
      { status: 200, headers: { "Content-Type": "text/plain" } }
    ));
  },

  // ── WebSocket handler for tmux terminal streaming ──
  websocket: {
    open(ws) {
      const { tmuxName } = ws.data as { tmuxName: string };
      console.log(`[ws] tmux terminal opened: ${tmuxName}`);
      let lastOutput = "";

      // Poll capture-pane every 200ms and send diffs
      const interval = setInterval(async () => {
        try {
          const proc = Bun.spawn(["tmux", "capture-pane", "-t", tmuxName, "-p", "-e"], {
            stdout: "pipe", stderr: "pipe",
          });
          const output = await new Response(proc.stdout).text();
          const code = await proc.exited;
          if (code !== 0) return;

          if (output !== lastOutput) {
            lastOutput = output;
            ws.send(JSON.stringify({ type: "output", data: output }));
          }
        } catch { /* session gone */ }
      }, 200);

      wsTmuxIntervals.set(ws, interval);

      // Send initial capture immediately
      (async () => {
        try {
          const proc = Bun.spawn(["tmux", "capture-pane", "-t", tmuxName, "-p", "-e"], {
            stdout: "pipe", stderr: "pipe",
          });
          const output = await new Response(proc.stdout).text();
          const code = await proc.exited;
          if (code === 0) {
            lastOutput = output;
            ws.send(JSON.stringify({ type: "output", data: output }));
          } else {
            const err = await new Response(proc.stderr).text();
            ws.send(JSON.stringify({ type: "error", data: err.trim() || "tmux session not found" }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", data: (e as Error).message }));
        }
      })();
    },

    async message(ws, message) {
      const { tmuxName } = ws.data as { tmuxName: string };
      try {
        const msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

        if (msg.type === "input" && typeof msg.data === "string") {
          // Send individual characters/sequences via send-keys
          const proc = Bun.spawn(["tmux", "send-keys", "-t", tmuxName, "-l", msg.data], {
            stdout: "pipe", stderr: "pipe",
          });
          await proc.exited;
        } else if (msg.type === "key" && typeof msg.data === "string") {
          // Send special key names (Enter, C-c, etc.)
          const proc = Bun.spawn(["tmux", "send-keys", "-t", tmuxName, msg.data], {
            stdout: "pipe", stderr: "pipe",
          });
          await proc.exited;
        } else if (msg.type === "resize" && msg.cols && msg.rows) {
          // Resize tmux pane
          Bun.spawn(["tmux", "resize-window", "-t", tmuxName, "-x", String(msg.cols), "-y", String(msg.rows)], {
            stdout: "pipe", stderr: "pipe",
          });
        }
      } catch { /* ignore malformed messages */ }
    },

    close(ws) {
      const { tmuxName } = ws.data as { tmuxName: string };
      console.log(`[ws] tmux terminal closed: ${tmuxName}`);
      const interval = wsTmuxIntervals.get(ws);
      if (interval) { clearInterval(interval); wsTmuxIntervals.delete(ws); }
    },
  },
});

// ── Graceful shutdown ───────────────────────────────
function shutdown() {
  console.log("[commhub] shutting down...");
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`
╔══════════════════════════════════════════════════╗
║   CommHub MCP Server v0.4.1                     ║
║   Transport: Streamable HTTP (Bun native)         ║
║   Auth: ${AUTH_TOKEN ? "ENABLED (Bearer token)" : "DISABLED (set COMMHUB_AUTH_TOKEN)"}${"".padEnd(AUTH_TOKEN ? 5 : 0)}║
║                                                   ║
║   MCP:    http://0.0.0.0:${PORT}/mcp                 ║
║   REST:   http://0.0.0.0:${PORT}/api                 ║
║   Health: http://0.0.0.0:${PORT}/health               ║
╚══════════════════════════════════════════════════╝
`);
