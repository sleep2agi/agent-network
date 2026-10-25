// #2293（admin 2026-10-25）—— 从**节点的真实上报**一路走到 `/api/nodes` 的投影。
//
// 为什么这条要单独写：`api-nodes-shape.test.ts` 是**镜像 handler** 的（文件里自己声明会漂），
// `node-attrs.test.ts` 是直接往库里塞一行快照。两者都没有走 `report_status` 的 zod schema ——
// 而 schema 恰恰是「节点发了、Hub 上却什么都没有」最容易出事的地方（#1545：往非 strict 对象里
// 加键会被静默丢弃）。这里用真 node 令牌 + 真 MCP `tools/call` + 真 `GET /api/nodes`。
//
// 断言三件事：
//   1. `opencode_catalog` / `opencode_server` / flags 里的代际·模式，经 schema 后**落到库里**；
//   2. `/api/nodes` 把它们投影出来，且**整个 config_snapshot 不外泄**；
//   3. 形状不对（嵌对象、混非字符串）时**心跳照收**，只是这一格没有 —— 不许拒整份上报。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-catalog-report-"));
process.env.COMMHUB_DB ||= join(DIR, "commhub.db");

const stamp = `${process.pid}_${Date.now()}`;
const NET_ALIAS = `catalog-${stamp}`;
let hub: any;
let base = "";
let adminToken = "";
let nodeToken = "";
let networkId = "";
let nodeId = "";

async function send(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* MCP may answer as SSE */ }
  return { status: r.status, body: json, text };
}

/** 真 MCP `tools/call report_status`，和 agent-node 心跳走同一条入参路径。 */
async function reportStatus(snapshot: Record<string, unknown>) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "report_status",
        arguments: {
          resume_id: `r_catalog_${stamp}`, alias: NET_ALIAS, status: "idle", node_id: nodeId,
          runtime: "opencode-sdk",
          config_snapshot: { model: "deepseek/deepseek-flash", ...snapshot },
        },
      },
    }),
  });
  await r.text();
  return r.status;
}

async function listNodes() {
  const r = await send(adminToken, "GET", `/api/nodes?network_id=${networkId}`);
  expect(r.status).toBe(200);
  return (r.body?.nodes ?? []) as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  const admin = register(`catalog_admin_${stamp}`, "CatalogAdmin123!", undefined, "Catalog Admin");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;
  networkId = admin.network_id!;
  const ownerId = admin.user!.user_id;
  nodeId = `n_catalog_${stamp}`;
  const minted = createNetworkTokenForNode(ownerId, networkId, NET_ALIAS, nodeId);
  expect(minted.ok).toBe(true);
  nodeToken = minted.token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch { /* already down */ }
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("#2293 node-reported OpenCode catalog reaches GET /api/nodes", () => {
  test("a real report_status lands the catalog and the scalars on the node row", async () => {
    expect(await reportStatus({
      flags: { opencodeGeneration: "v2", opencodeMode: "copresence", daemonSideSecret: "must-not-leak" },
      opencode_catalog: ["deepseek/deepseek-flash", "opencode/mimo-v2.6-flash-free"],
      opencode_server: "http://127.0.0.1:4096",
    })).toBe(200);

    const stored = db.get<{ config_snapshot: string }>("SELECT config_snapshot FROM nodes WHERE node_id = ?1", nodeId)!;
    expect(JSON.parse(stored.config_snapshot).opencode_catalog).toEqual([
      "deepseek/deepseek-flash", "opencode/mimo-v2.6-flash-free",
    ]);

    const row = (await listNodes()).find(r => r.node_id === nodeId)!;
    expect(row).toBeDefined();
    expect(row.opencode_catalog).toEqual(["deepseek/deepseek-flash", "opencode/mimo-v2.6-flash-free"]);
    expect(row.opencode_generation).toBe("v2");
    expect(row.opencode_mode).toBe("copresence");
    expect(row.opencode_server).toBe("http://127.0.0.1:4096");
    // 整个快照仍然不出现在这一行里；flags 中的其它键也不外泄。
    expect(row).not.toHaveProperty("config_snapshot");
    expect(JSON.stringify(row)).not.toContain("must-not-leak");
  });

  test("a malformed catalog drops that field only — the heartbeat is still accepted", async () => {
    expect(await reportStatus({
      flags: { opencodeGeneration: "v2" },
      // 嵌对象 + 混入数字：形状不对，schema 的 `.catch(undefined)` 应当只丢这一格。
      opencode_catalog: { models: ["deepseek/deepseek-flash"] },
      opencode_server: 12345,
    })).toBe(200);

    const row = (await listNodes()).find(r => r.node_id === nodeId)!;
    expect(row).toBeDefined();
    expect(row.opencode_catalog).toBeNull();
    expect(row.opencode_server).toBeNull();
    // 代际这一格仍然照常投影（没被同一条错误连带丢掉）。
    expect(row.opencode_generation).toBe("v2");
  });

  test("a node that never reported the fields reads as null on every one of them", async () => {
    const other = (await listNodes()).find(r => r.node_id !== nodeId);
    if (!other) return; // 该网络里只有一个节点时无需断言（不是失败）
    expect(other.opencode_catalog ?? null).toBeNull();
    expect(other.opencode_generation ?? null).toBeNull();
    expect(other.opencode_mode ?? null).toBeNull();
    expect(other.opencode_server ?? null).toBeNull();
  });
});
