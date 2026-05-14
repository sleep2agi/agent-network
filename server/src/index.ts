import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { registerTools } from "./tools.js";
import { db, logTaskEvent, logAudit } from "./db.js";
import { createSSEStream, pushEvent, getSSEStats } from "./push.js";
import { register, login, resolveToken, getUserNetworks, getUserAllNetworks, createNetwork, deleteNetwork, renameNetwork, changePassword, issueUserToken, listTokens, createToken, revokeToken, getNetworkMembers, getUserNetworkRole, addNetworkMember, updateMemberRole, removeNetworkMember, createInvite, joinByInvite, createNetworkTokenForNode, type AuthUser } from "./auth.js";
import { prepareRename, commitRename, abortRename } from "./rename.js";

const PORT = Number(process.env.PORT) || 9200;
const HOST = process.env.HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.COMMHUB_AUTH_TOKEN;
const DEV_OPEN = process.argv.includes("--dev-open") || process.env.COMMHUB_DEV_OPEN === "1";
const TMUX_ENABLED = process.env.COMMHUB_ENABLE_TMUX === "1";
const SECURITY_LABEL = DEV_OPEN ? "⚠️ DEV OPEN MODE" : "🔒 secured";
const TMUX_ALLOWLIST = new Set(
  (process.env.COMMHUB_TMUX_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
let masterTokenDeprecationLogged = false;

if (AUTH_TOKEN) {
  console.warn("[commhub] COMMHUB_AUTH_TOKEN is deprecated and will be removed in v1.0. See RFC-001.");
}

// Read version from package.json so banners and /health stay in sync.
const SERVER_VERSION = (() => {
  try {
    const url = new URL("../package.json", import.meta.url);
    return JSON.parse(require("fs").readFileSync(url, "utf8")).version || "?";
  } catch { return "?"; }
})();

// In-memory log ring buffer — last N lines streamed via /api/server-logs.
// Wraps console.log/info/warn/error so EVERY existing log call lands here
// without source changes. Dashboard tails this buffer for "hub server log
// view" feature.
const LOG_RING_CAP = Number(process.env.COMMHUB_LOG_RING || 500);
type LogEntry = { ts: string; level: "log" | "info" | "warn" | "error"; line: string };
const logRing: LogEntry[] = [];
const _origConsole = { log: console.log.bind(console), info: console.info.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
function pushLog(level: LogEntry["level"], args: any[]) {
  const line = args.map(a => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(" ");
  logRing.push({ ts: new Date().toISOString(), level, line: line.slice(0, 4000) });
  if (logRing.length > LOG_RING_CAP) logRing.splice(0, logRing.length - LOG_RING_CAP);
}
console.log = (...args: any[]) => { pushLog("log", args); _origConsole.log(...args); };
console.info = (...args: any[]) => { pushLog("info", args); _origConsole.info(...args); };
console.warn = (...args: any[]) => { pushLog("warn", args); _origConsole.warn(...args); };
console.error = (...args: any[]) => { pushLog("error", args); _origConsole.error(...args); };

// ── Rate limiter (in-memory, per IP) ──
const rateLimits = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, maxPerMinute = 60): boolean {
  // Skip rate limiting for localhost/internal/unknown (dev/test)
  if (!ip || ip === "unknown" || ip === "127.0.0.1" || ip === "::1") return true;
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= maxPerMinute) return false;
  entry.count++;
  return true;
}
// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 300000);

// ── Factory: 每个请求创建新的 McpServer（stateless 模式）──
function createServer(clientIP?: string, enforceNetworkId?: string | null, enforceUserId?: string | null, callerAlias?: string | null, callerTokenIsNetwork = false): McpServer {
  const server = new McpServer({
    name: "commhub",
    version: "0.5.0",
  });
  registerTools(server, clientIP, enforceNetworkId, enforceUserId, callerAlias, callerTokenIsNetwork);
  return server;
}

// ── Auth helper ─────────────────────────────────────
function requestToken(req: Request): string {
  const header = req.headers.get("Authorization")?.replace("Bearer ", "");
  const url = new URL(req.url);
  return header || url.searchParams.get("token") || "";
}

function isLegacyAuthToken(req: Request): boolean {
  const token = requestToken(req);
  return !!AUTH_TOKEN && token === AUTH_TOKEN;
}

function requireAuth(req: Request): Response | null {
  const token = requestToken(req);

  // V3: check api_tokens first
  if (token) {
    const resolved = resolveToken(token);
    if (resolved) return null; // valid user token
  }

  // Legacy: check global COMMHUB_AUTH_TOKEN
  if (!AUTH_TOKEN && DEV_OPEN) return null; // explicit local/dev open mode
  if (token === AUTH_TOKEN) {
    const u = new URL(req.url);
    const readOnlyApi = u.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS");
    if (!readOnlyApi) return Response.json({ ok: false, error: "master-token auth is deprecated; use admin utok_" }, { status: 401 });
    if (!masterTokenDeprecationLogged) {
      console.warn("[commhub] master-token auth is deprecated and will be removed in v1.0. See RFC-001.");
      masterTokenDeprecationLogged = true;
    }
    return null;
  }

  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function getClientIP(req: Request, server?: any): string {
  const direct = server?.requestIP?.(req)?.address;
  if (direct) return direct;
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : (req.headers.get("x-real-ip") ?? "unknown");
}

function isLocalhostIP(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

// Normalize the raw `agent` field into a canonical runtime identifier for the
// dashboard's Runtime badge. Returns null for unknown/absent agents so the
// frontend can fall back to a placeholder.
function normalizeRuntime(agent: unknown): string | null {
  if (typeof agent !== "string" || agent.length === 0) return null;
  if (agent === "claude-code") return "claude-code-cli";
  if (agent.startsWith("agent-node:codex")) return "codex-sdk";
  if (agent.startsWith("agent-node:claude")) return "claude-agent-sdk";
  if (agent === "http-api" || agent === "http" || agent === "api") return "http-api";
  return null;
}

function isTmuxAllowedIP(ip: string): boolean {
  return isLocalhostIP(ip) || TMUX_ALLOWLIST.has(ip);
}

function requireAdminAuth(req: Request): Response | null {
  const token = requestToken(req);
  if (!token) return Response.json({ ok: false, error: "auth required" }, { status: 401 });
  const resolved = resolveToken(token);
  if (!resolved) return Response.json({ ok: false, error: "invalid token" }, { status: 401 });
  if (resolved.user.role !== "admin") return Response.json({ ok: false, error: "admin required" }, { status: 403 });
  return null;
}

function requireTmuxAccess(req: Request, server?: any): Response | null {
  if (!TMUX_ENABLED) return Response.json({ ok: false, error: "tmux disabled" }, { status: 404 });
  const ip = getClientIP(req, server);
  if (!isTmuxAllowedIP(ip)) return Response.json({ ok: false, error: "tmux access denied from this ip" }, { status: 403 });
  return requireAdminAuth(req);
}

// Extract user + network + token-binding identity from request token.
function resolveRequestAuth(req: Request): { userId: string; networkId: string | null; username: string; tokenName: string | null } | null {
  const token = requestToken(req);
  if (!token) return null;
  const resolved = resolveToken(token);
  if (!resolved) return null;
  return { userId: resolved.user.user_id, networkId: resolved.networkId, username: resolved.user.username, tokenName: resolved.tokenName };
}

type RestNetworkScope = {
  networkId: string | null;
  networkIds: string[] | null;
  denied?: string;
};

function getUserNetworkIds(userId: string): string[] {
  return db.all<{ network_id: string }>(
    "SELECT network_id FROM network_members WHERE user_id = ?1",
    userId
  ).map((row) => row.network_id);
}

function resolveRestNetworkScope(url: URL, authCtx: { userId: string; networkId: string | null } | null, isAdmin: boolean): RestNetworkScope {
  const requested = url.searchParams.get("network_id");

  // Legacy global token or open dev mode keeps the old global behavior.
  if (!authCtx) return { networkId: requested || null, networkIds: null };

  // Network tokens are forcibly scoped to their bound network.
  if (authCtx.networkId) return { networkId: authCtx.networkId, networkIds: null };

  // System admins may intentionally inspect all networks.
  if (isAdmin) return { networkId: requested || null, networkIds: null };

  if (requested) {
    const role = getUserNetworkRole(authCtx.userId, requested);
    if (!role) return { networkId: null, networkIds: [], denied: "access denied to requested network" };
    return { networkId: requested, networkIds: null };
  }

  return { networkId: null, networkIds: getUserNetworkIds(authCtx.userId) };
}

function addNetworkScope(sql: string, params: any[], scope: RestNetworkScope, column = "network_id"): string {
  if (scope.networkId) {
    sql += ` AND ${column} = ?${params.length + 1}`;
    params.push(scope.networkId);
  } else if (scope.networkIds) {
    if (scope.networkIds.length === 0) {
      sql += " AND 1=0";
    } else {
      const placeholders = scope.networkIds.map((_, i) => `?${params.length + i + 1}`).join(", ");
      sql += ` AND ${column} IN (${placeholders})`;
      params.push(...scope.networkIds);
    }
  }
  return sql;
}

function singleNetworkId(scope: RestNetworkScope): string | null {
  if (scope.networkId) return scope.networkId;
  if (scope.networkIds?.length === 1) return scope.networkIds[0];
  return null;
}

function canRestWriteNetwork(authCtx: { userId: string; networkId: string | null } | null, networkId: string | null, isAdmin: boolean): boolean {
  if (!authCtx) return true; // legacy global token or open dev mode
  if (isAdmin) return true;
  if (!networkId) return false;
  const role = getUserNetworkRole(authCtx.userId, networkId);
  return !!role && role !== "viewer";
}

// ── REST input schema ───────────────────────────────
const TaskSchema = z.object({
  alias: z.string().min(1).max(200),
  task: z.string().min(1).max(10000),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
  from: z.string().max(200).optional(),
  network_id: z.string().max(200).optional(),
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
  // CORS allowlist is driven entirely by COMMHUB_CORS_ORIGINS env (comma-separated).
  // Default (env unset) allows localhost dev origins only — see CORS_ORIGINS above.
  // No author-specific domains are hardcoded; production deployments must set
  // COMMHUB_CORS_ORIGINS explicitly. See docs/concepts/security.md "CORS 配置".
  const allowed = CORS_ORIGINS.includes(origin) ? origin : "";
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
      const expired = db.all<{ task_id: string }>(
        "SELECT task_id FROM tasks WHERE status = 'expired' AND completed_at >= datetime('now', '-1 minute')");
      for (const t of expired) logTaskEvent(t.task_id, null, "expired", "patrol");
    }
  } catch {}
}, 5 * 60 * 1000);

Bun.serve({
  port: PORT,
  hostname: HOST,
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
      const tmuxErr = requireTmuxAccess(req, server);
      if (tmuxErr) return withCors(req, tmuxErr);
      if (server.upgrade(req, { data: { tmuxName: wsMatch[1] } } as any)) return;
    }

    // ── MCP Streamable HTTP endpoint ──
    if (url.pathname === "/mcp") {
      const authErr = requireAuth(req);
      if (authErr) return withCors(req, authErr);
      const clientIP = getClientIP(req, server);
      // V3: resolve token → enforce network_id in all MCP tools.
      // utok_ (user token, not network-bound) is allowed — the tool layer
      // scopes to the user's accessible networks. Without this Dashboard
      // (which logs in as a user) cannot call send_task.
      const token = requestToken(req);
      const authCtx = resolveRequestAuth(req);
      const enforceNetId = authCtx?.networkId || null;
      // Derive the calling alias from the token name (e.g., 'node:视频审查')
      // so peer agents see the real sender instead of 'hub' on send_task.
      const callerAlias = authCtx?.tokenName?.startsWith("node:")
        ? authCtx.tokenName.slice("node:".length)
        : (authCtx?.username || null);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = createServer(clientIP, enforceNetId, authCtx?.userId || null, callerAlias, !!token?.startsWith("ntok_"));
      await mcpServer.connect(transport);
      const response = await transport.handleRequest(req);
      // Disconnect after response to prevent McpServer leak
      setImmediate(() => mcpServer.close().catch(() => {}));
      return response;
    }

    // ── SSE push: Agent 实时接收任务推送 ──
    // GET /events/知识哥 → 保持长连接，send_task 时秒推
    const eventsMatch = url.pathname.match(/^\/events\/(.+)$/);
    if (eventsMatch && req.method === "GET") {
      const authErr = requireAuth(req);
      if (authErr) return authErr;
      const sessionName = decodeURIComponent(eventsMatch[1]);
      const token = requestToken(req);
      const authCtx = resolveRequestAuth(req);
      const scopedNetId = authCtx?.networkId || url.searchParams.get("network_id");
      if (!authCtx && isLegacyAuthToken(req)) {
        if (scopedNetId) {
          const session = db.get<any>(
            "SELECT 1 FROM sessions WHERE alias = ?1 AND network_id = ?2",
            sessionName, scopedNetId
          );
          if (!session) return withCors(req, Response.json({ ok: false, error: "session not in requested network" }, { status: 403 }));
        }
        return createSSEStream(sessionName, scopedNetId);
      }
      if (!token?.startsWith("ntok_") || !authCtx || !scopedNetId) {
        return withCors(req, Response.json({ ok: false, error: "network-scoped token required for SSE" }, { status: 403 }));
      }
      const role = getUserNetworkRole(authCtx.userId, scopedNetId);
      if (!role) return withCors(req, Response.json({ ok: false, error: "not a member of this network" }, { status: 403 }));
      const session = db.get<any>(
        "SELECT 1 FROM sessions WHERE alias = ?1 AND network_id = ?2",
        sessionName, scopedNetId
      );
      if (!session && authCtx.networkId !== scopedNetId) {
        return withCors(req, Response.json({ ok: false, error: "session not in requested network" }, { status: 403 }));
      }
      return createSSEStream(sessionName, scopedNetId);
    }

    // ── V3: License endpoints ──
    if (url.pathname === "/api/license" && req.method === "GET") {
      const license = db.get<any>("SELECT * FROM licenses ORDER BY created_at LIMIT 1");
      if (!license) return withCors(req, Response.json({ ok: true, status: "no_license" }));
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const expired = license.expires_at && license.expires_at < now;
      const daysLeft = license.expires_at
        ? Math.max(0, Math.ceil((new Date(license.expires_at).getTime() - Date.now()) / 86400000))
        : null;
      return withCors(req, Response.json({
        ok: true,
        license: { type: license.type, expires_at: license.expires_at, days_left: daysLeft, expired },
        limits: { max_agents: license.max_agents, max_networks: license.max_networks, max_tasks_day: license.max_tasks_day },
      }));
    }

    if (url.pathname === "/api/license/activate" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const key = body.key;
        if (!key) return withCors(req, Response.json({ ok: false, error: "key required" }, { status: 400 }));
        // For now: accept any key starting with "anet-" as valid pro license
        if (!key.startsWith("anet-") || key.length < 16) {
          return withCors(req, Response.json({ ok: false, error: "invalid license key" }, { status: 400 }));
        }
        // Upgrade existing license or create new
        db.run("DELETE FROM licenses");
        const licId = `lic_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        db.run(
          "INSERT INTO licenses (id, license_key, type, max_agents, max_networks, max_tasks_day, activated_at, expires_at) VALUES (?1, ?2, 'pro', 50, 10, 10000, datetime('now'), datetime('now', '+365 days'))",
          [licId, key]
        );
        return withCors(req, Response.json({ ok: true, type: "pro", expires_in_days: 365 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3: Auth endpoints (public) ──
    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const clientIP = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      if (!checkRateLimit(clientIP, 30)) {
        return withCors(req, Response.json({ ok: false, error: "too many requests, try again later" }, { status: 429 }));
      }
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
      const clientIP = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      if (!checkRateLimit(clientIP, 10)) {
        logAudit(null, null, "login_rate_limited", "auth", undefined, clientIP);
        return withCors(req, Response.json({ ok: false, error: "too many attempts, try again later" }, { status: 429 }));
      }
      try {
        const body = await req.json() as any;
        const result = login(body.username, body.password);
        if (result.ok) logAudit(result.user!.user_id, body.username, "login", "user", result.user!.user_id);
        else logAudit(null, body.username, "login_failed", "user", undefined, "invalid credentials");
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
      const networks = getUserAllNetworks(resolved.user.user_id);
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
        const user = db.get<any>("SELECT user_id, username, display_name, email, role FROM users WHERE user_id = ?1", resolved.user.user_id);
        return withCors(req, Response.json({ ok: true, user }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/auth/password" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        const result = changePassword(resolved.user.user_id, body.old_password, body.new_password, resolved.tokenId);
        if (result.ok) {
          const issued = issueUserToken(resolved.user.user_id, "password-change");
          if (resolved.tokenId) revokeToken(resolved.user.user_id, resolved.tokenId);
          logAudit(resolved.user.user_id, resolved.user.username, "password_changed", "user", resolved.user.user_id);
          return withCors(req, Response.json({ ...result, token: issued.token, token_id: issued.token_id }));
        }
        return withCors(req, Response.json(result, { status: 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3.13: Create network token for a node ──
    if (url.pathname === "/api/auth/node-token" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (!body.network_id || !body.node_name) return withCors(req, Response.json({ ok: false, error: "network_id and node_name required" }, { status: 400 }));
        const result = createNetworkTokenForNode(resolved.user.user_id, body.network_id, body.node_name);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "node_token_created", "network", body.network_id, body.node_name);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── #84: node rename 2PC — Server surface (RFC-010 §4) ──
    // The CLI orchestrates the 2PC; these endpoints are the Server steps:
    // prepare = PHASE 1 P3, commit = PHASE 2 C1, abort = PHASE 1 rollback.
    if (url.pathname === "/api/node-rename/prepare" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (!body.network_id || !body.old_alias || !body.new_alias) {
          return withCors(req, Response.json({ ok: false, error: "network_id, old_alias, new_alias required" }, { status: 400 }));
        }
        const result = prepareRename(resolved.user.user_id, body.network_id, body.old_alias, body.new_alias);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "node_rename_prepared", "node", body.old_alias, body.new_alias);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/node-rename/commit" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (!body.txn_id) return withCors(req, Response.json({ ok: false, error: "txn_id required" }, { status: 400 }));
        const result = commitRename(resolved.user.user_id, body.txn_id);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "node_rename_committed", "node", body.txn_id);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/node-rename/abort" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (!body.txn_id) return withCors(req, Response.json({ ok: false, error: "txn_id required" }, { status: 400 }));
        const result = abortRename(resolved.user.user_id, body.txn_id);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "node_rename_aborted", "node", body.txn_id);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3: Token management ──
    if (url.pathname === "/api/auth/tokens" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const tokens = listTokens(resolved.user.user_id);
      return withCors(req, Response.json({ ok: true, tokens }));
    }

    if (url.pathname === "/api/auth/tokens" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        const result = createToken(resolved.user.user_id, body.name || "api-token", body.network_id);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "token_created", "token", result.token_id);
        return withCors(req, Response.json(result));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    const tokenDeleteMatch = url.pathname.match(/^\/api\/auth\/tokens\/([^/]+)$/);
    if (tokenDeleteMatch && req.method === "DELETE") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const result = revokeToken(resolved.user.user_id, tokenDeleteMatch[1]);
      if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "token_revoked", "token", tokenDeleteMatch[1]);
      return withCors(req, Response.json(result, { status: result.ok ? 200 : 404 }));
    }

    // ── V3: Network management ──
    if (url.pathname === "/api/networks" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      // V3.13: ntok_ can only see its bound network; utok_ sees all member networks
      if (resolved.networkId) {
        // ntok_ — only return the bound network
        const net = db.get<any>("SELECT * FROM networks WHERE network_id = ?1", resolved.networkId);
        return withCors(req, Response.json({ ok: true, networks: net ? [net] : [] }));
      }
      const networks = getUserAllNetworks(resolved.user.user_id);
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

    // ── V3.13: Network members + invites ──
    const membersMatch = url.pathname.match(/^\/api\/networks\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (membersMatch) {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const netId = membersMatch[1];
      const targetUid = membersMatch[2];
      const callerRole = getUserNetworkRole(resolved.user.user_id, netId);
      if (!callerRole) return withCors(req, Response.json({ ok: false, error: "not a member of this network" }, { status: 403 }));

      if (req.method === "GET") {
        if (!["owner", "admin"].includes(callerRole)) return withCors(req, Response.json({ ok: false, error: "owner/admin required" }, { status: 403 }));
        const members = getNetworkMembers(netId);
        return withCors(req, Response.json({ ok: true, members }));
      }
      if (req.method === "POST") {
        if (!["owner", "admin"].includes(callerRole)) return withCors(req, Response.json({ ok: false, error: "owner/admin required" }, { status: 403 }));
        const body = await req.json() as any;
        const result = addNetworkMember(netId, body.user_id, body.role || "member", resolved.user.user_id);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "member_added", "network", netId, `${body.user_id} as ${body.role || "member"}`);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      }
      if (req.method === "PUT" && targetUid) {
        if (callerRole !== "owner") return withCors(req, Response.json({ ok: false, error: "owner required" }, { status: 403 }));
        const body = await req.json() as any;
        const result = updateMemberRole(netId, targetUid, body.role);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "member_role_changed", "network", netId, `${targetUid} → ${body.role}`);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      }
      if (req.method === "DELETE" && targetUid) {
        if (!["owner", "admin"].includes(callerRole)) return withCors(req, Response.json({ ok: false, error: "owner/admin required" }, { status: 403 }));
        const result = removeNetworkMember(netId, targetUid);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "member_removed", "network", netId, targetUid);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      }
    }

    if (url.pathname.match(/^\/api\/networks\/([^/]+)\/invite$/) && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const netId = url.pathname.split("/")[3];
      const callerRole = getUserNetworkRole(resolved.user.user_id, netId);
      if (!callerRole || !["owner", "admin"].includes(callerRole)) {
        return withCors(req, Response.json({ ok: false, error: "owner/admin required" }, { status: 403 }));
      }
      const body = await req.json() as any;
      const result = createInvite(netId, resolved.user.user_id, body.role || "member", body.max_uses || 1, body.expires_days);
      if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "invite_created", "network", netId, result.invite_code);
      return withCors(req, Response.json(result));
    }

    if (url.pathname === "/api/networks/join" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const body = await req.json() as any;
      const result = joinByInvite(body.invite_code, resolved.user.user_id);
      if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "network_joined", "network", result.network_id, `via invite, role=${result.role}`);
      return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
    }

    // ── V3: Admin APIs (require auth) ──
    if (url.pathname === "/api/users" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved || resolved.user.role !== "admin") {
        return withCors(req, Response.json({ ok: false, error: "admin required" }, { status: 403 }));
      }
      const users = db.all("SELECT user_id, username, display_name, email, role, created_at FROM users ORDER BY created_at");
      return withCors(req, Response.json({ ok: true, users }));
    }

    const netDetailMatch = url.pathname.match(/^\/api\/networks\/([^/]+)$/);
    if (netDetailMatch && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const networkId = netDetailMatch[1];
      const network = db.get<any>("SELECT * FROM networks WHERE network_id = ?1", networkId);
      if (!network) return withCors(req, Response.json({ ok: false, error: "network not found" }, { status: 404 }));
      // Membership check: must be a member or system admin
      const viewerRole = getUserNetworkRole(resolved.user.user_id, networkId);
      if (!viewerRole && resolved.user.role !== "admin") {
        return withCors(req, Response.json({ ok: false, error: "access denied" }, { status: 403 }));
      }
      // Get network stats
      const nodeCount = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM nodes WHERE network_id = ?1", networkId);
      const sessionCount = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sessions WHERE network_id = ?1", networkId);
      const taskStats = db.all<any>("SELECT status, COUNT(*) as count FROM tasks WHERE network_id = ?1 GROUP BY status", networkId);
      return withCors(req, Response.json({
        ok: true, network,
        stats: { nodes: nodeCount?.cnt || 0, sessions: sessionCount?.cnt || 0, tasks: taskStats },
      }));
    }

    if (netDetailMatch && req.method === "DELETE") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const result = deleteNetwork(resolved.user.user_id, netDetailMatch[1]);
      if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "network_deleted", "network", netDetailMatch[1]);
      return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
    }

    if (netDetailMatch && req.method === "PUT") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (body.name) {
          const result = renameNetwork(resolved.user.user_id, netDetailMatch[1], body.name);
          if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "network_renamed", "network", netDetailMatch[1], body.name);
          return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
        }
        return withCors(req, Response.json({ ok: false, error: "name required" }, { status: 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── REST: health (public, no auth) ──
    if (url.pathname === "/health") {
      const count = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sessions");
      const sse = getSSEStats();
      const license = db.get<any>("SELECT type, expires_at FROM licenses LIMIT 1");
      return withCors(req, Response.json({
        ok: true,
        version: SERVER_VERSION,
        api_version: "v3",
        transport: "streamable-http",
        sessions_count: count?.cnt ?? 0,
        sse_connections: sse.total,
        sse_sessions: sse.sessions,
        auth: DEV_OPEN ? "dev-open" : "user-token",
        security: DEV_OPEN ? "dev-open" : "secured",
        tmux: TMUX_ENABLED ? "enabled" : "disabled",
        v3_auth: true,
        multi_network: true,
        license: license?.type || "none",
        uptime: Math.floor(process.uptime()),
      }));
    }

    // ── All REST /api endpoints require auth (if token configured) ──
    const authErr = requireAuth(req);
    if (authErr) return withCors(req, authErr);

    // Resolve network scope for REST queries — enforce isolation
    // Token-bound networkId takes precedence (ntok_ → forced), then query param
    const restAuth = resolveRequestAuth(req);
    const isAdmin = !!(restAuth?.username && db.get<any>("SELECT role FROM users WHERE username = ?1", restAuth.username)?.role === "admin");
    const restScope = resolveRestNetworkScope(url, restAuth, isAdmin);
    if (restScope.denied) {
      return withCors(req, Response.json({ ok: false, error: restScope.denied }, { status: 403 }));
    }

    // ── REST: all sessions status ──
    if (url.pathname === "/api/status") {
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      const staleParams: any[] = [cutoff];
      let staleSql = "UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'";
      staleSql = addNetworkScope(staleSql, staleParams, restScope);
      db.run(staleSql, staleParams);
      const params: any[] = [];
      let sql = "SELECT * FROM sessions WHERE 1=1";
      sql = addNetworkScope(sql, params, restScope);
      sql += " ORDER BY updated_at DESC";
      // `model` comes straight from the sessions row (SELECT *); `runtime` is
      // derived from the raw `agent` field. Both default to null for old nodes
      // that never reported a model — the dashboard falls back to a placeholder.
      const sessions = db.all(sql, ...params).map((s: any) => ({
        ...s,
        model: s.model ?? null,
        runtime: normalizeRuntime(s.agent),
      }));
      const summary = sessions.reduce((acc: any, session: any) => {
        const raw = String(session.status || "").toLowerCase();
        if (raw === "offline") acc.offline++;
        else if (["working", "blocked", "error", "waiting_input", "running", "busy"].includes(raw)) acc.working++;
        else acc.idle++;
        return acc;
      }, { idle: 0, working: 0, offline: 0, total: sessions.length });
      return withCors(req, Response.json({ ok: true, sessions, summary }));
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
      let taskNetId: string | null = null;
      if (restAuth?.networkId) {
        taskNetId = restAuth.networkId;
      } else if (body.network_id) {
        if (restAuth && !isAdmin && !getUserNetworkRole(restAuth.userId, body.network_id)) {
          return withCors(req, Response.json({ ok: false, error: "access denied to requested network" }, { status: 403 }));
        }
        taskNetId = body.network_id;
      } else {
        taskNetId = restAuth ? singleNetworkId(restScope) : null;
      }
      if (restAuth && !taskNetId) {
        return withCors(req, Response.json({ ok: false, error: "network_id required for user token when multiple networks are available" }, { status: 400 }));
      }
      if (!canRestWriteNetwork(restAuth, taskNetId, isAdmin)) {
        return withCors(req, Response.json({ ok: false, error: "permission_denied" }, { status: 403 }));
      }
      const id = crypto.randomUUID();
      const fromSession = body.from || "api";
      const ttlSeconds = (body as any).ttl_seconds || 3600;
      // Mirror send_task MCP: write inbox + tasks rows in a single
      // transaction so the dispatch is visible to dashboard's Tasks page
      // and the parent_task_id lineage chain. Previously this endpoint
      // only wrote inbox, leaving GET /api/tasks empty for any task
      // dispatched via REST (anet demo, dashboard Dispatch button, etc.).
      db.transaction(() => {
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session, requires_response, network_id)
           VALUES (?1, ?2, 'task', ?3, ?4, ?5, 'reply', ?6)`,
          [id, body.alias, body.priority, body.task, fromSession, taskNetId]
        );
        db.run(
          `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id)
           VALUES (?1, ?2, ?3, ?4, 'delivered', ?5, 'reply', datetime('now'), datetime('now'), datetime('now', ?6), ?7)`,
          [id, fromSession, body.alias, body.priority, body.task, `+${ttlSeconds} seconds`, taskNetId]
        );
        // Touch session row so the dashboard reflects "task in flight"
        // immediately, without waiting for the agent's report_status to
        // arrive. Updating both `task` and `updated_at` is enough — we
        // leave `status` to the agent (idle → working → idle).
        const touchParams: any[] = [body.task.slice(0, 200), body.alias];
        let touchSql = "UPDATE sessions SET task = ?1, updated_at = datetime('now') WHERE alias = ?2";
        if (taskNetId) { touchSql += " AND network_id = ?3"; touchParams.push(taskNetId); }
        db.run(touchSql, touchParams);
      });
      // SSE push: 秒达
      const pendingParams: any[] = [body.alias];
      let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      if (taskNetId) { pendingSql += " AND network_id = ?2"; pendingParams.push(taskNetId); }
      const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);
      const sessionParams: any[] = [body.alias];
      let sessionSql = "SELECT 1 FROM sessions WHERE alias = ?1";
      if (taskNetId) { sessionSql += " AND network_id = ?2"; sessionParams.push(taskNetId); }
      const targetSession = db.get<any>(sessionSql, ...sessionParams);
      if (targetSession) pushEvent(body.alias, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority: body.priority, from: fromSession }, taskNetId);
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
      if (restAuth && !restScope.networkId && !isAdmin) {
        return withCors(req, Response.json({ ok: false, error: "network_id required for user token when broadcasting" }, { status: 400 }));
      }
      if (!canRestWriteNetwork(restAuth, restScope.networkId, isAdmin)) {
        return withCors(req, Response.json({ ok: false, error: "permission_denied" }, { status: 403 }));
      }
      let sql = "SELECT alias, network_id FROM sessions WHERE alias IS NOT NULL";
      const params: any[] = [];
      sql = addNetworkScope(sql, params, restScope);
      if (body.filter_server) { sql += " AND server = ?"; params.push(body.filter_server); }
      if (body.filter_status) { sql += " AND status = ?"; params.push(body.filter_status); }
      const targets = db.all<{ alias: string; network_id: string | null }>(sql, ...params);
      const ids: string[] = [];
      for (const t of targets) {
        const id = crypto.randomUUID();
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id)
           VALUES (?1, ?2, 'broadcast', 'normal', ?3, 'api', ?4)`,
          [id, t.alias, body.message, t.network_id]
        );
        ids.push(id);
      }
      for (const t of targets) {
        pushEvent(t.alias, { type: "broadcast", inbox_count: 1 }, t.network_id);
      }
      return withCors(req, Response.json({ ok: true, recipients: targets.length, message_ids: ids }));
    }

    // ── REST: tmux capture-pane ──
    const tmuxCapture = url.pathname.match(/^\/api\/tmux\/([a-zA-Z0-9_-]+)$/);
    if (tmuxCapture && req.method === "GET") {
      const tmuxErr = requireTmuxAccess(req, server);
      if (tmuxErr) return withCors(req, tmuxErr);
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
      const tmuxErr = requireTmuxAccess(req, server);
      if (tmuxErr) return withCors(req, tmuxErr);
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
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const since = url.searchParams.get("since") ?? new Date(Date.now() - 3600000).toISOString().replace("T", " ").slice(0, 19);
      const params: any[] = [since];
      let sql = "SELECT id, session_name as to_alias, from_session as from_alias, type, priority, content, created_at, network_id FROM inbox WHERE created_at >= ?1";
      sql = addNetworkScope(sql, params, restScope);
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const rows = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, messages: rows }));
    }

    // ── REST: stats summary ──
    if (url.pathname === "/api/stats") {
      const taskStatsParams: any[] = [];
      let taskStatsSql = "SELECT status, COUNT(*) as count FROM tasks WHERE 1=1";
      taskStatsSql = addNetworkScope(taskStatsSql, taskStatsParams, restScope);
      taskStatsSql += " GROUP BY status";
      const taskStats = db.all<any>(taskStatsSql, ...taskStatsParams);

      const sessionStatsParams: any[] = [];
      let sessionStatsSql = "SELECT status, COUNT(*) as count FROM sessions WHERE 1=1";
      sessionStatsSql = addNetworkScope(sessionStatsSql, sessionStatsParams, restScope);
      sessionStatsSql += " GROUP BY status";
      const sessionStats = db.all<any>(sessionStatsSql, ...sessionStatsParams);

      const totalTasksParams: any[] = [];
      let totalTasksSql = "SELECT COUNT(*) as cnt FROM tasks WHERE 1=1";
      totalTasksSql = addNetworkScope(totalTasksSql, totalTasksParams, restScope);
      const totalTasks = db.get<{ cnt: number }>(totalTasksSql, ...totalTasksParams);

      const totalNodesParams: any[] = [];
      let totalNodesSql = "SELECT COUNT(*) as cnt FROM nodes WHERE 1=1";
      totalNodesSql = addNetworkScope(totalNodesSql, totalNodesParams, restScope);
      const totalNodes = db.get<{ cnt: number }>(totalNodesSql, ...totalNodesParams);

      const recentTasksParams: any[] = [];
      let recentTasksSql = "SELECT task_id, from_name, to_name, status, created_at FROM tasks WHERE 1=1";
      recentTasksSql = addNetworkScope(recentTasksSql, recentTasksParams, restScope);
      recentTasksSql += " ORDER BY created_at DESC LIMIT 5";
      const recentTasks = db.all<any>(recentTasksSql, ...recentTasksParams);
      return withCors(req, Response.json({
        ok: true,
        network_id: restScope.networkId || null,
        tasks: { total: totalTasks?.cnt || 0, by_status: taskStats },
        sessions: { by_status: sessionStats },
        nodes: { total: totalNodes?.cnt || 0 },
        recent_tasks: recentTasks,
      }));
    }

    // ── REST: server log tail (in-memory ring buffer, last LOG_RING_CAP lines) ──
    // Admin-only because logs may include user names + task content.
    if (url.pathname === "/api/server-logs") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      if (resolved.user.role !== "admin") return withCors(req, Response.json({ ok: false, error: "admin only" }, { status: 403 }));
      const limit = Math.min(Number(url.searchParams.get("limit")) || 200, LOG_RING_CAP);
      const since = url.searchParams.get("since"); // ISO timestamp; only return logs newer
      let entries = logRing.slice(-limit);
      if (since) entries = entries.filter(e => e.ts > since);
      // Newest first
      entries = entries.slice().reverse();
      return withCors(req, Response.json({ ok: true, logs: entries, capacity: LOG_RING_CAP }));
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
      const logs = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, logs, count: logs.length }));
    }

    // ── REST: task events (V2 Sprint 2) ──
    if (url.pathname === "/api/task_events") {
      const taskId = url.searchParams.get("task_id");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
      let sql = "SELECT * FROM task_events WHERE 1=1";
      const params: any[] = [];
      sql = addNetworkScope(sql, params, restScope);
      if (taskId) { sql += ` AND task_id = ?${params.length + 1}`; params.push(taskId); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const rows = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, events: rows, count: rows.length }));
    }

    // ── REST: nodes table (V2 Sprint 2) ──
    if (url.pathname === "/api/nodes") {
      const nodeId = url.searchParams.get("node_id");
      const alias = url.searchParams.get("alias");
      let sql = "SELECT * FROM nodes WHERE 1=1";
      const params: any[] = [];
      sql = addNetworkScope(sql, params, restScope);
      if (nodeId) { sql += ` AND node_id = ?${params.length + 1}`; params.push(nodeId); }
      if (alias) { sql += ` AND alias = ?${params.length + 1}`; params.push(alias); }
      sql += " ORDER BY updated_at DESC";
      const rows = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, nodes: rows, count: rows.length }));
    }

    // ── REST: tasks table (V2) ──
    if (url.pathname === "/api/tasks") {
      const taskId = url.searchParams.get("task_id");
      const status = url.searchParams.get("status");
      const toName = url.searchParams.get("to_name");
      const fromName = url.searchParams.get("from_name");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

      let sql = "SELECT * FROM tasks WHERE 1=1";
      const params: any[] = [];
      sql = addNetworkScope(sql, params, restScope);
      if (taskId) { sql += ` AND task_id = ?${params.length + 1}`; params.push(taskId); }
      if (status) { sql += ` AND status = ?${params.length + 1}`; params.push(status); }
      if (toName) { sql += ` AND to_name = ?${params.length + 1}`; params.push(toName); }
      if (fromName) { sql += ` AND from_name = ?${params.length + 1}`; params.push(fromName); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);

      const rows = db.all(sql, ...params);
      const statsParams: any[] = [];
      let statsSql = "SELECT status, COUNT(*) as count FROM tasks WHERE 1=1";
      statsSql = addNetworkScope(statsSql, statsParams, restScope);
      statsSql += " GROUP BY status";
      const stats = db.all<any>(statsSql, ...statsParams);
      return withCors(req, Response.json({ ok: true, tasks: rows, count: rows.length, stats }));
    }

    // ── REST: recent completions ──
    if (url.pathname === "/api/completions") {
      const since = url.searchParams.get("since") ?? new Date(Date.now() - 86400000).toISOString();
      const params: any[] = [since];
      let sql = "SELECT * FROM completions WHERE completed_at >= ?1";
      sql = addNetworkScope(sql, params, restScope);
      sql += " ORDER BY completed_at DESC LIMIT 100";
      const rows = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, completions: rows }));
    }

    return withCors(req, new Response(
      `CommHub MCP Server v${SERVER_VERSION} (Streamable HTTP + SSE Push)

Endpoints:
  POST /mcp               - MCP Streamable HTTP (for Claude Code / Codex)
  GET  /events/:session   - SSE realtime push (Agent subscribes here)
  GET  /health            - Health check
  GET  /api/status        - All sessions (auth required)
  POST /api/task          - Send task via REST (auth required)
  GET  /api/tasks         - Tasks table (V2) (auth required)
  GET  /api/completions   - Recent completions (auth required)
  GET  /api/tmux/:name    - Capture tmux pane output (${TMUX_ENABLED ? "admin + localhost/allowlist required" : "disabled"})
  POST /api/tmux/:name/send - Send keys to tmux (${TMUX_ENABLED ? "admin + localhost/allowlist required" : "disabled"})

Security: ${SECURITY_LABEL}
`,
      { status: 200, headers: { "Content-Type": "text/plain" } }
    ));
  },

  // ── WebSocket handler for tmux terminal streaming ──
  websocket: {
    open(ws) {
      const { tmuxName } = ws.data as unknown as { tmuxName: string };
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
      const { tmuxName } = ws.data as unknown as { tmuxName: string };
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
      const { tmuxName } = ws.data as unknown as { tmuxName: string };
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
║   CommHub MCP Server v${SERVER_VERSION}                     ║
║   Transport: Streamable HTTP (Bun native)         ║
║   Security: ${SECURITY_LABEL}${" ".repeat(Math.max(0, 33 - SECURITY_LABEL.length))}║
║   Tmux: ${TMUX_ENABLED ? "ENABLED (admin + localhost/allowlist)" : "DISABLED (set COMMHUB_ENABLE_TMUX=1)"}${" ".repeat(Math.max(0, TMUX_ENABLED ? 0 : 2))}║
║                                                   ║
║   MCP:    http://${HOST}:${PORT}/mcp                 ║
║   REST:   http://${HOST}:${PORT}/api                 ║
║   Health: http://${HOST}:${PORT}/health               ║
╚══════════════════════════════════════════════════╝
`);
