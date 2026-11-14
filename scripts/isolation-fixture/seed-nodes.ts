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

const out = { network_id: networkId, owner_user_id: ownerId, base_url: `http://127.0.0.1:${PORT}`, nodes: tokens };
mkdirSync(ROOT, { recursive: true });
const file = join(ROOT, "nodes.json");
writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });

// 只报「造了什么」，不报秘密
console.log(JSON.stringify({
  ok: true,
  file,
  base_url: out.base_url,
  network_id: networkId,
  nodes: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, { alias: v.alias, node_id: v.node_id, token: "<in file>" }])),
}, null, 2));
