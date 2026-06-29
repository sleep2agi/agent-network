// RFC-025 M2 — loops-http-server tests.
//
// Pins: localhost-only bind, bearer auth no-bypass, JSON-RPC routing
// (initialize / tools/list / tools/call), handler dispatch carries
// safety防线 (cooldown / max / batch-cancel) across HTTP boundary.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GoalStore, newGoal } from "./store";
import { startLoopsHttpServer, type LoopsHttpServerStarted } from "./loops-http-server";
import type { SelfLoopCtx } from "./self-loop-tools";

let dir: string;
let store: GoalStore;
let server: LoopsHttpServerStarted;
let ctx: SelfLoopCtx;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "loops-http-"));
  store = new GoalStore(join(dir, "goals.json"));
  await store.load();
  ctx = {
    store,
    runtime: "codex-sdk",
    defaultTz: "Asia/Shanghai",
    recentCancels: [],
    pendingConfirmTokens: new Set(),
  };
  server = await startLoopsHttpServer({ ctx });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function rpc(method: string, params: any = {}, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token ?? server.token}`;
  return fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("localhost binding (通信龙 hard constraint #1+#2)", () => {
  test("server bound to 127.0.0.1, not 0.0.0.0", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  test("port is reachable", async () => {
    const r = await rpc("initialize");
    expect(r.status).toBe(200);
  });

  test("random port (different runs get different ports)", async () => {
    // Default port 0 = OS picks. Verify we got a real ephemeral.
    expect(server.port).toBeGreaterThan(1024);
    expect(server.port).toBeLessThan(65536);
  });
});

describe("bearer auth no-bypass (通信龙 hard constraint #4)", () => {
  test("missing Authorization header → 401", async () => {
    const r = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(r.status).toBe(401);
    const j: any = await r.json();
    expect(j.error).toBe("unauthorized");
  });

  test("wrong token → 401", async () => {
    const r = await rpc("initialize", {}, "totally-wrong-token");
    expect(r.status).toBe(401);
  });

  test("non-Bearer scheme → 401", async () => {
    const r = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Basic ${server.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(r.status).toBe(401);
  });

  test("correct Bearer → 200", async () => {
    const r = await rpc("initialize");
    expect(r.status).toBe(200);
  });

  test("path other than /mcp → 404", async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/anything`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(r.status).toBe(404);
  });
});

describe("MCP protocol — initialize / tools/list / tools/call", () => {
  test("initialize returns serverInfo + tools capability", async () => {
    const r = await rpc("initialize");
    const j: any = await r.json();
    expect(j.jsonrpc).toBe("2.0");
    expect(j.result.serverInfo.name).toBe("loops");
    expect(j.result.capabilities.tools).toBeDefined();
  });

  test("tools/list returns all 6 self-loop tools", async () => {
    const r = await rpc("tools/list");
    const j: any = await r.json();
    expect(j.result.tools).toHaveLength(6);
    const names = j.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "cancel_my_loop",
      "complete_my_loop",
      "create_my_loop",
      "edit_my_loop",
      "list_my_loops",
      "reschedule_my_loop",
    ]);
  });

  test("tools/list each tool has description + inputSchema", async () => {
    const r = await rpc("tools/list");
    const j: any = await r.json();
    for (const t of j.result.tools) {
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  test("unknown method → JSON-RPC -32601", async () => {
    const r = await rpc("totally/bogus");
    const j: any = await r.json();
    expect(j.error.code).toBe(-32601);
  });

  test("malformed JSON → -32700", async () => {
    const r = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
      body: "{ not json",
    });
    expect(r.status).toBe(400);
    const j: any = await r.json();
    expect(j.error.code).toBe(-32700);
  });
});

describe("tools/call — handler dispatch into parent ctx", () => {
  test("list_my_loops on empty store", async () => {
    const r = await rpc("tools/call", { name: "list_my_loops", arguments: {} });
    const j: any = await r.json();
    expect(j.result.isError).toBe(false);
    const payload = JSON.parse(j.result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.data.total).toBe(0);
  });

  test("create_my_loop with interval string writes to parent goalStore", async () => {
    const r = await rpc("tools/call", {
      name: "create_my_loop",
      arguments: { task: "via http", interval: "5m" },
    });
    const j: any = await r.json();
    expect(j.result.isError).toBe(false);
    // Verify parent goalStore really has it (same ctx, same in-memory map)
    expect((await store.list())).toHaveLength(1);
  });

  test("unknown tool name → JSON-RPC -32601", async () => {
    const r = await rpc("tools/call", { name: "bogus_tool", arguments: {} });
    const j: any = await r.json();
    expect(j.error.code).toBe(-32601);
  });
});

describe("safety防线 cross-HTTP boundary (M2 verification line)", () => {
  // 通信龙 hard verification line: codex 节点上 batch-cancel 真触发
  // confirm-back + cooldown 真挡 — proves the防线 is NOT a per-process
  // no-op in the codex path.

  test("batch-cancel via HTTP triggers confirm-back on 4th call", async () => {
    // Seed 4 active goals
    for (let i = 0; i < 4; i++) {
      await store.upsert(newGoal({ text: `g${i}`, interval_ms: 5 * 60_000, runtime: "codex-sdk" }));
    }
    const goals = await store.list();
    // First 3 cancels succeed (sharing parent's recentCancels via ctx)
    for (let i = 0; i < 3; i++) {
      const r = await rpc("tools/call", {
        name: "cancel_my_loop",
        arguments: { goal_id: goals[i].goal_id },
      });
      const j: any = await r.json();
      const payload = JSON.parse(j.result.content[0].text);
      expect(payload.ok).toBe(true);
    }
    // 4th triggers confirm-back
    const r4 = await rpc("tools/call", {
      name: "cancel_my_loop",
      arguments: { goal_id: goals[3].goal_id },
    });
    const j4: any = await r4.json();
    const payload4 = JSON.parse(j4.result.content[0].text);
    expect(payload4.ok).toBe(false);
    expect(payload4.error).toBe("batch_destructive_confirm_required");
    expect(payload4.confirm_token).toBeTruthy();
    // The 4th goal is NOT cancelled
    expect((await store.get(goals[3].goal_id))!.status).toBe("active");
  });

  test("cooldown via HTTP — edit within 30s of upsert rejected", async () => {
    const g = newGoal({ text: "x", interval_ms: 5 * 60_000, runtime: "codex-sdk" });
    await store.upsert(g);
    // Edit immediately — well within cooldown
    const r = await rpc("tools/call", {
      name: "edit_my_loop",
      arguments: { goal_id: g.goal_id, interval: "10m" },
    });
    const j: any = await r.json();
    const payload = JSON.parse(j.result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("cooldown");
  });

  test("max-active-goals cap honored across HTTP", async () => {
    // Recreate ctx with low cap
    await server.close();
    ctx = { ...ctx, maxActiveGoals: 2 };
    server = await startLoopsHttpServer({ ctx });
    for (let i = 0; i < 2; i++) {
      const r = await rpc("tools/call", {
        name: "create_my_loop",
        arguments: { task: `g${i}`, interval: "5m" },
      });
      const j: any = await r.json();
      const payload = JSON.parse(j.result.content[0].text);
      expect(payload.ok).toBe(true);
    }
    const r3 = await rpc("tools/call", {
      name: "create_my_loop",
      arguments: { task: "g3", interval: "5m" },
    });
    const j3: any = await r3.json();
    const payload3 = JSON.parse(j3.result.content[0].text);
    expect(payload3.ok).toBe(false);
    expect(payload3.error).toBe("max_active_goals_reached");
  });

  test("preflight invalid timezone rejected via HTTP (M1 #302 round-2 still works)", async () => {
    const r = await rpc("tools/call", {
      name: "create_my_loop",
      arguments: {
        task: "bad tz",
        schedule: { type: "time_of_day", time: "09:00", timezone: "Bad/Zone" },
      },
    });
    const j: any = await r.json();
    const payload = JSON.parse(j.result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("invalid_schedule");
    // Goal NOT written
    expect((await store.list())).toHaveLength(0);
  });
});

describe("custom token override (for tests)", () => {
  test("explicit token honored", async () => {
    await server.close();
    server = await startLoopsHttpServer({ ctx, token: "test-fixed-token" });
    expect(server.token).toBe("test-fixed-token");
    const r = await rpc("initialize");
    expect(r.status).toBe(200);
  });
});

describe("path routing — exact pathname (通信牛 hardening nit)", () => {
  // Prior impl used `req.url.startsWith("/mcp")`, which routed
  // /mcpXYZ, /mcp.foo, /mcp-anything to the JSON-RPC handler. Bearer
  // auth still gated execution, but widened surface unnecessarily.
  // Tightened to exact pathname == "/mcp" (query string OK).
  const base = () => server.url.replace(/\/mcp$/, "");
  const authHdr = () => ({ "content-type": "application/json", "authorization": `Bearer ${server.token}` });
  const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

  test("/mcp (exact) accepted → 200", async () => {
    const r = await fetch(`${base()}/mcp`, { method: "POST", headers: authHdr(), body: initBody });
    expect(r.status).toBe(200);
  });

  test("/mcp?foo=bar (with query string) accepted → 200", async () => {
    const r = await fetch(`${base()}/mcp?foo=bar`, { method: "POST", headers: authHdr(), body: initBody });
    expect(r.status).toBe(200);
  });

  test("/mcpXYZ (suffix) rejected → 404 (not auth-checked)", async () => {
    const r = await fetch(`${base()}/mcpXYZ`, { method: "POST", headers: authHdr(), body: initBody });
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("not found");
  });

  test("/mcp/ (trailing slash) rejected → 404", async () => {
    const r = await fetch(`${base()}/mcp/`, { method: "POST", headers: authHdr(), body: initBody });
    expect(r.status).toBe(404);
  });

  test("/mcp-leak (dash suffix) rejected → 404", async () => {
    const r = await fetch(`${base()}/mcp-leak`, { method: "POST", headers: authHdr(), body: initBody });
    expect(r.status).toBe(404);
  });

  test("/ (root) rejected → 404", async () => {
    const r = await fetch(`${base()}/`, { method: "POST", headers: authHdr(), body: initBody });
    expect(r.status).toBe(404);
  });
});
