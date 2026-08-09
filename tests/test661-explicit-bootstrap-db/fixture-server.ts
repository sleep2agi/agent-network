const port = Number(process.env.TEST661_PORT || "25661");
const readyFile = process.env.TEST661_READY_FILE;
if (!readyFile) throw new Error("TEST661_READY_FILE is required");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true, version: "test661-fixture" });
    if (path === "/api/auth/login") return Response.json({ ok: false, error: "invalid credentials" });
    if (path === "/api/auth/register") {
      return Response.json({
        ok: true,
        token: "utok_test661_fixture",
        user: { user_id: "user-661", username: "admin" },
      });
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  },
});

await Bun.write(readyFile, String(server.port));

function stop() {
  server.stop(true);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await new Promise(() => {});
