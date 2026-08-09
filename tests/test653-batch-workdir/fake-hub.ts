const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 19178,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/node-token" && request.method === "POST") {
      return Response.json({ ok: true, token: `ntok_test653_${crypto.randomUUID()}` });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  },
});

console.log(`fake-hub=${server.url}`);
