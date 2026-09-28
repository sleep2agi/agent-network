// Codex CODEX_HOME 落在 sessions.codex_home，经全量 /api/status 的列投影出去。
// 跑法：cd server && COMMHUB_DB=/tmp/codex-home-status.db bun test src/codex-home-status.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { SESSION_REST_COLUMNS } from "./rest-projections.js";

const NET = "net_codex_home";
const USER = "u_codex_home";
const ALIAS = "codex-home-node";
const TOKEN = "tok_codex_home_node";

function cleanup() {
  try { db.run("DELETE FROM sessions WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM api_tokens WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seed() {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [USER, USER]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [NET, NET, USER]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [USER, NET]);
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at, bound_node_id) VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL, NULL)`,
    [TOKEN, USER, NET, `node:${ALIAS}`, `hash_${TOKEN}`],
  );
}

async function report(args: Record<string, unknown>) {
  const server = new McpServer({ name: "codex-home-test", version: "1" });
  registerTools(server, undefined, NET, USER, ALIAS, true, TOKEN);
  const client = new Client({ name: "codex-home-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const result: any = await client.callTool({
      name: "report_status",
      arguments: { resume_id: "resume-codex-home", alias: ALIAS, status: "idle", agent: "agent-node:codex-app-server", ...args },
    });
    const text = result.content?.[0]?.text;
    return text ? JSON.parse(text) : result;
  } finally {
    await client.close();
    await server.close();
  }
}

function stored(): string | null {
  return db.get<{ codex_home: string | null }>(
    "SELECT codex_home FROM sessions WHERE network_id = ?1 AND alias = ?2",
    NET, ALIAS,
  )?.codex_home ?? null;
}

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

describe("sessions.codex_home", () => {
  test("stores an absolute path, keeps it when a later report omits it, and replaces it when a new path arrives", async () => {
    const first = await report({ codex_home: "/data/nodes/codex-home", project_dir: "/data/workspaces/app" });
    expect(first.ok).not.toBe(false);
    expect(stored()).toBe("/data/nodes/codex-home");

    await report({ project_dir: "/data/workspaces/app" });
    expect(stored()).toBe("/data/nodes/codex-home");

    await report({ resume_id: "resume-codex-home-2", project_dir: "/data/workspaces/app" });
    expect(stored()).toBe("/data/nodes/codex-home");

    await report({ resume_id: "resume-codex-home-3", codex_home: "D:\\nodes\\codex-home" });
    expect(stored()).toBe("D:\\nodes\\codex-home");
  });

  test("drops unsafe values without failing the report or wiping a stored path", async () => {
    await report({ codex_home: "/data/nodes/codex-home" });
    for (const codex_home of ["/tmp/ntok_secret", "relative/codex-home", "/tmp/a\nb", `/${"a".repeat(1100)}`, 12]) {
      const result = await report({ codex_home });
      expect(result.ok).not.toBe(false);
      expect(stored()).toBe("/data/nodes/codex-home");
    }
  });

  test("full status selects the column and the light list does not", () => {
    expect(SESSION_REST_COLUMNS).toContain("codex_home");
    const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const light = server.slice(server.indexOf('const isLight'), server.indexOf('const isLight') + 700);
    expect(light).toContain("SELECT alias, status, agent, task, server, updated_at, network_id FROM sessions");
    expect(light).toContain("SELECT ${SESSION_REST_SELECT}");
    expect(light.split("SELECT alias, status")[0]).not.toContain("codex_home");
  });
});
