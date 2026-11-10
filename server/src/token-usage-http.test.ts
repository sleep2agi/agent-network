// #3952/#3950 —— `GET /api/token-usage` 的 HTTP 面。
//
// 这个端点存在的理由是「人能看见节点消耗了多少 token」，所以它必须钉住四条：
//
//   ① 节点令牌看不到（node 不是人 —— 与 catalog 读接口同一条边界）；
//   ② 别的网络的成员看不到本网络的用量（network 隔离）；
//   ③ **cache 不进 total**（实测 cache.read 可以是 total 的几百倍，
//      一旦混算，排行会变成「谁最老」而不是「谁用得最多」）；
//   ④ 空窗口要能分清「没人上报」与「用量为 0」—— 两者在表上同形。
//
// 另外钉住覆盖率的分母：只有 1 行时，读表的人不该把它读成「只有 1 台在干活」。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-token-usage-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let server: ReturnType<typeof Bun.serve>;
let base = "";
let ownerToken = "", strangerToken = "", nodeToken = "";
let ownerNet = "", strangerNet = "";
// 路径写成字面量常量：`scripts/report-rest-visibility.py` 用「测试里出现带引号的完整路径」
// 判断这条路由有没有被请求过；模板串里拼参数会让它记成「从未被请求」。
const TOKEN_USAGE = "/api/token-usage";

const get = async (path: string, token?: string) => {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${path}`, { headers });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text };
};

beforeAll(async () => {
  const { db } = await import("./db.js");
  // 建表发生在 node-token-usage 模块被 import 时（刻意的：只要 import 了它，表就一定在）。
  // 不先 import 就直接 INSERT ⇒ "no such table"，而那个错误看起来像"迁移没跑"。
  await import("./node-token-usage.js");
  const { register, createNetworkTokenForNode } = await import("./auth.js");
  const stamp = Date.now();

  const owner = register(`tu_owner_${stamp}`, "TuOwner-Strong-1!");
  const stranger = register(`tu_stranger_${stamp}`, "TuStranger-Strong-1!");
  expect(owner.ok && stranger.ok).toBe(true);
  ownerToken = owner.token!;
  strangerToken = stranger.token!;
  ownerNet = owner.network_id!;
  strangerNet = stranger.network_id!;

  const ownerUserId = db.get<{ user_id: string }>(
    "SELECT user_id FROM users WHERE username = ?1", `tu_owner_${stamp}`)!.user_id;
  const nodeTok = createNetworkTokenForNode(ownerUserId, ownerNet, "tu-node", "n_tu_test");
  expect(nodeTok.ok).toBe(true);
  nodeToken = nodeTok.token!;

  // 两行用量：一行大（cache 远大于 body），一行小。
  const now = new Date();
  const hour = `${now.toISOString().slice(0, 13)}`;
  db.run(
    `INSERT INTO node_token_usage (network_id, node_id, hour, model, input_tokens, output_tokens, cache_read_tokens)
     VALUES (?1, 'n_tu_a', ?2, 'm1', 1000, 500, 900000)`,
    [ownerNet, hour],
  );
  db.run(
    `INSERT INTO node_token_usage (network_id, node_id, hour, model, input_tokens, output_tokens, cache_read_tokens)
     VALUES (?1, 'n_tu_b', ?2, 'm2', 10, 5, 100)`,
    [ownerNet, hour],
  );
  // 另一个网络的行：绝不能出现在 owner 的读数里。
  db.run(
    `INSERT INTO node_token_usage (network_id, node_id, hour, model, input_tokens, output_tokens, cache_read_tokens)
     VALUES (?1, 'n_tu_x', ?2, 'mx', 77777, 77777, 77777)`,
    [strangerNet, hour],
  );

  // 覆盖率分母靠 sessions.version 判定：一台 >= .180（会报），一台旧版（不会报）。
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, network_id, status, version)
     VALUES ('tu-s1', 'tu-capable', 'n_tu_a', ?1, 'idle', '2.5.0-preview.181')`,
    [ownerNet],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, network_id, status, version)
     VALUES ('tu-s2', 'tu-old', 'n_tu_b', ?1, 'idle', '2.5.0-preview.164')`,
    [ownerNet],
  );

  // 用 bootServer 而不是 app.fetch：server.ts 只导出 bootServer（没有默认导出的 handler）。
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  rmSync(PRIVATE_DB_DIR, { recursive: true, force: true });
});

describe("#3952 /api/token-usage", () => {
  test("本人网络：拿得到两行，且 total = input + output（cache 不进 total）", async () => {
    const r = await get(`${TOKEN_USAGE}?network_id=${ownerNet}&since_hours=24`, ownerToken);
    expect(r.status).toBe(200);
    const nodes = r.body.nodes as any[];
    expect(nodes.length).toBe(2);
    expect(r.body.totals.input_tokens).toBe(1010);
    expect(r.body.totals.output_tokens).toBe(505);
    expect(r.body.totals.total_tokens).toBe(1515);
    // 镜像：cache 单列存在，且**不等于** total —— 混算的话这里会相等
    expect(r.body.totals.cache_read_tokens).toBe(900100);
    expect(r.body.totals.cache_read_tokens).not.toBe(r.body.totals.total_tokens);
    // 别的网络的行不在里面
    expect(nodes.every((n: any) => n.node_id !== "n_tu_x")).toBe(true);
  });

  test("不传 network_id：唯一所属网络时自动回退（与 /api/providers 同口径）", async () => {
    // 上一版这里 400 network_required，而同一页的 /api/providers 会给 200 ——
    // 同一台 hub 上相邻两个端点对同一个用户给不同答案，客户端被迫多写分支。
    const r = await get(`${TOKEN_USAGE}?since_hours=24`, ownerToken);
    expect(r.status).toBe(200);
    expect(r.body.network_id).toBe(ownerNet);
    // 镜像：既然回退了，就必须回退到**自己的**网络，而不是任意一个
    expect(r.body.network_id).not.toBe(strangerNet);
  });

  test("节点令牌看不到（user_token_required，不是 404 也不是空表）", async () => {
    const r = await get(`${TOKEN_USAGE}?network_id=${ownerNet}`, nodeToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });

  test("别的网络的成员看不到（not a member，且不泄漏行数）", async () => {
    const r = await get(`${TOKEN_USAGE}?network_id=${ownerNet}`, strangerToken);
    expect(r.status).toBe(403);
    expect(r.body.nodes).toBeUndefined();
  });

  test("没令牌：401 而不是空表", async () => {
    const r = await get(`${TOKEN_USAGE}?network_id=${ownerNet}`);
    expect(r.status).toBe(401);
  });

  test("覆盖率分母：capable 只数 >= .180，不等于会话总数", async () => {
    const r = await get(`${TOKEN_USAGE}?network_id=${ownerNet}&since_hours=24`, ownerToken);
    expect(r.status).toBe(200);
    const cov = r.body.coverage;
    expect(cov.reporting_nodes).toBe(2);
    expect(cov.capable_nodes).toBe(1);
    expect(cov.sessions_with_version).toBe(2);
    // 镜像：分母比分子大 ⇒ 这个字段不是把 reporting_nodes 复制了一遍
    expect(cov.sessions_with_version).toBeGreaterThan(cov.capable_nodes);
  });
});
