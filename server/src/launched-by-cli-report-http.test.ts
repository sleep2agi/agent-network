// 2026-11-10 —— 「起这份 agent-node 的 anet CLI 版本」必须真的走到 `/api/nodes`。
//
// 为什么不是「加一列就完了」：Hub 的 report_status schema 对**不认识的键是静默丢弃**的
// （tools.ts 里那段 #1545 注释写得很清楚）。这条链路必须三处同时成立：
//   ① schema 里有这个键（否则 zod 丢掉）
//   ② 写路径把它落库（JSON.stringify 会连 `undefined` 一起吞掉）
//   ③ 读路径把它投影出来（否则界面上看不见）
// 少任何一处，现场表现都是「节点明明发了、hub 上什么都没有」—— 本仓库已经吃过两次
// （#3294 的 build_commit、#2293 的 opencode_catalog）。
//
// 所以这里走**真** HTTP：真 node 令牌 + 真 MCP `tools/call report_status` + 真 `GET /api/nodes`，
// 不做镜像 handler（镜像会与真实 handler 各自漂移）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-launched-by-"));
process.env.COMMHUB_DB ||= join(DIR, "commhub.db");

const stamp = `${process.pid}_${Date.now()}`;
const NET_ALIAS = `launchedby-${stamp}`;
let hub: any;
let base = "";
let adminToken = "";
let nodeToken = "";
let networkId = "";
let nodeId = "";

/** CLI 侧真实会上报的版本形态（npm 预发布版）。 */
const CLI_VERSION = "2.3.0-preview.226";

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

/** 真 MCP `tools/call report_status`，与 agent-node 心跳同一条入参路径。 */
async function reportStatus(snapshot: Record<string, unknown>) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${nodeToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "report_status",
        arguments: {
          resume_id: `r_launchedby_${stamp}`, alias: NET_ALIAS, status: "idle", node_id: nodeId,
          runtime: "opencode-sdk",
          config_snapshot: { model: "deepseek/deepseek-flash", ...snapshot },
        },
      },
    }),
  });
  await r.text();
  return r.status;
}

async function nodeRow() {
  const r = await send(adminToken, "GET", `/api/nodes?network_id=${networkId}`);
  expect(r.status).toBe(200);
  return ((r.body?.nodes ?? []) as Array<Record<string, unknown>>).find(n => n.node_id === nodeId)!;
}

function storedSnapshot(): Record<string, unknown> {
  const stored = db.get<{ config_snapshot: string }>(
    "SELECT config_snapshot FROM nodes WHERE node_id = ?1", nodeId,
  )!;
  return JSON.parse(stored.config_snapshot);
}

beforeAll(async () => {
  const admin = register(`launchedby_admin_${stamp}`, "LaunchedByAdmin123!", undefined, "LaunchedBy Admin");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;
  networkId = admin.network_id!;
  const ownerId = admin.user!.user_id;
  nodeId = `n_launchedby_${stamp}`;
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

describe("launched_by_cli_version 从真上报走到 GET /api/nodes", () => {
  test("schema 不吞这个键：落库 + /api/nodes 投影都看得见", async () => {
    expect(await reportStatus({ launched_by_cli_version: CLI_VERSION })).toBe(200);

    // ② 写路径
    expect(storedSnapshot().launched_by_cli_version).toBe(CLI_VERSION);

    // ③ 读路径
    const row = await nodeRow();
    expect(row.launched_by_cli_version).toBe(CLI_VERSION);
    // 整个快照仍然不外泄（这一格只是快照里的一个标量）。
    expect(row).not.toHaveProperty("config_snapshot");
  });

  test("没有这一格时投影是 null —— 不是 undefined 缺席，也不回退成占位版本", async () => {
    expect(await reportStatus({})).toBe(200);
    expect(storedSnapshot()).not.toHaveProperty("launched_by_cli_version");
    const row = await nodeRow();
    expect(row.launched_by_cli_version).toBeNull();
  });

  test("形状不对（超过 64 字符）只丢这一格，整份心跳照收", async () => {
    const tooLong = `1.0.0${"0".repeat(60)}`;
    expect(tooLong.length).toBeGreaterThan(64);
    expect(await reportStatus({ launched_by_cli_version: tooLong })).toBe(200);
    // `.catch(undefined)` ⇒ 落库时被 JSON.stringify 吞掉（不是存一个半截值）
    expect(storedSnapshot()).not.toHaveProperty("launched_by_cli_version");
    expect((await nodeRow()).launched_by_cli_version).toBeNull();
  });

  test("类型不对（对象/数字）同样只丢这一格", async () => {
    expect(await reportStatus({ launched_by_cli_version: { v: CLI_VERSION } })).toBe(200);
    expect((await nodeRow()).launched_by_cli_version).toBeNull();
    expect(await reportStatus({ launched_by_cli_version: 42 })).toBe(200);
    expect((await nodeRow()).launched_by_cli_version).toBeNull();
  });
});

describe("per-node config 端点：刻意不加这一格（说明理由，不是忘了）", () => {
  // `GET /api/nodes/:id/config` 的白名单只装**可编辑/可门控**的配置项
  // （model / modelVariant / flags / agent / *_config_capable …），
  // 溯源类只读标量（build_commit、opencode_catalog、role）一律不出现在那里。
  // launched_by_cli_version 属于后者 ⇒ 只走 /api/nodes，与邻居保持一致。
  test("该端点仍然只回配置项，不带这一格", async () => {
    expect(await reportStatus({ launched_by_cli_version: CLI_VERSION })).toBe(200);
    const r = await send(adminToken, "GET", `/api/nodes/${nodeId}/config`);
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty("launched_by_cli_version");
    expect(r.body).toHaveProperty("model");
  });
});
