const port = Number(process.env.PORT || "27668");
const capture = process.env.TEST766_CAPTURE;
if (!capture) throw new Error("TEST766_CAPTURE is required");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({ ok: true, version: "test766-bunx" });
    }
    if (path === "/api/auth/login") {
      return Response.json({ ok: false, error: "invalid credentials" });
    }
    if (path === "/api/auth/register") {
      return Response.json({
        ok: true,
        token: "utok_test766_fixture",
        user: { user_id: "user-766", username: "admin" },
      });
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  },
});

await Bun.write(`${capture}.pid`, String(process.pid));

function stop() {
  server.stop(true);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await new Promise(() => {});
