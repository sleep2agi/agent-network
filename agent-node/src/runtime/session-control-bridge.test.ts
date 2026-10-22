import { expect, test } from "bun:test";
import { createNodeSessionControlBridge } from "./session-control-bridge";

function harness(mode = "ready") {
  const id = `bg_${Date.now()}_bridge2014`, calls: Array<{ path: string; body: any }> = [], warnings: string[] = [];
  let writes = 0, claimed = false;
  const state = { session_id: "ses_Bridge2014", binding_id: "generation2014", supported: true, active: true, can_request_background: true, observed_at: Date.now() };
  const session = { isRunning: true, sessionId: state.session_id, backgroundControl: {
    state: async () => state,
    background: async () => { writes++; return { outcome: "request_processed" as const, state }; },
  } };
  let live: typeof session | null = session;
  const bridge = createNodeSessionControlBridge({ session: () => live, warn: m => warnings.push(m), post: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/pull")) {
      if (claimed) return { ok: true, request: null };
      claimed = true;
      if (mode === "changed") live = null;
      return { ok: true, request: { request_id: id, operation: mode === "bad-op" ? "keys" : "background",
        session_id: mode === "wrong-session" ? "ses_Peer2014" : state.session_id, binding_id: state.binding_id,
        expires_at: mode === "expired" ? Date.now() - 1 : Date.now() + 15_000 } };
    }
    if (path.endsWith("/ack") && mode === "ack-lost") throw Error("private ACK failure");
    return { ok: true };
  } });
  return { bridge, calls, warnings, get writes() { return writes; } };
}
test("#2014 bridge registers bound identity, drains without model queue, singleflights doorbells", async () => {
  const h = harness(); await h.bridge.register();
  await Promise.all([h.bridge.trigger(), h.bridge.trigger(), h.bridge.trigger()]);
  expect(h.writes).toBe(1);
  expect(h.calls[0]).toEqual({ path: "/api/node-session-control/bridge", body: { session_id: "ses_Bridge2014", binding_id: "generation2014" } });
  expect(h.calls.filter(c => c.path.endsWith("/ack"))[0].body).toMatchObject({ status: "done", result: { outcome: "request_processed" } });
});
for (const mode of ["changed", "wrong-session", "expired", "bad-op"]) test(`#2014 bridge ${mode} refuses without runtime write`, async () => {
  const h = harness(mode); await h.bridge.trigger(); expect(h.writes).toBe(0);
  expect(h.calls.find(c => c.path.endsWith("/ack"))?.body.status).toBe("failed");
});
test("#2014 lost ACK is not a reason to replay the operation", async () => {
  const h = harness("ack-lost"); await h.bridge.trigger(); await h.bridge.trigger();
  expect(h.writes).toBe(1); expect(h.warnings).toEqual(["[session-control] transport unavailable; operation was not replayed"]);
});
