// #1474 (#909) — `report_status` accepts the NAMES of the env keys a node has.
//
// Called through a real MCP client (InMemoryTransport) rather than the raw
// handler: the shape rules live in the tool's zod schema, and invoking the
// handler directly bypasses them — the first version of this file "passed" a
// `lower-case` key because no validation ran.
//
// Two behaviours are load-bearing:
//   1. `[]` is a REAL report ("this node has no secrets") and must overwrite the
//      stored list; only an ABSENT field keeps the previous value.
//   2. A value accidentally placed in the array must be rejected at the
//      boundary, not stored and later rendered.
import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_secret_keys";
const USER = "u_secret_keys";
const RESUME = "r_secret_keys";
const ALIAS = "sk-node";

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

async function connectClient() {
  const server = new McpServer({ name: "secret-keys-test", version: "1" });
  // report_status is a node heartbeat: the harness presents a NETWORK token.
  registerTools(server, undefined, NET, USER, ALIAS, true, null);
  const client = new Client({ name: "secret-keys-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const report = (extra: Record<string, unknown> = {}) => ({
  resume_id: RESUME, alias: ALIAS, status: "idle", network_id: NET, ...extra,
});

async function call(client: Client, args: Record<string, unknown>): Promise<{ ok: boolean; body: any }> {
  const res = (await client.callTool({ name: "report_status", arguments: args })) as ToolResult;
  const text = res.content[0]?.text;
  if (!text) throw new Error("missing text tool result");
  // A schema rejection comes back as a plain error string ("MCP error ..."),
  // not JSON: that is exactly the boundary we want to observe.
  let body: any;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  return { ok: res.isError !== true, body };
}

const stored = () =>
  db.get<{ secret_keys: string | null }>("SELECT secret_keys FROM sessions WHERE resume_id = ?1", RESUME)?.secret_keys ?? null;

beforeEach(() => {
  db.run("INSERT OR IGNORE INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))", [USER, USER]);
  db.run("INSERT OR IGNORE INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT OR IGNORE INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  db.run("DELETE FROM sessions WHERE resume_id = ?1", [RESUME]);
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, datetime('now'), datetime('now'))`,
    [RESUME, ALIAS, NET],
  );
});

describe("report_status — secret key names", () => {
  test("stores the names as a JSON array", async () => {
    const client = await connectClient();
    const r = await call(client, report({ secret_keys: ["ALPHA_KEY", "BETA_KEY"] }));
    expect(r.body.ok).toBe(true);
    expect(stored()).toBe(JSON.stringify(["ALPHA_KEY", "BETA_KEY"]));
  });

  test("an absent field keeps the previous list", async () => {
    const client = await connectClient();
    await call(client, report({ secret_keys: ["ALPHA_KEY"] }));
    await call(client, report());
    expect(stored()).toBe(JSON.stringify(["ALPHA_KEY"]));
  });

  test("an EMPTY array is a real report and clears the list", async () => {
    const client = await connectClient();
    await call(client, report({ secret_keys: ["ALPHA_KEY"] }));
    await call(client, report({ secret_keys: [] }));
    expect(stored()).toBe("[]");
  });

  test("a malformed name is rejected at the boundary and nothing is written", async () => {
    const client = await connectClient();
    await call(client, report({ secret_keys: ["ALPHA_KEY"] }));
    const r = await call(client, report({ secret_keys: ["lower-case"] }));
    expect(r.ok).toBe(false);
    expect(stored()).toBe(JSON.stringify(["ALPHA_KEY"]));
  });

  test("more than 50 names is rejected", async () => {
    const client = await connectClient();
    const many = Array.from({ length: 51 }, (_, i) => `KEY_${String(i).padStart(3, "0")}`);
    const r = await call(client, report({ secret_keys: many }));
    expect(r.ok).toBe(false);
    expect(stored()).toBeNull();
  });

  test("a value-shaped string is rejected (the field is a name list, not free text)", async () => {
    const client = await connectClient();
    const value = "ghp_" + "A".repeat(40);
    const r = await call(client, report({ secret_keys: [value] }));
    expect(r.ok).toBe(false);
    expect(stored()).toBeNull();
  });
});
