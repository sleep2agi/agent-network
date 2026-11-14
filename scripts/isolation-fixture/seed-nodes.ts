#!/usr/bin/env bun
// #4063-A2 —— 给隔离夹具的本地 Hub 造两个节点（A / B），供 N1 / N2 / N4 用真令牌打真 HTTP。
//
// 为什么需要这一步：A 夹具（两实例 + 独立 HOME）已合，B 卡的 Hub 路径已被既有 HTTP 测试覆盖，
// 缺的正是「真 Hub + 两个真令牌 + 真授权对象」这一段 —— 没有它，N1/N2/N4 只能停在单测层。
//
// 🔴 边界：只用 $COMMHUB_DB 指向的夹具库；不连生产 Hub、不读生产 DB。
//    token 只写进 $ROOT/nodes.json（0600），**不打印到 stdout**。
//
// 用法（Hub 已由 hub.sh 起好）：
//   ROOT=/tmp/anet-isolation \
//   COMMHUB_DB=/tmp/anet-isolation/hub.db \
//   HUB_PORT=4633 \
//   bun scripts/isolation-fixture/seed-nodes.ts
//
// 输出：$ROOT/nodes.json
//   { network_id, owner_user_id, base_url, nodes: { a: {alias,node_id,token}, b: {...} } }

process.env.COMMHUB_SERVER = "1";

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.ROOT ?? "/tmp/anet-isolation";
const PORT = process.env.HUB_PORT ?? "4633";
const DB = process.env.COMMHUB_DB ?? join(ROOT, "hub.db");

if (!existsSync(DB)) {
  console.error(`FAIL: COMMHUB_DB 不存在 (${DB}) —— 先跑 hub.sh`);
  process.exit(1);
}
process.env.COMMHUB_DB = DB;

const stamp = Date.now().toString(36);

const { register, createNetwork, createNetworkTokenForNode } = await import("../../server/src/auth.js");
const { db } = await import("../../server/src/db.js");

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null) throw new Error(`missing: ${what}`);
  return v;
}

// 1) 夹具 owner（只在这个临时库里存在）
const owner = register(`iso-owner-${stamp}`, "IsoFixture123!", undefined, "iso fixture owner");
if (!owner.ok || !owner.user) throw new Error(`register failed: ${owner.error ?? "unknown"}`);
const ownerId = owner.user.user_id;

// 2) 夹具网络
const net = createNetwork(ownerId, `iso-${stamp}`, "isolation fixture network");
const networkId = must((net as any).network?.network_id ?? (net as any).network_id, "network_id");

// 3) 两个节点令牌（各自的 node_id，互不相同 —— 这是 N2 的前提）
const tokens: Record<string, { alias: string; node_id: string; token: string }> = {};
for (const [key, alias] of [["a", `iso-a-${stamp}`], ["b", `iso-b-${stamp}`]] as const) {
  // 显式给 node_id：不传的话令牌绑定后 nodes 行可能还没有 id，两个节点会共用空串 ⇒ N2 根本测不出来
  const nodeId = `n_iso_${key}_${stamp}`;
  const issued = createNetworkTokenForNode(ownerId, networkId, alias, nodeId);
  if (!issued.ok || !issued.token) throw new Error(`token for ${alias} failed: ${issued.error ?? "unknown"}`);
  // 返回的 node_id 在部分路径上是空的 —— 以 rows 为准，别拿空串当身份
  const row = db.get<{ node_id: string }>("SELECT node_id FROM nodes WHERE alias = ?1 AND network_id = ?2", [alias, networkId]);
  tokens[key] = { alias, node_id: issued.node_id || row?.node_id || "", token: issued.token };
}

// 4) 两台节点各一条 session（与既有 HTTP 测试同口径：直接插行，不经 daemon）
for (const t of Object.values(tokens)) {
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, agent, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, 'agent-node:opencode', datetime('now'), datetime('now'))`,
    [`r_${t.alias}`, t.alias, t.node_id, networkId],
  );
}

// 5) 把 A 报成一台 host_supervisor daemon，并声明两条源能力（N1/N4 的前置）
//
// 🔴 这里有个静默坑（实测踩到）：report_status 只在**带 node_id** 时才 upsert nodes 行。
//    不带 node_id 时，config_snapshot 里的一切（含 daemon_capabilities）会被**丢掉且仍回 200 ok**。
//    所以「能力上报成功」必须靠读回校验，不能靠回执。
const CAP_DIR = "source-directory-read-v1-opencode-2.0.22";
const CAP_ATTACH = "existing-session-attach-v1-opencode-2.0.22";

async function callTool(name: string, args: unknown, token: string): Promise<{ status: number; text: string }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    return { status: res.status, text: await res.text() };
  } catch (error: any) {
    return { status: 0, text: String(error?.message ?? error) };
  }
}

const daemon = tokens.a;
const reported = await callTool("report_status", {
  resume_id: `r_${daemon.alias}`,
  alias: daemon.alias,
  status: "idle",
  node_id: daemon.node_id,
  node_name: daemon.alias,
  config_snapshot: {
    role: "host_supervisor",
    daemon_capabilities: { source_directory_read: CAP_DIR, session_attach: CAP_ATTACH },
  },
}, daemon.token);

// 读回校验 —— 回执 200 不算证据
const readback = db.get<{ config_snapshot: string }>(
  "SELECT config_snapshot FROM nodes WHERE node_id = ?1", [daemon.node_id],
);
let caps: Record<string, unknown> | null = null;
try { caps = JSON.parse(readback?.config_snapshot ?? "{}").daemon_capabilities ?? null; } catch { caps = null; }
const capabilityOk = caps?.source_directory_read === CAP_DIR && caps?.session_attach === CAP_ATTACH;

const out = {
  network_id: networkId,
  owner_user_id: ownerId,
  base_url: `http://127.0.0.1:${PORT}`,
  daemon: { alias: daemon.alias, node_id: daemon.node_id, capabilities_ok: capabilityOk, http_status: reported.status },
  nodes: tokens,
};
mkdirSync(ROOT, { recursive: true });
const file = join(ROOT, "nodes.json");
writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });

// 只报「造了什么」，不报秘密
console.log(JSON.stringify({
  ok: true,
  file,
  base_url: out.base_url,
  network_id: networkId,
  daemon: out.daemon,
  nodes: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, { alias: v.alias, node_id: v.node_id, token: "<in file>" }])),
}, null, 2));

// 能力没落库就直接失败 —— 否则后面 N1/N4 的「拒绝」可能来自「能力压根没上」（假绿）
if (!capabilityOk) {
  console.error("FAIL: daemon 能力没有落库（report_status 回 200 不代表写入成功；检查是否带了 node_id）");
  process.exitCode = 1;
}
