import { describe, expect, test } from "bun:test";
import { drainSessionRequests, scheduleSessionRequestDrain, makeSharedServerPageReader } from "./opencode-sessions-bridge.js";

function fakeHub(overrides: Record<string, (args: any) => any> = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    calls,
    callCommHub: async (name: string, args: any) => {
      calls.push({ name, args });
      if (overrides[name]) return overrides[name](args);
      return { ok: true };
    },
  };
}

describe("#4821 daemon 侧 drain", () => {
  test("读成功 ⇒ ack ok + 原始页（投影留给 Hub）；cursor/limit 原样透传", async () => {
    const page = { data: [{ id: "ses_1", projectID: "p" }], cursor: { previous: null, next: "n2" } };
    const hub = fakeHub({ pull_session_requests: () => ({ ok: true, requests: [{ request_id: "ssr_1", cursor: "c0", limit: 7 }] }) });
    const read: any[] = [];
    await drainSessionRequests({
      callCommHub: hub.callCommHub, key: "k1", warn: () => {},
      readPage: async (o) => { read.push(o); return page; },
    });
    expect(read).toEqual([{ cursor: "c0", limit: 7 }]);
    const ack = hub.calls.find(c => c.name === "ack_session_request")!;
    expect(ack.args.ok).toBe(true);
    expect(JSON.parse(ack.args.data_json)).toEqual(page);
  });

  test("🔴 读失败 ⇒ ack ok=false + opencode_unreachable（不装成空列表）", async () => {
    const hub = fakeHub({ pull_session_requests: () => ({ ok: true, requests: [{ request_id: "ssr_2", cursor: null, limit: 50 }] }) });
    const warns: string[] = [];
    await drainSessionRequests({
      callCommHub: hub.callCommHub, key: "k2", warn: (m) => warns.push(m),
      readPage: async () => { throw new Error("opencode_session_bad_shape"); },
    });
    const ack = hub.calls.find(c => c.name === "ack_session_request")!;
    expect(ack.args).toMatchObject({ request_id: "ssr_2", ok: false, error: "opencode_unreachable" });
    expect(warns.join(" ")).toContain("bad_shape");
  });

  test("pull 不可用或空 ⇒ 什么都不做（不发 ack）", async () => {
    for (const resp of [{ ok: false, error: "node_token_required" }, { ok: true, requests: [] }]) {
      const hub = fakeHub({ pull_session_requests: () => resp });
      await drainSessionRequests({ callCommHub: hub.callCommHub, key: "k3", warn: () => {}, readPage: async () => ({ data: [], cursor: null }) });
      expect(hub.calls.filter(c => c.name === "ack_session_request")).toHaveLength(0);
    }
  });

  test("可重入：同一 key 并发调用共用一次 drain", async () => {
    let pulls = 0;
    const hub = fakeHub({ pull_session_requests: () => { pulls++; return { ok: true, requests: [] }; } });
    const deps = { callCommHub: hub.callCommHub, key: "k4", warn: () => {}, readPage: async () => ({ data: [], cursor: null }) };
    const [a, b] = await Promise.all([scheduleSessionRequestDrain(deps), scheduleSessionRequestDrain(deps)]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(pulls).toBe(1);
  });

  test("makeSharedServerPageReader：没有 url/passwordFile ⇒ null（不猜默认 server）", () => {
    expect(makeSharedServerPageReader({ url: undefined, passwordFile: "/x", readFile: () => "p" })).toBeNull();
    expect(makeSharedServerPageReader({ url: "http://127.0.0.1:1", passwordFile: undefined, readFile: () => "p" })).toBeNull();
    const reader = makeSharedServerPageReader({ url: "http://127.0.0.1:1", passwordFile: "/x", readFile: () => "  " });
    expect(reader).not.toBeNull();
    return expect(reader!({ cursor: null, limit: 10 })).rejects.toThrow("opencode_password_missing");
  });
});
