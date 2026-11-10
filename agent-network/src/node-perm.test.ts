import { describe, expect, it } from "bun:test";
import { applyListEdit, formatNodePerm, parseNodePermArgs, runNodePerm, stateFromNodeRow } from "./node-perm";

// 假 Hub:只认 node-perm 用到的四条路由,记下每次写的 body,行为照 server.ts 的同名路由(含 [] 拒收)。
function fakeHub(initial: Record<string, any>, opts: { inboxSupported?: boolean; putStatus?: number } = {}) {
  const row: Record<string, any> = { ...initial };
  if (opts.inboxSupported === false) delete row.inbox_allowlist;
  const puts: Array<{ path: string; body: any }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (method === "GET" && u.pathname === "/api/nodes") {
      const byId = u.searchParams.get("node_id"), byAlias = u.searchParams.get("alias");
      const hit = (byId && byId === row.node_id) || (byAlias && byAlias === row.alias);
      return json(200, { nodes: hit ? [row] : [] });
    }
    const m = /^\/api\/nodes\/([^/]+)\/(permission-mode|peer-allowlist|inbox-allowlist)$/.exec(u.pathname);
    if (method === "PUT" && m) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      puts.push({ path: m[2]!, body });
      if (opts.putStatus) return json(opts.putStatus, { ok: false, error: "permission_denied" });
      if (m[2] === "inbox-allowlist" && opts.inboxSupported === false) return json(404, { error: "not found" });
      const key = m[2] === "permission-mode" ? "mode" : m[2] === "peer-allowlist" ? "peers" : "senders";
      const v = body[key];
      if (Array.isArray(v) && v.length === 0) return json(400, { ok: false, error: "empty_allowlist_ambiguous" });
      if (m[2] === "permission-mode") row.permission_mode = v;
      else row[m[2] === "peer-allowlist" ? "peer_allowlist" : "inbox_allowlist"] = v ?? null;
      return json(200, { ok: true, node_id: row.node_id, [key]: v ?? null });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { row, puts, ctx: { hub: "http://hub.test", token: "utok_x", fetchImpl } };
}
const base = { node_id: "n_abc", alias: "reviewer", network_id: "net_1", permission_mode: "normal", peer_allowlist: null, inbox_allowlist: null, tool_allowlist: null, rest_allowlist: null };
const parse = (argv: string[]) => {
  const r = parseNodePermArgs(argv);
  if (!r.ok) throw new Error(r.error);
  return r.args;
};

describe("parseNodePermArgs", () => {
  it("node + flags; comma lists; none clears; --x=y form", () => {
    expect(parse(["reviewer", "--inbox", "planner, user:alice", "--peers=none", "--mode", "readonly", "--json"])).toEqual({
      ref: "reviewer", json: true, mode: "readonly", inbox: { set: ["planner", "user:alice"] }, peers: { set: null },
    });
    expect(parse(["reviewer", "--inbox-add", "user:bob", "--inbox-remove", "planner"]).inbox).toEqual({ add: ["user:bob"], remove: ["planner"] });
  });
  it("rejects: missing node, bad mode, unknown flag, set + delta together, empty list", () => {
    for (const argv of [[], ["n", "--mode", "admin"], ["n", "--nope"], ["n", "--inbox", "a", "--inbox-add", "b"], ["n", "--inbox", ","], ["n", "--inbox"]]) {
      expect(parseNodePermArgs(argv).ok).toBe(false);
    }
  });
});

describe("applyListEdit", () => {
  it("add dedups; remove keeps the rest; removing the last entry is refused (never silently opens the node)", () => {
    expect(applyListEdit(["a"], { add: ["a", "b"], remove: [] }, "inbox")).toEqual({ ok: true, next: ["a", "b"] });
    expect(applyListEdit(["a", "b"], { add: [], remove: ["a"] }, "inbox")).toEqual({ ok: true, next: ["b"] });
    const last = applyListEdit(["a"], { add: [], remove: ["a"] }, "inbox");
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.error).toContain("--inbox none");
    expect(applyListEdit(null, { set: null }, "peers")).toEqual({ ok: true, next: null });
  });
});

describe("runNodePerm against a fake Hub", () => {
  it("show only: resolves by alias, no writes", async () => {
    const h = fakeHub(base);
    const r = await runNodePerm(h.ctx, parse(["reviewer"]));
    expect(r.ok).toBe(true);
    expect(h.puts).toEqual([]);
    if (r.ok) expect(r.state).toMatchObject({ node_id: "n_abc", inbox_allowlist: null, peer_allowlist: null });
  });

  it("sets mode + peers + inbox with the Hub's body keys, then re-reads", async () => {
    const h = fakeHub(base);
    const r = await runNodePerm(h.ctx, parse(["n_abc", "--mode", "restricted", "--peers", "planner", "--inbox", "planner,user:alice"]));
    expect(h.puts).toEqual([
      { path: "permission-mode", body: { mode: "restricted" } },
      { path: "peer-allowlist", body: { peers: ["planner"] } },
      { path: "inbox-allowlist", body: { senders: ["planner", "user:alice"] } },
    ]);
    expect(r.ok && r.changed).toEqual(["mode", "peers", "inbox"]);
    if (r.ok) expect(r.state.inbox_allowlist).toEqual(["planner", "user:alice"]);
  });

  it("--inbox none sends null; --inbox-add merges with the current list", async () => {
    const h = fakeHub({ ...base, inbox_allowlist: ["planner"] });
    await runNodePerm(h.ctx, parse(["reviewer", "--inbox-add", "user:bob"]));
    expect(h.puts.at(-1)).toEqual({ path: "inbox-allowlist", body: { senders: ["planner", "user:bob"] } });
    await runNodePerm(h.ctx, parse(["reviewer", "--inbox", "none"]));
    expect(h.puts.at(-1)).toEqual({ path: "inbox-allowlist", body: { senders: null } });
  });

  it("same mode is not re-sent", async () => {
    const h = fakeHub(base);
    const r = await runNodePerm(h.ctx, parse(["reviewer", "--mode", "normal"]));
    expect(h.puts).toEqual([]);
    expect(r.ok && r.changed).toEqual([]);
  });

  it("old Hub (no inbox_allowlist field): show says so, set refuses before any write", async () => {
    const h = fakeHub(base, { inboxSupported: false });
    const show = await runNodePerm(h.ctx, parse(["reviewer"]));
    expect(show.ok && show.state.inbox_allowlist).toBeUndefined();
    if (show.ok) expect(formatNodePerm(show.state).join("\n")).toContain("does not support inbox allowlists");
    const set = await runNodePerm(h.ctx, parse(["reviewer", "--mode", "readonly", "--inbox", "x"]));
    expect(set.ok).toBe(false);
    expect(h.puts).toEqual([]);
  });

  it("403 from the Hub is reported with who can change it", async () => {
    const h = fakeHub(base, { putStatus: 403 });
    const r = await runNodePerm(h.ctx, parse(["reviewer", "--inbox", "x"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("owner");
  });

  it("unknown node → clear error, no writes", async () => {
    const h = fakeHub(base);
    const r = await runNodePerm(h.ctx, parse(["ghost", "--inbox", "x"]));
    expect(r.ok).toBe(false);
    expect(h.puts).toEqual([]);
  });
});

describe("stateFromNodeRow / formatNodePerm", () => {
  it("null and [] both read as unrestricted", () => {
    const s = stateFromNodeRow({ ...base, peer_allowlist: [], inbox_allowlist: ["a"] });
    expect(s.peer_allowlist).toBeNull();
    const text = formatNodePerm(s).join("\n");
    expect(text).toContain("peers:    (any — not restricted)");
    expect(text).toContain("inbox:    a");
  });
});
