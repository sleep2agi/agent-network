import { appendFileSync } from "node:fs";

const logPath = process.env.MOCK_LOG;
if (!logPath) throw new Error("MOCK_LOG is required");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 19151,
  async fetch(req) {
    const url = new URL(req.url);
    appendFileSync(logPath, `${JSON.stringify({
      method: req.method,
      path: url.pathname,
      authorization: req.headers.get("authorization"),
    })}\n`);
    if (url.pathname === "/health") {
      return Response.json({ version: "test651", sessions_count: 2, sse_connections: 1 });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`READY ${server.port}`);
