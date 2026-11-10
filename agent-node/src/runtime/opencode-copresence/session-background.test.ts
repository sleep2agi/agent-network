import { describe, expect, test } from "bun:test";
import { createSessionBackgroundControl, SessionBackgroundError } from "./session-background";

const sid = "ses_Target2014";
const schema = { paths: { "/api/session/{sessionID}/background": { post: { operationId: "session.background" } } } };
function harness(mode = "ready") {
  const calls: Array<{ path: string; method: string }> = [];
  let current = true, writes = 0;
  const control = createSessionBackgroundControl({ sessionId: sid, directory: "/project", isCurrent: () => current,
    request: async (path, init) => {
      calls.push({ path, method: init?.method || "GET" });
      if (init?.method === "POST") { writes++; if (mode === "unknown") throw Error("private transport failure"); return null; }
      if (path === "/openapi.json") return mode === "unsupported" ? {} : schema;
      if (path === `/api/session/${sid}`) return { data: { id: mode === "wrong-session" ? "ses_Peer" : sid,
        location: { directory: mode === "wrong-directory" ? "/peer" : "/project" } } };
      if (path === "/api/session/active") {
        if (mode === "gone") current = false;
        if (mode === "malformed") return { data: [] };
        return { data: mode === "idle" ? { ses_Peer: { type: "running" } } : { [sid]: { type: "running" }, ses_Peer: { type: "running" } } };
      }
      throw Error("unexpected request");
    } });
  return { control, calls, stop: () => { current = false; }, get writes() { return writes; } };
}
async function intent(h: ReturnType<typeof harness>, id = `bg_${Date.now()}_request2014`) {
  const s = await h.control.state();
  return { session_id: s.session_id, binding_id: s.binding_id, request_id: id, expires_at: Date.now() + 15_000 };
}

describe("#2014 bound semantic Ctrl+B", () => {
  test("active target + real API capability, not peer busy alone", async () => {
    const h = harness(); expect(await h.control.state()).toMatchObject({ session_id: sid, supported: true, active: true, can_request_background: true });
    expect(await harness("idle").control.state()).toMatchObject({ active: false, can_request_background: false });
    expect(await harness("unsupported").control.state()).toMatchObject({ supported: false, active: true, can_request_background: false });
  });
  test("one fixed-session POST, 204 is request processed, not claimed success", async () => {
    const h = harness(), i = await intent(h);
    const r = await h.control.background(i);
    expect(r.outcome).toBe("request_processed"); expect(r.state.active).toBe(true);
    expect(h.calls.filter(c => c.method === "POST")).toEqual([{ method: "POST", path: `/api/session/${sid}/background` }]);
    expect(await h.control.background(i)).toBe(r); expect(h.writes).toBe(1);
  });
  test("unknown write remains unknown on duplicate, never replay", async () => {
    const h = harness("unknown"), i = await intent(h);
    for (let n = 0; n < 2; n++) await expect(h.control.background(i)).rejects.toMatchObject({ code: "session_background_outcome_unknown" });
    expect(h.writes).toBe(1);
  });
  test("idle is truthful no-op, no write", async () => {
    const h = harness("idle"); expect((await h.control.background(await intent(h))).outcome).toBe("already_idle"); expect(h.writes).toBe(0);
  });
  test("unsupported API never falls back to keys, prompt or abort", async () => {
    const h = harness("unsupported"); await expect(h.control.background(await intent(h))).rejects.toMatchObject({ code: "session_control_unsupported" }); expect(h.writes).toBe(0);
  });
  for (const mode of ["wrong-session", "wrong-directory", "malformed", "gone"]) test(`${mode} fails closed`, async () => {
    const h = harness(mode); await expect(h.control.state()).rejects.toBeInstanceOf(SessionBackgroundError); expect(h.writes).toBe(0);
  });
  test("stale generation / foreign session / closed handle refused", async () => {
    const h = harness(), i = await intent(h);
    for (const changed of [{ ...i, session_id: "ses_Peer" }, { ...i, binding_id: "other-generation" }]) {
      expect(() => h.control.background(changed)).toThrow("session_control_changed");
    }
    h.stop(); expect(() => h.control.background(i)).toThrow("session_control_changed"); expect(h.writes).toBe(0);
  });
  test("private error text is never projected", async () => {
    const h = harness("unknown");
    try { await h.control.background(await intent(h)); throw Error("expected rejection"); }
    catch (e) { expect(String(e)).toBe("Error: session_background_outcome_unknown"); }
  });
  test("expired/future intent never writes even with a valid live binding", async () => {
    const h = harness(), i = await intent(h);
    for (const timestamp of [Date.now() - 180_000, Date.now() + 60_000]) {
      expect(() => h.control.background({ ...i, request_id: `bg_${timestamp}_request2014` })).toThrow("session_control_request_expired");
    }
    expect(h.writes).toBe(0);
  });
  test("deadline expiring during preflight reads forbids the write", async () => {
    const start = Date.now(); let clock = start, writes = 0;
    const control = createSessionBackgroundControl({ sessionId: sid, directory: "/project", isCurrent: () => true, now: () => clock,
      request: async (path, init) => {
        if (init?.method === "POST") { writes++; return null; }
        if (path === "/openapi.json") return schema;
        if (path === `/api/session/${sid}`) return { data: { id: sid, location: { directory: "/project" } } };
        clock += 16_000; return { data: { [sid]: { type: "running" } } };
      } });
    const state = await control.state(); clock = start;
    await expect(control.background({ session_id: sid, binding_id: state.binding_id,
      request_id: `bg_${start}_deadline2014`, expires_at: start + 15_000 })).rejects.toMatchObject({ code: "session_control_request_expired" });
    expect(writes).toBe(0);
  });
});

for (const revokeAt of ["preflight", "post"]) test(`#2014 local permit revoked at ${revokeAt} never returns success or replays`, async () => {
  const abort = new AbortController();
  let armed = false, writes = 0;
  const checkpoint = () => { if (abort.signal.aborted) throw new SessionBackgroundError("session_control_changed"); };
  const control = createSessionBackgroundControl({ sessionId: sid, directory: "/project", isCurrent: () => true,
    request: async (path, init) => {
      if (init?.method === "POST") { writes++; if (armed && revokeAt === "post") abort.abort(); return null; }
      if (path === "/openapi.json") return schema;
      if (path === `/api/session/${sid}`) return { data: { id: sid, location: { directory: "/project" } } };
      if (armed && revokeAt === "preflight") abort.abort();
      return { data: { [sid]: { type: "running" } } };
    } });
  const state = await control.state(); armed = true;
  const request = { session_id: sid, binding_id: state.binding_id, request_id: `bg_${Date.now()}_permit${revokeAt}`, expires_at: Date.now() + 15_000 };
  const permit = { checkpoint, signal: abort.signal };
  const expected = revokeAt === "post" ? "session_background_outcome_unknown" : "session_control_changed";
  for (let i = 0; i < 2; i++) await expect(control.background(request, permit)).rejects.toMatchObject({ code: expected });
  expect(writes).toBe(revokeAt === "post" ? 1 : 0);
});
