import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { registerTools } from "./tools.js";
import { db } from "./db.js";

const PORT = Number(process.env.PORT) || 9200;
const AUTH_TOKEN = process.env.COMMANDER_AUTH_TOKEN;

// ── Factory: 每个请求创建新的 McpServer（stateless 模式）──
function createServer(): McpServer {
  const server = new McpServer({
    name: "commander",
    version: "0.3.0",
  });
  registerTools(server);
  return server;
}

// ── Auth helper ─────────────────────────────────────
function requireAuth(req: Request): Response | null {
  if (!AUTH_TOKEN) return null; // no token = open mode (dev)
  const header = req.headers.get("Authorization");
  if (header === `Bearer ${AUTH_TOKEN}`) return null;
  // Also check query param for MCP clients that can't set headers
  const url = new URL(req.url);
  if (url.searchParams.get("token") === AUTH_TOKEN) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

// ── REST input schema ───────────────────────────────
const TaskSchema = z.object({
  session_name: z.string().min(1).max(200),
  task: z.string().min(1).max(10000),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
});

// ── HTTP Server (Bun native) ────────────────────────
Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // ── MCP Streamable HTTP endpoint ──
    // MCP protocol handles its own auth — skip token check here
    if (url.pathname === "/mcp") {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createServer();
      await server.connect(transport);
      return transport.handleRequest(req);
    }

    // ── REST: health (public, no auth) ──
    if (url.pathname === "/health") {
      const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM sessions").get();
      return Response.json({
        ok: true,
        version: "0.3.0",
        transport: "streamable-http",
        sessions: count?.cnt ?? 0,
        auth: AUTH_TOKEN ? "enabled" : "disabled",
        uptime: process.uptime(),
      });
    }

    // ── All REST /api endpoints require auth (if token configured) ──
    const authErr = requireAuth(req);
    if (authErr) return authErr;

    // ── REST: all sessions status ──
    if (url.pathname === "/api/status") {
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      db.run("UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'", [cutoff]);
      const sessions = db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all();
      return Response.json({ ok: true, sessions });
    }

    // ── REST: send task ──
    if (url.pathname === "/api/task" && req.method === "POST") {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      const parsed = TaskSchema.safeParse(raw);
      if (!parsed.success) {
        return Response.json({ error: "invalid input", details: parsed.error.format() }, { status: 400 });
      }
      const body = parsed.data;
      const id = crypto.randomUUID();
      db.run(
        `INSERT INTO inbox (id, session_name, type, priority, content, from_session)
         VALUES (?1, ?2, 'task', ?3, ?4, 'api')`,
        [id, body.session_name, body.priority, body.task]
      );
      return Response.json({ ok: true, message_id: id });
    }

    // ── REST: recent completions ──
    if (url.pathname === "/api/completions") {
      const since = url.searchParams.get("since") ?? new Date(Date.now() - 86400000).toISOString();
      const rows = db.query("SELECT * FROM completions WHERE completed_at >= ?1 ORDER BY completed_at DESC LIMIT 100").all(since);
      return Response.json({ ok: true, completions: rows });
    }

    return new Response(
      `Commander MCP Server v0.3.0 (Streamable HTTP)

Endpoints:
  POST /mcp            - MCP Streamable HTTP (for Claude Code / Codex)
  GET  /health         - Health check
  GET  /api/status     - All sessions ${AUTH_TOKEN ? "(auth required)" : ""}
  POST /api/task       - Send task via REST ${AUTH_TOKEN ? "(auth required)" : ""}
  GET  /api/completions - Recent completions ${AUTH_TOKEN ? "(auth required)" : ""}

Auth: ${AUTH_TOKEN ? "Bearer token enabled (set COMMANDER_AUTH_TOKEN)" : "disabled (set COMMANDER_AUTH_TOKEN to enable)"}
`,
      { status: 200, headers: { "Content-Type": "text/plain" } }
    );
  },
});

// ── Graceful shutdown ───────────────────────────────
function shutdown() {
  console.log("[commander] shutting down...");
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`
╔══════════════════════════════════════════════════╗
║   Commander MCP Server v0.3.0                     ║
║   Transport: Streamable HTTP (Bun native)         ║
║   Auth: ${AUTH_TOKEN ? "ENABLED (Bearer token)" : "DISABLED (set COMMANDER_AUTH_TOKEN)"}${"".padEnd(AUTH_TOKEN ? 5 : 0)}║
║                                                   ║
║   MCP:    http://0.0.0.0:${PORT}/mcp                 ║
║   REST:   http://0.0.0.0:${PORT}/api                 ║
║   Health: http://0.0.0.0:${PORT}/health               ║
╚══════════════════════════════════════════════════╝
`);
