// Board #652 — create_node takes Chinese / Unicode node names (the alias); illegal
// characters are refused with a reason before any row is written; the in-flight
// uniqueness check still holds. Driven through the REAL /mcp entry (zod schema +
// handler) on a private port with a temp DB, then get_create_request as the daemon.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIR = mkdtempSync(join(tmpdir(), "anet-652-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.HOST = "127.0.0.1";

const { db } = await import("./db.js");
const { register, createNetworkTokenForNode } = await import("./auth.js");

const PW = "Unicode652Passw0rd!x";
let BASE = "";
let hub: any = null;
let OWNER = "";
let OWNER_ID = "";
let NET = "";
let DAEMON_TOK = "";
const DAEMON_ID = "node_t652_daemon";

async function rpc(token: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  return lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
}
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const out = await rpc(token, "tools/call", { name, arguments: args });
  const text = out?.result?.content?.[0]?.text;
  if (typeof text !== "string") return { _raw: out };
  try { return JSON.parse(text); } catch { return { _text: text, isError: out.result.isError }; }
}
const create = (name: string) => mcp(OWNER, "create_node", {
  daemon_node_id: DAEMON_ID, network_id: NET,
  node_spec: { name, runtime: "claude-agent-sdk", model: "claude-sonnet-4-5", flags: {} },
});
const rows = (name: string) =>
  db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_create_requests WHERE daemon_node_id = ?1 AND child_name = ?2", DAEMON_ID, name)?.n ?? -1;

beforeAll(async () => {
  const a = register(`t652_owner_${Date.now()}`, PW, undefined, "Owner");
  if (!a.ok) throw new Error("register failed");
  OWNER = a.token!; OWNER_ID = a.user!.user_id; NET = a.network_id!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const t = createNetworkTokenForNode(OWNER_ID, NET, "t652-daemon", DAEMON_ID);
  if (!t.ok || !t.token) throw new Error("daemon token failed: " + t.error);
  DAEMON_TOK = t.token;
  db.run(
    `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, runtime, model, config_path, channels, server, hostname, network_id, config_revision, config_snapshot)
     VALUES (?1, 't652-daemon', 't652-daemon', 'claude-agent-sdk', 'm', '/tmp/cfg.json', '[]', 'h', 'h', ?2, 0, ?3)`,
    [DAEMON_ID, NET, JSON.stringify({ role: "host_supervisor", daemon_capabilities: { runtimes_supported: ["claude-agent-sdk"] } })],
  );
});
afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  rmSync(DIR, { recursive: true, force: true });
});

describe("#652 create_node via /mcp — Unicode names", () => {
  test("「测试」 is accepted; the daemon gets the same alias", async () => {
    const r = await create("测试");
    expect(r.ok).toBe(true);
    expect(String(r.request_id)).toMatch(/^cr_/);
    expect(rows("测试")).toBe(1);
    const g = await mcp(DAEMON_TOK, "get_create_request", { request_id: r.request_id });
    expect(g.ok).toBe(true);
    expect(g.node_spec.name).toBe("测试");
  });

  test("upper case / digit-first ASCII and 64 CJK characters pass the zod bound and the rule", async () => {
    for (const name of ["研发助手A", "Demo2", "9lives", "测".repeat(64)]) {
      const r = await create(name);
      expect({ name, ok: r.ok, error: r.error }).toEqual({ name, ok: true, error: undefined });
    }
  });

  test("surrounding whitespace is trimmed before it is stored", async () => {
    const r = await create("  前后空格  ");
    expect(r.ok).toBe(true);
    expect(rows("前后空格")).toBe(1);
    expect(rows("  前后空格  ")).toBe(0);
  });

  test("illegal characters are refused with reason + char + message, and no row is written", async () => {
    for (const [name, reason] of [["a/b", "forbidden_char"], ["a\\b", "forbidden_char"], ["a:b", "forbidden_char"],
      [".hidden", "forbidden_char"], ["..", "forbidden_char"], ["a b", "forbidden_char"], ["a\u0007b", "forbidden_char"],
      ["-x", "leading_dash"], ["测".repeat(65), "too_long"]] as const) {
      const r = await create(name);
      expect({ name, error: r.error, reason: r.reason }).toEqual({ name, error: "node_name_invalid", reason });
      expect(String(r.message ?? "").length).toBeGreaterThan(0);
      expect(rows(name)).toBe(0);
    }
    const slash = await create("a/b");
    expect(slash.char).toBe("/");
    expect(slash.message).toContain("/");
  });

  test("uniqueness: a second in-flight request for the same Chinese name is a conflict", async () => {
    const first = await create("重复名字");
    expect(first.ok).toBe(true);
    const second = await create("重复名字");
    expect(second.ok).toBe(false);
    expect(second.error).toBe("node_name_conflict");
    expect(rows("重复名字")).toBe(1);
  });
});
