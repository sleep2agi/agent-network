import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./tools.js";
import { db } from "./db.js";

const PORT = Number(process.env.PORT) || 9200;

// ── Factory: 每个请求创建新的 McpServer（stateless 模式）──
// 所有实例共享同一个 db，解决 "Already connected" 问题
function createServer(): McpServer {
  const server = new McpServer({
    name: "commander",
    version: "0.2.0",
  });
  registerTools(server);
  return server;
}

// ── HTTP Server (Bun native) ────────────────────────
let connectionCount = 0;

Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // ── MCP Streamable HTTP endpoint ──
    // Claude Code 连这里: { "url": "http://host:9200/mcp" }
    if (url.pathname === "/mcp") {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: 每个请求独立
      });
      const server = createServer();
      await server.connect(transport);
      const response = await transport.handleRequest(req);
      return response;
    }

    // ── REST: health ──
    if (url.pathname === "/health") {
      const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM sessions").get();
      return Response.json({
        ok: true,
        version: "0.2.0",
        transport: "streamable-http",
        sessions: count?.cnt ?? 0,
        uptime: process.uptime(),
      });
    }

    // ── REST: all sessions status ──
    if (url.pathname === "/api/status") {
      // Auto-offline: 10 分钟无心跳
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      db.run("UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'", [cutoff]);
      const sessions = db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all();
      return Response.json({ ok: true, sessions });
    }

    // ── REST: send task (for scripts/curl) ──
    if (url.pathname === "/api/task" && req.method === "POST") {
      const body = (await req.json()) as { session_name: string; task: string; priority?: string };
      const id = crypto.randomUUID();
      db.run(
        `INSERT INTO inbox (id, session_name, type, priority, content, from_session)
         VALUES (?1, ?2, 'task', ?3, ?4, 'api')`,
        [id, body.session_name, body.priority ?? "normal", body.task]
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
      `Commander MCP Server v0.2.0 (Streamable HTTP)

Endpoints:
  POST /mcp            - MCP Streamable HTTP (for Claude Code / Codex)
  GET  /health         - Health check
  GET  /api/status     - All sessions
  POST /api/task       - Send task via REST
  GET  /api/completions - Recent completions

Client config (.mcp.json):
  { "mcpServers": { "commander": { "url": "http://YOUR_IP:${PORT}/mcp" } } }
`,
      { status: 200, headers: { "Content-Type": "text/plain" } }
    );
  },
});

console.log(`
╔══════════════════════════════════════════════╗
║   Commander MCP Server v0.2.0                ║
║   Transport: Streamable HTTP (Bun native)    ║
║                                              ║
║   MCP:    http://0.0.0.0:${PORT}/mcp            ║
║   REST:   http://0.0.0.0:${PORT}/api            ║
║   Health: http://0.0.0.0:${PORT}/health          ║
╚══════════════════════════════════════════════╝
`);
