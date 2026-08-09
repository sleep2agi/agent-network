import { appendFileSync } from "node:fs";

const logPath = process.env.MOCK_LOG || "/tmp/test649-hub.log";
const port = Number(process.env.MOCK_PORT || 19149);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let body = null;
    if (req.method === "POST") body = await req.json();
    appendFileSync(logPath, `${JSON.stringify({ method: req.method, path: url.pathname, body })}\n`);
    if (url.pathname !== "/api/auth/tokens") {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (req.method === "POST") {
      return Response.json({ ok: true, token: "utok_test649_redacted", token_id: "tok_created_649" });
    }
    if (req.method === "GET") {
      return Response.json({
        ok: true,
        tokens: [{
          token_id: "tok_listed_649",
          name: "listed-token",
          created_at: "2026-08-09T01:02:03.000Z",
          last_used_at: "2026-08-09T04:05:06.000Z",
        }],
      });
    }
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  },
});

console.log(`READY ${port}`);
