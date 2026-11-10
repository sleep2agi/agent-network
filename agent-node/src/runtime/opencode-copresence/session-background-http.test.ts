import { expect, test } from "bun:test";
import { fetchOpenCodeJson, fetchOpenCodeSessionControlJson } from "./http";
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
      request: (path, init) => fetchOpenCodeSessionControlJson(url, "fixture-only", path, init) });
    const state = await control.state();
    const request = { session_id: state.session_id, binding_id: state.binding_id, request_id: `bg_${Date.now()}_http2014`, expires_at: Date.now() + 15_000 };
    expect((await control.background(request)).outcome).toBe("request_processed");
    await control.background(request);
    expect(calls.filter(call => call.startsWith("POST"))).toEqual(["POST /api/session/ses_Http2014/background"]);
  } finally { await server.stop(true); }
});

for (const status of [307, 308]) {
  test(`#2014 rejects HTTP ${status} peer-session redirects and never replays unknown`, async () => {
    const calls: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (path === "/openapi.json") return Response.json({ paths: { "/api/session/{sessionID}/background": { post: { operationId: "session.background" } } } });
      if (path === "/api/session/ses_Http2014") return Response.json({ data: { id: "ses_Http2014", location: { directory: "/fixture" } } });
      if (path === "/api/session/active") return Response.json({ data: { ses_Http2014: { type: "running" } } });
      if (path === "/api/session/ses_Http2014/background") return new Response(null, { status, headers: { location: "/api/session/ses_Peer2014/background" } });
      return new Response(null, { status: 204 });
    } });
    try {
      const control = createSessionBackgroundControl({ sessionId: "ses_Http2014", directory: "/fixture", isCurrent: () => true,
        request: (path, init) => fetchOpenCodeSessionControlJson(`http://127.0.0.1:${server.port}`, "fixture-only", path, init) });
      const state = await control.state();
      const request = { session_id: state.session_id, binding_id: state.binding_id, request_id: `bg_${Date.now()}_redirect${status}`, expires_at: Date.now() + 15_000 };
      await expect(control.background(request)).rejects.toThrow("session_background_outcome_unknown");
      await expect(control.background(request)).rejects.toThrow("session_background_outcome_unknown");
      expect(calls.filter(call => call.startsWith("POST"))).toEqual(["POST /api/session/ses_Http2014/background"]);
    } finally { await server.stop(true); }
  });
}

test("#2014 control HTTP cancellation is not overwritten by the generic helper deadline", async () => {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    entered(); await released; return new Response(null, { status: 204 });
  } });
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = fetchOpenCodeSessionControlJson(`http://127.0.0.1:${server.port}`, "fixture-only", "/api/session/ses_Http2014/background", {
      method: "POST", signal: abort.signal,
    }).then(() => "processed", () => "cancelled");
    await reached; abort.abort();
    const delayed = new Promise<string>(resolve => { timer = setTimeout(() => resolve("caller signal was ignored"), 500); });
    expect(await Promise.race([result, delayed])).toBe("cancelled");
  } finally { clearTimeout(timer); release(); await server.stop(true); }
});
