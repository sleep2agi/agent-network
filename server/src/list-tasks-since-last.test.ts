// #3943 —— since_last：服务端水位，让「自上次以来新增」不需要客户端记时间。
//
// 为什么在服务端存而不是让调用方传：提示词那一招对本项无效（实测占比 19.1% → 50.3%），
// 而「记住上次返回的 server_time」是个状态，让每个调用方各自记，就必然有人记错或忘。
//
// 判据五格：
//   ① 首次调用无水位 ⇒ 全量，且 since_from=null（不假装有水位）
//   ② 再调一次 + 中间插入一条 ⇒ 只回那一条
//   ③ 镜像：不传 since_last ⇒ 行为与 .268 逐字一致，且**不写**水位
//   ④ 水位按 (network, caller) 隔离：A 调用者的水位不影响 B
//   ⑤ since_last 与 created_since 同时给 ⇒ 明确报错（两个下界不混用）
import './require-explicit-test-db';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { registerTools } from './tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const net = 'net_wm';
const userA = 'u_wm_a';
const userB = 'u_wm_b';

function client(username: string) {
  const handlers: Record<string, any> = {};
  const server = new McpServer({ name: 't-wm', version: '0' }) as any;
  const tool = server.tool.bind(server);
  server.tool = (name: string, desc: any, shape: any, handler: any) => { handlers[name] = handler; return tool(name, desc, shape, handler); };
  registerTools(server, undefined, null, username, username, false, null);
  return async (name: string, args: any = {}) => JSON.parse((await handlers[name](args)).content[0].text);
}

const insertTask = (id: string, toName: string, createdAt: string) => db.run(
  `INSERT INTO tasks(task_id, from_name, to_name, status, content, created_at, network_id)
   VALUES (?1, 'peer', ?2, 'delivered', 'work', ?3, ?4)`, [id, toName, createdAt, net]);

function cleanup() {
  db.run("DELETE FROM tasks WHERE task_id LIKE 't_wm_%'");
  db.run('DELETE FROM list_tasks_watermarks WHERE network_id=?1', [net]);
  db.run('DELETE FROM nodes WHERE network_id=?1', [net]);
  db.run('DELETE FROM network_members WHERE network_id=?1', [net]);
  db.run('DELETE FROM networks WHERE network_id=?1', [net]);
  db.run('DELETE FROM users WHERE user_id IN (?1, ?2)', [userA, userB]);
}

beforeEach(() => {
  cleanup();
  for (const u of [userA, userB]) {
    db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [u]);
    db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'owner')", [u, net]);
    // username 必须等于某 nodes/sessions 的 alias，否则受限成员过滤会把任务全挡掉
    db.run('INSERT INTO nodes(node_id,node_name,alias,network_id) VALUES(?1,?2,?2,?3)', [`n_${u}`, u, net]);
  }
  db.run('INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)', [net, userA]);
  insertTask('t_wm_1', userA, '2026-11-05 01:00:00');
  insertTask('t_wm_2', userB, '2026-11-05 01:00:00');
});
afterAll(cleanup);

describe("#3943 list_tasks since_last（服务端水位）", () => {
  test("① 首次调用无水位 ⇒ 全量，且 since_from=null", async () => {
    const call = client(userA);
    const r = await call('list_tasks', { alias: userA, network_id: net, since_last: true, omit_stats: true, limit: 20 });
    expect(r.ok).toBe(true);
    expect(r.tasks.map((t: any) => t.task_id)).toEqual(['t_wm_1']);
    expect(r.since_from).toBeNull();
    expect(typeof r.since_to).toBe('string');
  });

  test("② 中间插入一条 ⇒ 第二次只回它（旧的不再出现）", async () => {
    const call = client(userA);
    await call('list_tasks', { alias: userA, network_id: net, since_last: true, omit_stats: true, limit: 20 });
    insertTask('t_wm_new', userA, '2099-01-01 00:00:00');
    const r = await call('list_tasks', { alias: userA, network_id: net, since_last: true, omit_stats: true, limit: 20 });
    expect(r.tasks.map((t: any) => t.task_id)).toEqual(['t_wm_new']);
    expect(typeof r.since_from).toBe('string');
  });

  test("③ 镜像：不传 since_last ⇒ 全量、且**不写**水位", async () => {
    const call = client(userA);
    const r = await call('list_tasks', { alias: userA, network_id: net, omit_stats: true, limit: 20 });
    expect(r.since_from).toBeUndefined();
    const rows = db.all("SELECT network_id FROM list_tasks_watermarks WHERE network_id=?1", [net]);
    expect(rows.length).toBe(0);
  });

  test("④ 水位按 (network, caller) 隔离：B 的水位不影响 A", async () => {
    const a = client(userA), b = client(userB);
    await a('list_tasks', { alias: userA, network_id: net, since_last: true, omit_stats: true, limit: 20 });
    const rb = await b('list_tasks', { alias: userB, network_id: net, since_last: true, omit_stats: true, limit: 20 });
    // B 是首次 ⇒ 全量（自己的任务），不能因为 A 已经有了水位就变成空
    expect(rb.tasks.map((t: any) => t.task_id)).toEqual(['t_wm_2']);
    expect(rb.since_from).toBeNull();
  });

  test("⑤ since_last 与 created_since 同时给 ⇒ 明确报错（两个下界不混用）", async () => {
    const call = client(userA);
    const r = await call('list_tasks', { alias: userA, network_id: net, since_last: true, created_since: '2026-11-05 00:00:00', omit_stats: true, limit: 20 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('created_since_and_since_last_are_exclusive');
  });
});
