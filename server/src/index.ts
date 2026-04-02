import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerTools } from "./tools.js";
import { db } from "./db.js";

const PORT = Number(process.env.PORT) || 9200;

// ── MCP Server ──────────────────────────────────────
const mcpServer = new McpServer({
  name: "commander",
  version: "0.1.0",
});
registerTools(mcpServer);

// ── Track SSE connections ───────────────────────────
const transports = new Map<string, SSEServerTransport>();

// ── HTTP Server (Bun) ───────────────────────────────
Bun.serve({
  port: PORT,
  idleTimeout: 0, // keep SSE connections alive

  async fetch(req) {
    const url = new URL(req.url);

    // ── MCP SSE endpoint ──
    // Claude Code / Codex connect here via settings.json: { "url": "http://host:9200/sse" }
    if (url.pathname === "/sse") {
      const id = crypto.randomUUID();
      const transport = new SSEServerTransport("/messages", req);
      transports.set(id, transport);

      transport.onclose = () => {
        transports.delete(id);
      };

      await mcpServer.connect(transport);
      return transport.sseResponse;
    }

    // ── MCP message endpoint (paired with SSE) ──
    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handlePostMessage(req);
        return new Response("ok", { status: 200 });
      }
      return new Response("session not found", { status: 404 });
    }

    // ── REST: health ──
    if (url.pathname === "/health") {
      const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM sessions").get();
      return Response.json({
        ok: true,
        version: "0.1.0",
        sessions: count?.cnt ?? 0,
        connections: transports.size,
        uptime: process.uptime(),
      });
    }

    // ── REST: all sessions status ──
    if (url.pathname === "/api/status") {
      const sessions = db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all();
      return Response.json({ ok: true, sessions, connections: transports.size });
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

    return new Response("Commander MCP Server v0.1.0\n\nEndpoints:\n  GET  /sse          - MCP SSE (for Claude Code / Codex)\n  GET  /health       - Health check\n  GET  /api/status   - All sessions\n  POST /api/task     - Send task via REST\n  GET  /api/completions - Recent completions\n", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
});

console.log(`
╔══════════════════════════════════════════╗
║   Commander MCP Server v0.1.0            ║
║                                          ║
║   MCP SSE:  http://0.0.0.0:${PORT}/sse     ║
║   REST API: http://0.0.0.0:${PORT}/api     ║
║   Health:   http://0.0.0.0:${PORT}/health   ║
╚══════════════════════════════════════════╝
`);
