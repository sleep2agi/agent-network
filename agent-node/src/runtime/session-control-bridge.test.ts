import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createNodeSessionControlBridge, createSessionControlPin } from "./session-control-bridge";
import { SessionBackgroundError, type SessionControlPermit } from "./opencode-copresence/session-background";

function harness(mode = "ready") {
  const id = `bg_${Date.now()}_bridge2014`, calls: Array<{ path: string; body: any }> = [], warnings: string[] = [];
  let writes = 0, claimed = false, revoked = false, registrations = 0;
  const abort = new AbortController();
  const revoke = () => { revoked = true; abort.abort(); };
  const checkpoint = () => { if (revoked) throw new SessionBackgroundError("session_control_changed"); };
  const state = { session_id: "ses_Bridge2014", binding_id: "generation2014", supported: true, active: true, can_request_background: true, observed_at: Date.now() };
  const session = { isRunning: true, sessionId: state.session_id, backgroundControl: {
    state: async () => state,
    background: async (_intent: unknown, permit?: SessionControlPermit) => {
      expect(permit).toBeDefined(); permit!.checkpoint();
      writes++; return { outcome: "request_processed" as const, state };
    },
  } };
  let live: typeof session | null = session;
  const post = async (path: string, body: unknown) => {
    calls.push({ path, body });
    if (path.endsWith("/pull")) {
      if (claimed) return { ok: true, request: null };
      claimed = true;
      if (mode === "changed") live = null;
      if (mode === "revoked-pull") revoke();
      return { ok: true, request: { request_id: id, operation: mode === "bad-op" ? "keys" : "background",
        session_id: mode === "wrong-session" ? "ses_Peer2014" : state.session_id, binding_id: state.binding_id,
        expires_at: mode === "expired" ? Date.now() - 1 : Date.now() + 15_000 } };
    }
    if (path.endsWith("/ack") && mode === "ack-lost") throw Error("private ACK failure");
    if (path.endsWith("/bridge")) registrations++;
    return { ok: true, ...(mode === "old-hub" ? {} : { identity: {
      node_id: mode === "wrong-node" ? "n_peer" : "n_local",
      network_id: mode === "wrong-network" ? "net_peer" : "net_local", token_id: mode === "changed-token-id" && registrations > 1 ? "tok_other" : "tok_initial",
    } }) };
  };
  const identity = { expected: { node_id: "n_local", network_id: "net_local" }, signal: abort.signal, checkpoint, invalidate: revoke, post };
  const bridge = createNodeSessionControlBridge({ session: () => live, warn: (m: string) => warnings.push(m), identity });
  return { bridge, calls, warnings, revoke, get writes() { return writes; } };
}
test("#2014 bridge registers bound identity, drains without model queue, singleflights doorbells", async () => {
  const h = harness(); await h.bridge.register();
  await Promise.all([h.bridge.trigger(), h.bridge.trigger(), h.bridge.trigger()]);
  expect(h.writes).toBe(1);
  expect(h.calls[0]).toEqual({ path: "/api/node-session-control/bridge", body: { session_id: "ses_Bridge2014", binding_id: "generation2014", expected: { node_id: "n_local", network_id: "net_local" } } });
  expect(h.calls.filter(c => c.path.endsWith("/ack"))[0].body).toMatchObject({ status: "done", result: { outcome: "request_processed" } });
});
for (const mode of ["changed", "wrong-session", "expired", "bad-op"]) test(`#2014 bridge ${mode} refuses without runtime write`, async () => {
  const h = harness(mode); await h.bridge.register(); await h.bridge.trigger(); expect(h.writes).toBe(0);
  expect(h.calls.find(c => c.path.endsWith("/ack"))?.body.status).toBe(mode === "changed" ? undefined : "failed");
});
test("#2014 lost ACK is not a reason to replay the operation", async () => {
  const h = harness("ack-lost"); await h.bridge.register(); await h.bridge.trigger(); await h.bridge.trigger();
  expect(h.writes).toBe(1); expect(h.warnings).toEqual(["[session-control] transport unavailable; operation was not replayed"]);
});

for (const mode of ["old-hub", "wrong-node", "wrong-network"]) test(`#2014 authority reply ${mode} never enables claims`, async () => {
  const h = harness(mode);
  expect(await h.bridge.register()).toBe(false);
  await h.bridge.trigger();
  expect(h.writes).toBe(0);
  expect(h.calls.some(c => c.path.endsWith("/pull"))).toBe(false);
});
test("#2014 no pre-registration authority means no claim or runtime action", async () => {
  const h = harness(); await h.bridge.trigger(); expect(h.calls).toEqual([]); expect(h.writes).toBe(0);
});
test("#2014 revocation while claim is in flight forbids runtime action and success ACK", async () => {
  const h = harness("revoked-pull"); await h.bridge.register(); await h.bridge.trigger();
  expect(h.writes).toBe(0); expect(h.calls.some(c => c.path.endsWith("/ack"))).toBe(false);
});
test("#2014 a later token_id cannot replace the first authoritative pin", async () => {
  const h = harness("changed-token-id"); expect(await h.bridge.register()).toBe(true);
  expect(await h.bridge.register()).toBe(false); await h.bridge.trigger(); expect(h.writes).toBe(0);
});
test("#2014 startup token/Hub stay pinned; epoch revocation cannot revive A to B to A", async () => {
  let token = "ntok_initial_fixture", epoch = 0;
  const lifetime = new AbortController(), calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
  const pin = createSessionControlPin({ hubUrl: "http://127.0.0.1:9200/", token, nodeId: "n_local", networkId: "net_local", epoch,
    currentToken: () => token, currentEpoch: () => epoch, signal: lifetime.signal,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, authorization: new Headers(init.headers).get("authorization"), redirect: init.redirect });
      return Response.json({ ok: true });
    }) as typeof fetch });
  await pin.post("/api/node-session-control/bridge", {});
  expect(calls).toEqual([{ url: "http://127.0.0.1:9200/api/node-session-control/bridge", authorization: "Bearer ntok_initial_fixture", redirect: "error" }]);
  epoch++; lifetime.abort(); token = "ntok_other_fixture";
  await expect(pin.post("/api/node-session-control/pull", {})).rejects.toThrow("session_control_changed");
  token = "ntok_initial_fixture"; epoch++;
  await expect(pin.post("/api/node-session-control/pull", {})).rejects.toThrow("session_control_changed");
  expect(pin.signal.aborted).toBe(true); expect(calls).toHaveLength(1);
});
test("#2014 authority is checked after the Hub response body, not just before fetch", async () => {
  const lifetime = new AbortController(); let epoch = 0;
  const pin = createSessionControlPin({ hubUrl: "http://127.0.0.1:9200", token: "ntok_initial_fixture", nodeId: "n_local", networkId: "net_local", epoch,
    currentToken: () => "ntok_initial_fixture", currentEpoch: () => epoch, signal: lifetime.signal,
    fetch: (async () => ({ ok: true, json: async () => { epoch++; lifetime.abort(); return { ok: true }; } })) as any });
  await expect(pin.post("/api/node-session-control/bridge", {})).rejects.toThrow("session_control_changed");
  expect(pin.signal.aborted).toBe(true);
});
test("#2014 CLI revokes the initial epoch before publishing a hot token; lane uses the pin", () => {
  const source = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  const reload = source.slice(source.indexOf("function reloadNodeToken()"), source.indexOf("const NODE_DIR ="));
  expect(reload.indexOf("sessionControlCredentialEpoch++")).toBeGreaterThan(0);
  expect(reload.indexOf("sessionControlCredentialEpoch++")).toBeLessThan(reload.indexOf("AUTH_TOKEN = freshToken"));
  expect(reload.indexOf("sessionControlCredentialAbort.abort()")).toBeLessThan(reload.indexOf("AUTH_TOKEN = freshToken"));
  const lane = source.slice(source.indexOf("const sessionControlPin ="), source.indexOf("const OPENCODE_MODEL_POLL_MS"));
  expect(lane).toContain("token: SESSION_CONTROL_START_TOKEN");
  expect(lane).toContain("nodeId: NODE_ID, networkId: NETWORK_ID, epoch: 0");
  expect(lane).toContain("identity: sessionControlPin");
  expect(lane).not.toContain("fetch(");
});
