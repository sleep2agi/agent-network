import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { nodeTokenReissueError } from "../../agent-network/src/cli-errors";

process.env.COMMHUB_DB ||= `${mkdtempSync("/tmp/owner678-")}/hub.db`;
let db: any, hub: ReturnType<typeof Bun.serve>, base: string;
let owner: any, member: any, outsider: any, legacy: string, mismatched: string, bound: string;
let wrongBound: string, ownerless: string, revoked: string, crossNetwork: string, requestId: string;
const daemon = "n_owner_fixture_daemon", child = "n_owner_fixture_child";

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const raw = await response.text(), lines = raw.split("\n").filter(line => line.startsWith("data:"));
  const message = JSON.parse(lines.length ? lines.at(-1)!.slice(5) : raw);
  expect(message.error).toBeUndefined();
  return JSON.parse(message.result.content[0].text);
}
async function mint(token: string, network: string, name: string, nodeId?: string) {
  const response = await fetch(`${base}/api/auth/node-token`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ network_id: network, node_name: name, ...(nodeId ? { node_id: nodeId } : {}) }),
  });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const { generateNetworkToken, hashToken } = await import("./db.js");
  owner = register("owner678", "Fixture-Strong1!");
  member = register("member678", "Fixture-Strong1!");
  outsider = register("outside678", "Fixture-Strong1!");
  db.run("UPDATE users SET role='user' WHERE user_id IN (?1,?2)", [member.user.user_id, outsider.user.user_id]);
  db.run("INSERT INTO network_members(network_id,user_id,role) VALUES(?1,?2,'member')", [owner.network_id, member.user.user_id]);
  for (const id of [daemon, child, "n_ownerless_fixture"]) {
    db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,hostname,config_snapshot,lifecycle_state)
      VALUES(?1,?1,?1,?2,?3,'fixture-host',?4,'active')`, [id, owner.network_id,
      id === "n_ownerless_fixture" ? null : owner.user.user_id,
      JSON.stringify(id === daemon ? { role: "host_supervisor", daemon_capabilities: { adopt_capable: true } } : {})]);
  }
  db.run("INSERT INTO sessions(resume_id,alias,node_id,network_id,status,last_seen_at) VALUES(?1,?1,?1,?2,'idle',datetime('now'))", [daemon, owner.network_id]);
  function credential(label: string, user: string, node: string | null = null, alias = daemon, network = owner.network_id) {
    const token = generateNetworkToken();
    db.run(`INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash,bound_node_id)
      VALUES(?1,?2,?3,'network',?4,?5,?6)`, [label, user, network, `node:${alias}`, hashToken(token), node]);
    return token;
  }
  legacy = credential("owner678_legacy", owner.user.user_id);
  mismatched = credential("owner678_mismatch", member.user.user_id);
  bound = credential("owner678_bound", member.user.user_id, daemon);
  wrongBound = credential("owner678_wrong_bound", member.user.user_id, "n_absent_bound");
  ownerless = credential("owner678_ownerless", member.user.user_id, null, "n_ownerless_fixture");
  db.run("UPDATE api_tokens SET node_identity_epoch=1 WHERE token_id='owner678_ownerless'");
  revoked = credential("owner678_revoked", owner.user.user_id);
  db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id='owner678_revoked'");
  crossNetwork = credential("owner678_cross", outsider.user.user_id, daemon, daemon, outsider.network_id);
  const { bootServer } = await import("./server.js");
  hub = bootServer({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${hub.port}`;
  const request = await call(owner.token, "request_adopt_node", { node_id: child, daemon_node_id: daemon, workdir: "/fixture/project" });
  expect(request.ok).toBe(true); requestId = request.request_id;
}, 60000);
afterAll(() => hub?.stop(true));

test("name-only issuance checks existing ownership atomically", async () => {
  const count = () => db.get("SELECT COUNT(*) AS n FROM api_tokens").n;
  const before = count();
  expect(await mint(member.token, owner.network_id, daemon)).toEqual({ status: 400, body: { ok: false, error: "node_owner_mismatch" } });
  expect(await mint(owner.token, owner.network_id, "n_ownerless_fixture")).toEqual({ status: 400, body: { ok: false, error: "node_owner_mismatch" } });
  expect(count()).toBe(before);
  // Legacy owner refresh and a new node name remain supported.
  const refresh = await mint(owner.token, owner.network_id, daemon);
  expect(refresh.status).toBe(200);
  expect((await call(refresh.body.token, "list_my_children")).ok).toBe(true);
  expect((await mint(member.token, owner.network_id, "fresh678")).status).toBe(200);
  expect((await mint(member.token, owner.network_id, daemon, daemon)).body.error).toBe("node_owner_mismatch");
});

// Every daemon-facing handler must fail at the shared identity boundary,
// not incidentally at request lookup or argument validation. The resolver
// mutation expects all 15 of these cases to go red together.
const endpoints: [string, Record<string, unknown>][] = [
  ["list_my_pending_create_requests", {}], ["list_my_pending_lifecycle_requests", {}],
  ["get_create_request", { request_id: "cr_fixture_absent" }],
  ["ack_create_request", { request_id: "cr_fixture_absent", status: "started" }],
  ["get_stop_request", { request_id: "sr_fixture_absent" }],
  ["ack_stop_request", { request_id: "sr_fixture_absent", status: "stopped" }],
  ["get_start_request", { request_id: "start_fixture_absent" }],
  ["ack_start_request", { request_id: "start_fixture_absent", status: "started" }],
  ["list_my_children", {}], ["get_adopt_request", {}], ["ack_adopt_request", { status: "adopted" }],
  ["get_probe_request", { probe_id: "probe_fixture_absent" }],
  ["ack_probe_request", { probe_id: "probe_fixture_absent", status: "ok", latency_ms: 1 }],
  ["get_opencode_catalog_request", { request_id: "cat_fixture_absent" }],
  ["ack_opencode_catalog", { request_id: "cat_fixture_absent", error: "unavailable" }],
];
for (const [name, arguments_] of endpoints) {
  test(`daemon identity boundary: ${name}`, async () => {
    const args = name.includes("adopt_request") ? { ...arguments_, request_id: requestId } : arguments_;
    for (const token of [mismatched, wrongBound, ownerless, owner.token, member.token]) {
      const denied = await call(token, name, args);
      expect(denied).toMatchObject({ ok: false, error: "caller_not_a_daemon" });
      // 2026-10-31 —— #3275：**错误信封也是契约**。
      // 这八个 ack/get 工具此前只被断言过 error 的**值**，没有一条钉住键集：
      // 谁顺手在某个出口多塞一个字段（例如 hint / request_id），客户端的分支就多一个没人知道的键。
      // ⇒ 在同一个循环里把形状钉住，成本几乎为零。
      expect(Object.keys(denied).sort()).toEqual(["error", "ok"]);
    }
    expect(db.get("SELECT status FROM node_daemon_bindings WHERE request_id=?1", requestId).status).toBe("pending");
  });
}

// #3275 批次 1 —— 上面那个表驱动循环里工具名是**变量**，所以「同变量」统计口径按名字归因不到任何一个工具。
// 这不是测试写得不好，是**统计的粒度**问题：一条循环里的断言无法被归到被循环的那 N 个工具上。
// ⇒ 给 ack_create_request 补一条带字面量的：错误信封是闭集 {error, ok}。
//
// 批次 1·c 的结论（写在这里，因为它是这一批的**真实成本**：夹具不够，不是断言不够）：
//   三个 `ack_*_request` 的失败分支闭集是 request_not_found / not_your_request /
//   cross_network_request / caller_not_a_daemon。今天只有最后一条可达（上面的循环已钉住 {error,ok}）。
//   前三条要么需要**绑定到 daemon 的** MCP 凭证（owner 令牌先撞 caller_not_a_daemon），
//   要么需要跨网络 daemon 凭证 —— 本夹具里的 `bound` 只用于 REST 侧 mint 测试，
//   拿它调 /mcp 直接非 200（实测），所以那条路走不通。
// ⇒ 批次 1·c 要先造一个「daemon 绑定 + MCP 可用」的凭证，再谈断言。
//   在那之前，任何「4 条失败分支已覆盖」的说法都是假的。
test("#3275 ack_create_request 的错误信封恰好 {error, ok}", async () => {
  const denied = await call(owner.token, "ack_create_request", { request_id: "cr_fixture_absent", status: "started" });
  expect(denied.ok).toBe(false);
  expect(Object.keys(denied).sort()).toEqual(["error", "ok"]);
});

test("legacy owner and exact bound identity remain supported", async () => {
  expect(db.get("SELECT bound_node_id FROM api_tokens WHERE token_id='owner678_legacy'").bound_node_id).toBeNull();
  for (const token of [legacy, bound]) {
    expect((await call(token, "list_my_children")).ok).toBe(true);
    // 2026-10-31 —— #3275 批次 2：这两条是 **SSE 重连补偿**的入口（漏了门铃节点会卡死），
    // 客户端按字段名读；键集从未被钉住。改为 `const` 赋值，顺便让严格口径能数到它们。
    const pendCreate = await call(token, "list_my_pending_create_requests");
    expect(pendCreate.ok).toBe(true);
    expect(Object.keys(pendCreate).sort()).toEqual(["clone_count", "clone_requests", "count", "ok", "requests"]);

    const pendLife = await call(token, "list_my_pending_lifecycle_requests");
    expect(pendLife.ok).toBe(true);
    expect(Object.keys(pendLife).sort()).toEqual(["ok", "start_count", "start_requests", "stop_count", "stop_requests"]);
    // 计数与数组同源：两个 count 必须等于各自数组长度（否则「有 N 条」与「列出来」会分叉）
    expect(pendLife.stop_count).toBe(pendLife.stop_requests.length);
    expect(pendLife.start_count).toBe(pendLife.start_requests.length);
    // 2026-10-31 —— #3275：形状由**一次真实调用**给出（不靠读源码猜）
    const gotAdopt = await call(token, "get_adopt_request", { request_id: requestId });
    expect(gotAdopt.ok).toBe(true);
    // ⚠️ 我第一版按源码猜了 7 个键（binding_request_id / child_alias / child_node_id …）——**全错**。
    // 真实形状由这次调用给出，12 个键；其中 error 为空、request_id 是这一行自己的 id。
    // 这是本卡第三次被「读源码猜形状」打回，写进注释免得下一个人再猜：
    //   行对象整行透传时，源码里看到的字段名是**SQL 的列名**，与对外载荷不是一回事。
    expect(Object.keys(gotAdopt).sort()).toEqual([
      "alias", "created_at", "daemon_node_id", "error", "network_id", "node_id",
      "ok", "request_id", "requested_by", "status", "updated_at", "workdir",
    ]);
  }
  // An explicit binding does not bypass the network or revocation boundaries.
  expect(await call(crossNetwork, "list_my_children")).toMatchObject({ ok: false, error: "caller_not_a_daemon" });
  const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${revoked}` } });
  expect(denied.status).toBe(401);
  // 2026-10-31 —— #3275：**成功体也要钉键集**（上面那个循环钉的是错误信封）。
  // 这四条是 daemon 侧最常被按字段名读的回执；多一个键不会让谁报错，但会改变解析分支。
  const adopted = await call(legacy, "ack_adopt_request", { request_id: requestId, status: "adopted" });
  expect(adopted).toMatchObject({ ok: true, status: "active" });
  expect(Object.keys(adopted).sort()).toEqual(["ok", "status"]);
  expect((await call(legacy, "list_my_children")).children).toContainEqual({ child_node_id: child, alias: child, lifecycle_state: "active", managed: "adopted", binding_request_id: requestId });
  // 2026-10-31 —— #3275：get_probe_request 的**不存在**分支键集（成功分支需要真实 probe 夹具，
  // 本文件不造；错误分支同样是契约：客户端按 error 分支，多一个键就会多一个没人知道的分支）
  const gotProbe = await call(legacy, "get_probe_request", { probe_id: "probe_fixture_absent" });
  expect(gotProbe.ok).toBe(false);
  // 实测：错误分支多一个 reason（不是只 {error, ok}）——**又一次由真实调用纠正**
  expect(Object.keys(gotProbe).sort()).toEqual(["error", "ok", "reason"]);
  // 2026-10-31 —— #3275：get_opencode_catalog_request 的**不存在**分支恰好两键
  // （与 get_probe_request 的三键不同族 —— 又一次说明「错误信封不是全仓一个形状」）
  const gotCatalog = await call(legacy, "get_opencode_catalog_request", { request_id: "cat_fixture_absent" });
  expect(gotCatalog.ok).toBe(false);
  expect(Object.keys(gotCatalog).sort()).toEqual(["error", "ok"]);
  const stop = await call(owner.token, "stop_node", { node_id: child, network_id: owner.network_id });
  // #3275 批次 2·f —— stop_node 的外层（实测）。比 start_node 多两个键：
  // `action` 说明触发的是哪条路径（restart_node 走同一条），`in_flight_at_dispatch` 说明
  // **下发那一刻**手上还有几条任务 —— 少了它，客户端无法区分「干净停机」与「截断在跑的任务」。
  expect(Object.keys(stop).sort()).toEqual(["action", "in_flight_at_dispatch", "lifecycle_state", "ok", "request_id"]);
  expect(stop.ok).toBe(true);
  // 2026-10-31 —— #3275 批次 2：get_stop_request 的**成功体**键集（daemon 按字段名读，
  // 尤其 delete_config / grace_seconds / force 三个决定它要不要删配置）
  const gotStop = await call(legacy, "get_stop_request", { request_id: stop.request_id });
  expect(gotStop.ok).toBe(true);
  expect(Object.keys(gotStop).sort()).toEqual([
    "action", "child_alias", "child_node_id", "delete_config", "force", "grace_seconds", "ok", "request_id",
  ]);
  const stoppedAck = await call(legacy, "ack_stop_request", { request_id: stop.request_id, status: "stopped" });
  expect(stoppedAck.ok).toBe(true);
  expect(Object.keys(stoppedAck).sort()).toEqual(["ok", "status"]);   // #3275：成功体键集
  const start = await call(owner.token, "start_node", { node_id: child, network_id: owner.network_id });
  // start_node 只有四个键：**它没有 in_flight_at_dispatch** ——
  // 因为「启动时手上还有几条任务」不是一个有意义的问题。两个工具同名不同形，各自量。
  expect(Object.keys(start).sort()).toEqual(["lifecycle_state", "ok", "request_id"]);
  expect(start.ok).toBe(true);
  const gotStart = await call(legacy, "get_start_request", { request_id: start.request_id });
  expect(gotStart.ok).toBe(true);
  // 成功体：四个固定键 + start_completion_capable；fork_recovery 只在「创建即恢复」路径出现（条件键）
  expect(Object.keys(gotStart).sort()).toEqual([
    "child_alias", "child_node_id", "ok", "request_id", "start_completion_capable",
  ]);
  const startedAck = await call(legacy, "ack_start_request", { request_id: start.request_id, status: "started", child_pid: 4321 });
  expect(startedAck).toMatchObject({ ok: true, status: "started" });
  expect(Object.keys(startedAck).sort()).toEqual(["ok", "status"]);   // #3275：成功体键集
});

test("ownerless legacy daemon remains supported without rewriting its owner", async () => {
  db.run("UPDATE api_tokens SET node_identity_epoch=0 WHERE token_id='owner678_ownerless'");
  try {
    expect((await call(ownerless, "list_my_children")).ok).toBe(true);
    const refresh = await mint(member.token, owner.network_id, "n_ownerless_fixture");
    expect(refresh.status).toBe(200);
    expect(refresh.body.node_id).toBe("n_ownerless_fixture");
    expect((await call(refresh.body.token, "list_my_children")).ok).toBe(true);
    const withId = await mint(member.token, owner.network_id, "n_ownerless_fixture", "n_ownerless_fixture");
    expect(withId.status).toBe(200);
    expect(db.get("SELECT owner_user_id FROM nodes WHERE node_id='n_ownerless_fixture'").owner_user_id).toBeNull();
    expect((await mint(owner.token, owner.network_id, "n_ownerless_fixture")).status).toBe(400);
  } finally { db.run("UPDATE api_tokens SET node_identity_epoch=1 WHERE token_id='owner678_ownerless'"); }
});

test("new name-only registration binds once and its holder can refresh with either shape", async () => {
  const first = await mint(member.token, owner.network_id, "refresh_fixture");
  expect(first.status).toBe(200);
  expect(db.get("SELECT node_identity_epoch FROM api_tokens WHERE token_id=?1", first.body.token_id).node_identity_epoch).toBe(2);
  const result = await call(first.body.token, "report_status", {
    resume_id: "refresh-fixture-session", alias: "refresh_fixture", status: "idle", node_id: "n_refresh_fixture",
  });
  // #3275 批次 2 —— 同变量口径，形状由一次真实调用给出：
  //   ["alias","inbox_count","ok","resume_id"]
  // 少一个 `inbox_count`，客户端就再也不知道「还有几条待办」——而它正是每轮心跳唯一的推送面；
  // 少一个 `alias`，多网络下的会话就认不出自己是谁。只断言 ok 时，这两个都能被悄悄删掉。
  expect(Object.keys(result).sort()).toEqual(["alias", "inbox_count", "ok", "resume_id"]);
  expect(result.ok).toBe(true);
  expect(db.get("SELECT bound_node_id FROM api_tokens WHERE token_id=?1", first.body.token_id).bound_node_id).toBe("n_refresh_fixture");
  expect(db.get("SELECT owner_user_id FROM nodes WHERE node_id='n_refresh_fixture'").owner_user_id).toBeNull();
  for (const id of [undefined, "n_refresh_fixture"]) {
    const refresh = await mint(member.token, owner.network_id, "refresh_fixture", id);
    expect(refresh.status).toBe(200);
    expect(refresh.body.node_id).toBe("n_refresh_fixture");
    expect((await call(refresh.body.token, "list_my_children")).ok).toBe(true);
  }
  expect((await mint(owner.token, owner.network_id, "refresh_fixture")).status).toBe(400);
});

test("fresh ID cannot mint another node alias", async () => {
  const before = db.get("SELECT COUNT(*) AS n FROM api_tokens").n;
  expect((await mint(member.token, owner.network_id, daemon, "n_fresh_impostor")).status).toBe(400);
  expect(db.get("SELECT node_id FROM nodes WHERE node_id='n_fresh_impostor'")).toBeNull();
  expect(db.get("SELECT COUNT(*) AS n FROM api_tokens").n).toBe(before);
  expect((await call(legacy, "list_my_children")).ok).toBe(true);
});

test("duplicate legacy aliases use bound IDs and an unbound token follows its owner", async () => {
  // Historical duplicate rows: the member's row was inserted first. Neither
  // lookup order nor alias can redirect an exact-bound token. An unbound
  // token resolves to the row its issuer owns.
  const { hashToken, generateNetworkToken } = await import("./db.js");
  const tokens: string[] = [];
  for (const [id, user] of [["n_duplicate_first", member.user.user_id], ["n_duplicate_owner", owner.user.user_id]]) {
    db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id) VALUES(?1,'duplicate_fixture','duplicate_fixture',?2,?3)", [id, owner.network_id, user]);
    const token = generateNetworkToken(); tokens.push(token);
    db.run("INSERT INTO api_tokens(token_id,token_hash,user_id,network_id,name,scope,bound_node_id) VALUES(?1,?2,?3,?4,'node:duplicate_fixture','network',?1)", [id, hashToken(token), user, owner.network_id]);
    db.run("INSERT INTO node_daemon_bindings(request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at) VALUES(?1,?2,?1,?1,'/fixture',?3,'pending',1,1)", [id, owner.network_id, user]);
  }
  for (let i = 0; i < tokens.length; i++) {
    const result = await call(tokens[i], "list_my_children");
    expect(result.ok).toBe(true);
    const ownId = i === 0 ? "n_duplicate_first" : "n_duplicate_owner";
    expect((await call(tokens[i], "get_adopt_request", { request_id: ownId })).ok).toBe(true);
    expect((await call(tokens[i], "get_adopt_request", { request_id: i === 0 ? "n_duplicate_owner" : "n_duplicate_first" })).ok).toBe(false);
  }
  db.run("UPDATE api_tokens SET bound_node_id=NULL WHERE token_id='n_duplicate_owner'");
  expect((await call(tokens[1], "list_my_children")).ok).toBe(true);
  expect((await call(tokens[1], "get_adopt_request", { request_id: "n_duplicate_owner" })).ok).toBe(true);
  expect((await call(tokens[1], "get_adopt_request", { request_id: "n_duplicate_first" })).ok).toBe(false);
  db.run("UPDATE api_tokens SET bound_node_id=NULL WHERE token_id='n_duplicate_first'");
  expect((await call(tokens[0], "list_my_children")).ok).toBe(true);
  expect((await call(tokens[0], "get_adopt_request", { request_id: "n_duplicate_first" })).ok).toBe(true);
  expect((await call(tokens[0], "get_adopt_request", { request_id: "n_duplicate_owner" })).ok).toBe(false);
  expect((await mint(owner.token, owner.network_id, "duplicate_fixture", "n_third_duplicate")).status).toBe(400);
});

test("all production token issuers explicitly mark the rollout epoch", () => {
  const root = `${import.meta.dir}/../..`;
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = `${dir}/${entry.name}`;
      return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });
  }
  const sourceFiles = ["server/src", "agent-network/src", "agent-network/bin", "agent-node/src"].flatMap(dir => sources(`${root}/${dir}`));
  let count = 0;
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/INSERT\s+INTO\s+api_tokens\s*\(([^)]+)\)/gi)) {
      expect(match[1]).toContain("node_identity_epoch"); count++;
    }
  }
  // Hub #938: clone_node mints a child ntok_ with node_identity_epoch=2,
  // the same column create_node already writes. 9 issuers → 10.
  expect(count).toBe(10);
  expect(readFileSync(`${root}/agent-network/bin/cli.ts`, "utf8")).toContain("'admin-reset', 'user', 1)");
});

test("revoked ownerless credential cannot be reclaimed by doctor and gives actionable guidance", async () => {
  db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE name='node:n_ownerless_fixture'");
  const result = await mint(member.token, owner.network_id, "n_ownerless_fixture");
  expect(result.status).toBe(400);
  expect(result.body.error).toBe("node_owner_mismatch");
  expect(nodeTokenReissueError(result.body)).toContain("这个节点没有归属，请联系管理员认领（#682）");
  expect(nodeTokenReissueError({ error: "node_owner_unclaimed" })).toContain("请联系管理员认领（#682）");
  expect(nodeTokenReissueError({ error: "network_not_found" })).toBe("network_not_found");
  expect(readFileSync(`${import.meta.dir}/../../agent-network/bin/cli.ts`, "utf8")).toContain("body ? nodeTokenReissueError(body) : r.status");
});
