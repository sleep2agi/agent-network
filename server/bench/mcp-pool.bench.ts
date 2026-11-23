// McpServer 复用池 bench（负责人 2026-11-23 指定进仓库；自己起临时库，不碰任何线上数据）。
//
// 用法（在 server/ 目录下）：
//   bun run bench/mcp-pool.bench.ts            # 默认 455 个身份 × 3 轮
//   ITER=3 IDENTITIES=455 bun run bench/mcp-pool.bench.ts
//
// 输出：改前（池子关）/ 改后（池子开）的 CPU ms/请求、p50/p95 墙钟、RSS、命中率、每实例内存。
// 身份：400 个节点令牌（ntok_）+ 55 个用户令牌（其中 10 个是受限成员：member + agent_access=granted）。
// 请求：get_inbox / report_status / tools/list 轮流打。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const IDENTITIES = Number(process.env.IDENTITIES) || 455;
const ROUNDS = Number(process.env.ITER) || 3;
const NODE_IDENTITIES = Math.round(IDENTITIES * 0.88); // 400 / 455
const RESTRICTED_USERS = 10;

const dir = mkdtempSync(join(tmpdir(), "anet-pool-bench-"));
process.env.COMMHUB_DB = join(dir, "hub.db");
process.env.NODE_ENV = "test";
process.env.COMMHUB_UPLOADS_DIR = join(dir, "uploads");
delete process.env.DATABASE_URL;
delete process.env.COMMHUB_MCP_SERVER_POOL;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const { db } = await import("../src/db.js");

// ── 种数据 ────────────────────────────────────────────────────────────
const netId = "net_bench";
db.run("INSERT INTO networks (network_id,network_name,owner_id) VALUES (?1,'bench','u_bench_admin')", [netId]);
db.run("INSERT INTO users (user_id,username,password_hash,role) VALUES ('u_bench_admin','bench_admin','x','admin')");
db.run("INSERT INTO network_members (network_id,user_id,role,agent_access) VALUES (?1,'u_bench_admin','owner','all')", [netId]);

const nodeTokens: string[] = [];
const userTokens: string[] = [];
const aliases: string[] = [];

function seedNode(i: number): void {
  const alias = `bench-node-${i}`;
  const nodeId = `n_bench_${i}`;
  const token = `ntok_bench_${i}_${randomUUID().replace(/-/g, "")}`;
  db.run(
    "INSERT INTO nodes (node_id,node_name,alias,network_id,owner_user_id,runtime) VALUES (?1,?2,?3,?4,'u_bench_admin','opencode-sdk')",
    [nodeId, alias, alias, netId],
  );
  db.run("INSERT INTO sessions (alias,node_id,network_id,status) VALUES (?1,?2,?3,'idle')", [alias, nodeId, netId]);
  db.run(
    "INSERT INTO api_tokens (token_id,token_hash,user_id,network_id,name,scope,bound_node_id) VALUES (?1,?2,'u_bench_admin',?3,?4,'network',?5)",
    [`tok_bench_${i}`, hash(token), netId, `node:${alias}`, nodeId],
  );
  nodeTokens.push(token);
  aliases.push(alias);
}

function seedUser(i: number): void {
  const userId = `u_bench_${i}`;
  const token = `utok_bench_${i}_${randomUUID().replace(/-/g, "")}`;
  // 10 个受限成员：member + agent_access=granted（restrictedRow 判据）
  const restricted = i < RESTRICTED_USERS;
  db.run("INSERT INTO users (user_id,username,password_hash,role) VALUES (?1,?2,'x','user')", [userId, `bench-${i}`]);
  db.run(
    "INSERT INTO network_members (network_id,user_id,role,agent_access) VALUES (?1,?2,?3,?4)",
    [netId, userId, restricted ? "member" : "owner", restricted ? "granted" : "all"],
  );
  db.run(
    "INSERT INTO api_tokens (token_id,token_hash,user_id,name,scope) VALUES (?1,?2,?3,'bench-user','user')",
    [`tok_ubench_${i}`, hash(token), userId],
  );
  userTokens.push(token);
}

for (let i = 0; i < NODE_IDENTITIES; i++) seedNode(i);
for (let i = 0; i < IDENTITIES - NODE_IDENTITIES; i++) seedUser(i);
console.log(`seeded: ${nodeTokens.length} node tokens + ${userTokens.length} user tokens (${RESTRICTED_USERS} restricted), network=${netId}`);

const serverModule = await import("../src/server.js");
const { mcpServerPoolStats } = serverModule as any;
const hub = (serverModule as any).bootServer({ port: 0, hostname: "127.0.0.1" });
const base = `http://127.0.0.1:${hub.port}`;

const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" };

function identityOf(idx: number): { token: string; alias?: string } {
  if (idx < nodeTokens.length) return { token: nodeTokens[idx], alias: aliases[idx] };
  return { token: userTokens[idx - nodeTokens.length] };
}

const bodies = (idx: number): string => {
  const id = identityOf(idx);
  const tool = idx % 3;
  if (tool === 0) return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_inbox", arguments: { alias: id.alias ?? "bench_admin", limit: 5 } } });
  if (tool === 1) return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_status", arguments: { status: "idle", ...(id.alias ? { alias: id.alias } : {}) } } });
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
};

async function phase(label: string, poolOn: boolean) {
  if (poolOn) process.env.COMMHUB_MCP_SERVER_POOL = "1";
  else delete process.env.COMMHUB_MCP_SERVER_POOL;
  // 预热：让 JIT 与连接都稳定，不计入统计
  for (let i = 0; i < Math.min(30, nodeTokens.length); i++) {
    await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${identityOf(i).token}`, ...HEADERS }, body: bodies(i) });
  }
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const statsBefore = mcpServerPoolStats();
  const walls: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < IDENTITIES; i++) {
      const t = performance.now();
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${identityOf(i).token}`, ...HEADERS }, body: bodies(i) });
      await res.text(); // 必须读完，否则测的是排队不是处理
      walls.push(performance.now() - t);
      if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status} at identity ${i}`);
    }
  }
  const cpu = process.cpuUsage(cpuBefore);
  const rssAfter = process.memoryUsage().rss;
  const statsAfter = mcpServerPoolStats();
  const n = walls.length;
  const sorted = [...walls].sort((a, b) => a - b);
  const pct = (q: number) => sorted[Math.min(n - 1, Math.floor(n * q))];
  const cpuMs = (cpu.user + cpu.system) / 1000 / n;
  const created = statsAfter.created - statsBefore.created;
  const reused = statsAfter.reused - statsBefore.reused;
  const perInstance = statsAfter.pooled > 0 ? (rssAfter - rssBefore) / 1024 / 1024 / statsAfter.pooled : 0;
  return {
    label, n, cpuMs, p50: pct(0.5), p95: pct(0.95),
    rssMb: rssAfter / 1024 / 1024,
    created, reused,
    hitRate: created + reused > 0 ? reused / (created + reused) : 0,
    evicted: statsAfter.evicted - statsBefore.evicted,
    pooled: statsAfter.pooled,
    perInstanceMb: perInstance,
  };
}

const off = await phase("改前（池子关）", false);
const on = await phase("改后（池子开）", true);

const fmt = (v: number, d = 2) => v.toFixed(d).padStart(8);
console.log(`\n身份 ${IDENTITIES} 个 × ${ROUNDS} 轮 = ${off.n} 请求/阶段\n`);
console.log("阶段            CPU ms/请求      p50      p95    RSS(MB)   created  reused  命中率   evicted  pooled  每实例(MB)");
for (const s of [off, on]) {
  console.log(
    `${s.label.padEnd(14)}${fmt(s.cpuMs)}${fmt(s.p50)}${fmt(s.p95)}${fmt(s.rssMb, 0)}${String(s.created).padStart(9)}${String(s.reused).padStart(8)}${fmt(s.hitRate * 100, 1)}%${String(s.evicted).padStart(9)}${String(s.pooled).padStart(8)}${fmt(s.perInstanceMb, 2)}`,
  );
}
console.log(`\n提速：CPU/请求 ${(off.cpuMs / on.cpuMs).toFixed(1)}×，p95 ${(off.p95 / on.p95).toFixed(1)}×`);

try { hub?.stop?.(true); } catch {}
try { db.close?.(); } catch {}
try { rmSync(dir, { recursive: true, force: true }); } catch {}
