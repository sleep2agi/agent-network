// POST /mcp in /api/stats/routes carries the JSON-RPC method and, for tools/call, the tool name
// ("POST /mcp tools/call report_status"). Production showed POST /mcp as the biggest route (15 req/s,
// ~13% of a core) with no way to tell which tool. This suite pins, over real HTTP:
//   - the labels (tools/call <name>, tools/list, batch) and that MCP responses are unchanged in kind;
//   - arguments never reach the stats (a marker in arguments / a hostile tool name never shows up);
//   - odd bodies still get the transport's own answers (invalid JSON → -32700, oversized → parsed by
//     the transport itself) and are labelled "?";
//   - unauthenticated /mcp stays plain "POST /mcp" (the body is never read before auth).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-mcp-route-label-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");

const PW = "McpRouteLabelPassw0rd!";
const MARKER = "zz-argument-marker-7f3a";
let BASE = "";
let hub: any = null;
let admin = "";

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" };
async function mcpRaw(token: string, body: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...MCP_HEADERS }, body });
  return { status: res.status, text: await res.text() };
}
function rpc(text: string): any {
  const lines = text.split("\n").filter(x => x.startsWith("data:"));
  return lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(text);
}
async function routes(): Promise<{ text: string; keys: string[]; rows: any[] }> {
  const res = await fetch(`${BASE}/api/stats/routes?minutes=5`, { headers: { Authorization: `Bearer ${admin}` } });
  const text = await res.text();
  const rows = JSON.parse(text).routes as any[];
  return { text, keys: rows.map(r => r.route), rows };
}

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const { register } = await import("./auth.js");
  const { db } = await import("./db.js");
  const a = register(`mrl_admin_${Date.now()}`, PW);
  admin = a.token!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [a.user!.user_id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("POST /mcp route label", () => {
  test("tools/call is labelled with the tool name and still answers normally", async () => {
    const r = await mcpRaw(admin, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_all_status", arguments: { note: MARKER } } }));
    expect(r.status).toBe(200);
    expect(rpc(r.text).result).toBeDefined();
    const { keys } = await routes();
    expect(keys).toContain("POST /mcp tools/call get_all_status");
  });

  test("tools/list and a batch get their own labels", async () => {
    const list = await mcpRaw(admin, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(list.status).toBe(200);
    expect(rpc(list.text).result.tools.length).toBeGreaterThan(10);
    await mcpRaw(admin, JSON.stringify([{ jsonrpc: "2.0", id: 3, method: "tools/list" }]));
    const { keys } = await routes();
    expect(keys).toContain("POST /mcp tools/list");
    expect(keys).toContain("POST /mcp batch");
  });

  test("arguments and hostile tool names never reach the stats", async () => {
    await mcpRaw(admin, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: `x ${MARKER}`, arguments: { a: MARKER } } }));
    await mcpRaw(admin, JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "n".repeat(500), arguments: {} } }));
    await mcpRaw(admin, JSON.stringify({ jsonrpc: "2.0", id: 6, method: `tools/${MARKER} with spaces` }));
    const { text, keys } = await routes();
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain("n".repeat(65));
    expect(keys).toContain("POST /mcp tools/call ?");
    expect(keys).toContain("POST /mcp ?");
    for (const k of keys) expect(k.length).toBeLessThan(200);
  });

  test("invalid JSON still gets the transport's parse error, labelled ?", async () => {
    const r = await mcpRaw(admin, `{"jsonrpc":"2.0","method":"tools/list",`);
    expect(r.status).toBe(400);
    expect(rpc(r.text).error.code).toBe(-32700);
    expect(rpc(r.text).error.message).toBe("Parse error: Invalid JSON");
    const notRpc = await mcpRaw(admin, "null");
    expect(notRpc.status).toBe(400);
    expect(rpc(notRpc.text).error.code).toBe(-32700);
  });

  test("a body over the label limit is left to the transport and still works, labelled ?", async () => {
    const { __resetRouteTimingForTest } = await import("./route-timing.js");
    __resetRouteTimingForTest();
    const padded = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }).replace("{", "{" + " ".repeat(1024 * 1024 + 10));
    const r = await mcpRaw(admin, padded);
    expect(r.status).toBe(200);
    expect(rpc(r.text).result.tools.length).toBeGreaterThan(10);
    const { keys } = await routes();
    expect(keys).toContain("POST /mcp ?");
    expect(keys).not.toContain("POST /mcp tools/list");
  });

  test("unauthenticated /mcp is refused as before and not labelled", async () => {
    const { __resetRouteTimingForTest } = await import("./route-timing.js");
    __resetRouteTimingForTest();
    const r = await mcpRaw("", JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }));
    expect(r.status).toBe(401);
    const { keys } = await routes();
    expect(keys).toContain("POST /mcp");
    expect(keys.filter(k => k.startsWith("POST /mcp "))).toEqual([]);
  });
});
