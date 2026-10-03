import { describe, expect, it } from "bun:test";
import { describeHubRemoval, hubRetryCommand, removeNodeFromHub } from "./node-delete-hub";

// #516 — node delete's Hub half. The Docker suite (tests/test516-node-delete-hub-row)
// runs the real CLI against a real Hub; this file pins the decision table with a fake fetch.

type Row = { node_id: string; alias: string };

function fakeHub(rows: Row[], opts: { deleteStatus?: number; listStatus?: number; deletedId?: string } = {}) {
  const calls: { method: string; url: string }[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname + url.search });
    if (method === "GET" && url.pathname === "/api/nodes") {
      if (opts.listStatus) return Response.json({ ok: false, error: "nope" }, { status: opts.listStatus });
      const id = url.searchParams.get("node_id");
      const alias = url.searchParams.get("alias");
      const nodes = rows.filter((r) => (id ? r.node_id === id : true) && (alias ? r.alias === alias : true));
      return Response.json({ ok: true, nodes, count: nodes.length });
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/nodes/")) {
      if (opts.deleteStatus) return Response.json({ ok: false, error: "permission_denied" }, { status: opts.deleteStatus });
      const ref = decodeURIComponent(url.pathname.slice("/api/nodes/".length));
      const i = rows.findIndex((r) => r.node_id === ref || r.alias === ref);
      if (i < 0) return Response.json({ ok: false, error: "node not found" }, { status: 404 });
      const [row] = rows.splice(i, 1);
      return Response.json({ ok: true, deleted: true, node_id: opts.deletedId ?? row!.node_id, alias: row!.alias });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls, rows };
}

describe("removeNodeFromHub", () => {
  it("deletes the row whose node_id matches, by node_id", async () => {
    const hub = fakeHub([{ node_id: "n_mine", alias: "a1" }, { node_id: "n_other", alias: "a1" }]);
    const r = await removeNodeFromHub({ hub: "http://h", token: "t", nodeId: "n_mine", alias: "a1", fetchImpl: hub.impl });
    expect(r).toEqual({ kind: "removed", nodeId: "n_mine" });
    expect(hub.rows).toEqual([{ node_id: "n_other", alias: "a1" }]);
    expect(hub.calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", url: "/api/nodes/n_mine" }]);
  });

  it("never deletes a row that only shares the alias (alias reuse)", async () => {
    const hub = fakeHub([{ node_id: "n_other", alias: "a1" }]);
    const r = await removeNodeFromHub({ hub: "http://h", token: "t", nodeId: "n_mine", alias: "a1", fetchImpl: hub.impl });
    expect(r).toEqual({ kind: "absent", nodeId: "n_mine", otherRows: ["n_other"] });
    expect(hub.rows.length).toBe(1);
    expect(hub.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("ignores a server that returns rows for a different node_id", async () => {
    // A Hub that ignored the ?node_id= filter must not make us delete the wrong row.
    const rows = [{ node_id: "n_other", alias: "a1" }];
    const impl = (async (input: any, init?: any) => {
      if ((init?.method ?? "GET") === "GET") return Response.json({ ok: true, nodes: rows });
      throw new Error("must not DELETE");
    }) as typeof fetch;
    const r = await removeNodeFromHub({ hub: "http://h", token: "t", nodeId: "n_mine", alias: "a1", fetchImpl: impl });
    expect(r.kind).toBe("absent");
  });

  it("unreachable hub → failed with the reason", async () => {
    const impl = (async () => { throw new TypeError("fetch failed: ECONNREFUSED"); }) as typeof fetch;
    const r = await removeNodeFromHub({ hub: "http://127.0.0.1:1", token: "t", nodeId: "n_mine", fetchImpl: impl });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("could not reach http://127.0.0.1:1");
  });

  it("HTTP errors → failed (401 says log in, 403 says refused)", async () => {
    const r401 = await removeNodeFromHub({ hub: "http://h", nodeId: "n", fetchImpl: fakeHub([], { listStatus: 401 }).impl });
    expect(r401.kind === "failed" && r401.reason).toContain("anet login");
    const r403 = await removeNodeFromHub({ hub: "http://h", nodeId: "n", fetchImpl: fakeHub([{ node_id: "n", alias: "a" }], { deleteStatus: 403 }).impl });
    expect(r403.kind === "failed" && r403.reason).toContain("HTTP 403");
  });

  it("a Hub that reports deleting another node_id is a failure", async () => {
    const hub = fakeHub([{ node_id: "n_mine", alias: "a1" }], { deletedId: "n_other" });
    const r = await removeNodeFromHub({ hub: "http://h", nodeId: "n_mine", fetchImpl: hub.impl });
    expect(r.kind).toBe("failed");
  });

  it("no hub / no node_id → skipped, nothing called", async () => {
    const hub = fakeHub([]);
    expect(await removeNodeFromHub({ hub: "", nodeId: "n", fetchImpl: hub.impl })).toEqual({ kind: "skipped", reason: "no-hub" });
    expect(await removeNodeFromHub({ hub: "http://h", nodeId: "", fetchImpl: hub.impl })).toEqual({ kind: "skipped", reason: "no-node-id" });
    expect(hub.calls).toEqual([]);
  });
});

describe("messages", () => {
  it("failure prints the exact retry command on stderr", () => {
    const out = describeHubRemoval({ kind: "failed", nodeId: "n_abc", reason: "could not reach http://h" }, { displayName: "a1" });
    expect(out.info).toEqual([]);
    expect(out.warn.join("\n")).toContain("anet node delete n_abc --hub-only");
  });
  it("retry command quotes odd values and carries a non-default hub", () => {
    expect(hubRetryCommand("n_abc")).toBe("anet node delete n_abc --hub-only");
    expect(hubRetryCommand("n abc", "http://h:1")).toBe("anet node delete 'n abc' --hub-only --hub http://h:1");
  });
  it("alias reuse is reported as left untouched", () => {
    const out = describeHubRemoval({ kind: "absent", nodeId: "n_mine", otherRows: ["n_other"] }, { displayName: "a1" });
    expect(out.info.join("\n")).toContain("Left untouched");
    expect(out.warn).toEqual([]);
  });
});
