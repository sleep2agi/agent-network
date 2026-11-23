// 复用池 + 请求级 memo 的身份新鲜度（负责人 2026-11-23 review 第 3 条）。
//
// 场景：节点令牌的 tokenId 不变，但节点被改别名 / 改绑。实例复用后，
// 发件身份（from）必须是**新值**，不能是池里实例的旧快照。
//
// 覆盖：
//   ① 同一 tokenId 连续两次请求：第二次前把节点别名改掉 ⇒ from 必须是新别名；
//   ② 请求级 memo 不跨请求：同一实例服务两次请求，第二次重新解析身份。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

const suffix = randomUUID().replace(/-/g, "");
const dbPath = `/tmp/anet-pool-freshness-${suffix}.db`;
const nodeToken = `ntok_${suffix}`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

let hub: any;
let db: any;
let base = "";

const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" };

async function mcpCall(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nodeToken}`, ...HEADERS },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").filter(l => l.startsWith("data:")).pop() ?? text;
  const parsed = JSON.parse(line.replace(/^data:\s*/, ""));
  return { status: res.status, body: parsed, text };
}

function lastTaskFrom(): string | null {
  return db.get("SELECT from_name FROM tasks WHERE to_name = 'node-b' ORDER BY created_at DESC, rowid DESC LIMIT 1")?.from_name ?? null;
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.COMMHUB_DB = dbPath;
  delete process.env.DATABASE_URL;
  process.env.COMMHUB_MCP_SERVER_POOL = "1"; // 本套件就是要测复用下的新鲜度
  const dbModule = await import("./db.js");
  db = dbModule.db;
  db.run("INSERT INTO users (user_id,username,password_hash,role) VALUES ('usr_x','x','x','user')");
  db.run("INSERT INTO networks (network_id,network_name,owner_id) VALUES ('net_f','F','usr_x')");
  db.run("INSERT INTO network_members (network_id,user_id,role) VALUES ('net_f','usr_x','owner')");
  db.run("INSERT INTO nodes (node_id,node_name,alias,network_id,owner_user_id) VALUES ('node_a','node-a','node-a','net_f','usr_x')");
  db.run("INSERT INTO nodes (node_id,node_name,alias,network_id,owner_user_id) VALUES ('node_b','node-b','node-b','net_f','usr_x')");
  db.run("INSERT INTO sessions (alias,node_id,network_id,status) VALUES ('node-a','node_a','net_f','idle')");
  db.run("INSERT INTO sessions (alias,node_id,network_id,status) VALUES ('node-b','node_b','net_f','idle')");
  // 节点令牌：tokenId 固定（tok_node），绑定 node_a
  db.run(
    "INSERT INTO api_tokens (token_id,token_hash,user_id,network_id,name,scope,bound_node_id) VALUES ('tok_node',?1,'usr_x','net_f','node:node-a','network','node_a')",
    [hash(nodeToken)],
  );
  const serverModule = await import("./server.js");
  hub = serverModule.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
});

describe("复用池下的发件身份新鲜度", () => {
  test("同一 tokenId：改别名后下一次请求 from 立即变成新别名", async () => {
    const first = await mcpCall("send_task", { alias: "node-b", task: "freshness-probe-1" });
    expect(first.status).toBe(200);
    expect(first.body.error).toBeUndefined();
    expect(lastTaskFrom()).toBe("node-a");

    // tokenId 不变，只改节点别名
    db.run("UPDATE nodes SET alias = 'node-a-renamed' WHERE node_id = 'node_a'");

    const second = await mcpCall("send_task", { alias: "node-b", task: "freshness-probe-2" });
    expect(second.status).toBe(200);
    expect(second.body.error).toBeUndefined();
    expect(lastTaskFrom()).toBe("node-a-renamed");
  });
});
