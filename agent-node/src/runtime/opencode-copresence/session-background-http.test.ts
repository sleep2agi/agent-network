import { expect, test } from "bun:test";
import { fetchOpenCodeJson } from "./http";
import { createSessionBackgroundControl } from "./session-background";

test("#2014 authenticated HTTP adapter targets only the bound session; no prompt or key injection", async () => {
  const calls: string[] = [];
  const authorization = `Basic ${Buffer.from("opencode:fixture-only").toString("base64")}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.headers.get("authorization") !== authorization) return new Response(null, { status: 401 });
    calls.push(`${req.method} ${path}`);
    if (path === "/openapi.json") return Response.json({ paths: { "/api/session/{sessionID}/background": { post: { operationId: "session.background" } } } });
    if (path === "/api/session/ses_Http2014") return Response.json({ data: { id: "ses_Http2014", location: { directory: "/fixture" } } });
    if (path === "/api/session/active") return Response.json({ data: { ses_Http2014: { type: "running" }, ses_Peer2014: { type: "running" } } });
    if (req.method === "POST" && path === "/api/session/ses_Http2014/background") return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  } });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    await expect(fetchOpenCodeJson(url, "wrong", "/openapi.json")).rejects.toThrow("HTTP 401");
    const control = createSessionBackgroundControl({ sessionId: "ses_Http2014", directory: "/fixture", isCurrent: () => true,
      request: (path, init) => fetchOpenCodeJson(url, "fixture-only", path, init) });
    const state = await control.state();
    const request = { session_id: state.session_id, binding_id: state.binding_id, request_id: `bg_${Date.now()}_http2014`, expires_at: Date.now() + 15_000 };
    expect((await control.background(request)).outcome).toBe("request_processed");
    await control.background(request);
    expect(calls.filter(call => call.startsWith("POST"))).toEqual(["POST /api/session/ses_Http2014/background"]);
  } finally { await server.stop(true); }
});
