// #3294 —— 节点侧的**字节标识**：report_status 收 build_commit ⇒ /api/nodes 投影可见。
//
// 为什么不是「加一列就完了」：Hub 的 report_status schema 对**不认识的键是静默丢弃**的
// （源码里那段 #1545 注释写得很清楚）。所以这条链路必须三处同时成立：
//   ① schema 里有这个键（否则 zod 丢掉）
//   ② 写路径把它落库（否则写不进去）
//   ③ 读路径把它投影出来（否则界面上看不见）
// 少任何一处，现场表现都是「节点明明发了、hub 上没有」，与 daemon 侧 bug 一模一样。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-build-commit-"));
const STAMP = Date.now();
let BASE = "";
let hub: any = null;
let USER = "";
let NET = "";
let ntok = "";
let ALIAS = "";
const PW = "BuildCommitPassw0rd!x";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";   // 40 hex，固定值便于断言

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function rpc(method: string, params: any, token = ntok) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: method, arguments: params } }),
  });
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data: "));
  const env = JSON.parse(line ? line.slice(6) : raw);
  try { return JSON.parse(env.result.content[0].text); } catch { return { ok: false, raw }; }
}

async function nodes(token = ntok) {
  const res = await fetch(`${BASE}/api/nodes?network_id=${NET}`, { headers: auth(token) });
  return (await res.json()) as any;
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  USER = `bc_user_${STAMP}`;
  ALIAS = `bc-node-${STAMP}`;
  const reg = register(USER, PW);
  NET = reg.network_id!;
  const minted = createNetworkTokenForNode(reg.user!.user_id, NET, ALIAS, `node_bc_${STAMP}`);
  expect(minted.ok).toBe(true);
  ntok = minted.token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

function report(extra: Record<string, unknown> = {}) {
  return rpc("report_status", {
    resume_id: `resume_bc_${STAMP}`, alias: ALIAS, status: "idle",
    version: "2.5.0-preview.169", node_id: `node_bc_${STAMP}`, network_id: NET, ...extra,
  });
}

describe("#3294 节点上报 build_commit 的三段链路", () => {
  // 顺序是有意的：先没有、再有、再坏。同一行节点，三个阶段各读一次。
  test("① 没报 ⇒ null，且 note 说明「这不是缺陷」", async () => {
    // 老节点不报这个字段；把「没报」与「没有标识」压成同一个 null 会让人去查错方向，
    // 所以投影里同时给一个 note。
    expect((await report()).ok).toBe(true);
    const row = (await nodes()).nodes.find((n: any) => n.alias === ALIAS);
    expect(row).toBeDefined();
    expect(row.build_commit).toBeNull();
    expect(typeof row.build_note).toBe("string");
    expect(row.build_note).toContain("没有上报");
  });

  test("② 🔴 报了 ⇒ 落库 ⇒ /api/nodes 投影里读得到，且与 version 是两个东西", async () => {
    expect((await report({ build_commit: COMMIT })).ok).toBe(true);
    const row = (await nodes()).nodes.find((n: any) => n.alias === ALIAS);
    expect(row.build_commit).toBe(COMMIT);
    // ⚠️ `/api/nodes` 的投影里**没有** version 这一列（实测：拿到的 row.version 是 undefined）。
    // 所以「两个东西」这句不能靠对比 row.version 来断言 —— 那会变成在测一个不存在的字段。
    // 用上报时的字面量比：字节标识不可能是版本标签。
    expect(row.build_commit).not.toBe("2.5.0-preview.169");
  });

  test("③ 形状不对的 build_commit 被 schema 拒（不是静默丢弃）", async () => {
    // 与「静默丢弃」相反的那一半：**已知键但值不合规**必须报错，
    // 否则「发了个坏值」会和「没发」同形。
    const r = await report({ resume_id: `resume_bc3_${STAMP}`, build_commit: "NOT-HEX" });
    expect(r.ok).toBeFalsy();
  });
});
