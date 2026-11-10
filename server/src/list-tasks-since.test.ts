// #3119 —— list_tasks 的增量与「省掉 stats」。
//
// 生产实测（2026-11-05 近 6h）：list_tasks 占全部工具调用 **35.7%**，是最大的一格；
// 提示词只能劝，改不了接口成本。这里补两个参数，让轮询本身变便宜：
//   created_since  只取这之后创建的（空窗口回极短体）
//   omit_stats     跳过按状态的全表 GROUP BY（轮询时它比任务列表还贵）
//   server_time    服务端给水位，客户端别用本地时钟（差几秒就漏活或重复）
//
// 判据分四格，缺一格都只是「加了个参数」：
//   ① created_since 真的过滤（旧的看不见、新的看得见）
//   ② 镜像：不传 created_since ⇒ 行为与以前一致（旧调用方零影响）
//   ③ omit_stats 真的不返回 stats，且返回值里明确写着 stats_omitted
//   ④ server_time 一定在（两种分支都有），否则客户端拿不到水位
import './require-explicit-test-db';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { registerTools } from './tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const net = 'net_list_tasks_since';
const user = 'u_list_tasks_since';
// username 必须等于某个 nodes/sessions 的 alias，否则受限成员过滤会把任务全挡掉
const alias = user;

function client() {
  const handlers: Record<string, any> = {};
  const server = new McpServer({ name: 't-since', version: '0' }) as any;
  const tool = server.tool.bind(server);
  server.tool = (name: string, desc: any, shape: any, handler: any) => { handlers[name] = handler; return tool(name, desc, shape, handler); };
  registerTools(server, undefined, null, user, alias, false, null);
  return async (name: string, args: any = {}) => JSON.parse((await handlers[name](args)).content[0].text);
}

function cleanup() {
  db.run('DELETE FROM tasks WHERE task_id LIKE ?1', ['t_since_%']);
  db.run('DELETE FROM nodes WHERE network_id=?1', [net]);
  db.run('DELETE FROM network_members WHERE network_id=?1', [net]);
  db.run('DELETE FROM networks WHERE network_id=?1', [net]);
  db.run('DELETE FROM users WHERE user_id=?1', [user]);
}

beforeEach(() => {
  cleanup();
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [user]);
  db.run('INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)', [net, user]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'owner')", [user, net]);
  // caller 的 username 必须能被认成「本网络的 Agent」，否则 addAgentTimelineScope 会按
  // 受限成员把任务全过滤掉（那是安全边界，不是 bug）。建一行 nodes 让它认得出。
  db.run('INSERT INTO nodes(node_id,node_name,alias,network_id) VALUES(?1,?2,?2,?3)', ['n_since', alias, net]);
  // 两条任务：一条旧、一条新（时间列是 TEXT，字典序即时间序）
  db.run(`INSERT INTO tasks(task_id, from_name, to_name, status, content, created_at, network_id)
          VALUES ('t_since_old', 'peer', ?1, 'delivered', 'old work', '2026-11-05 01:00:00', ?2)`, [alias, net]);
  db.run(`INSERT INTO tasks(task_id, from_name, to_name, status, content, created_at, network_id)
          VALUES ('t_since_new', 'peer', ?1, 'delivered', 'new work', '2026-11-05 09:00:00', ?2)`, [alias, net]);
});
afterAll(cleanup);

describe("#3119 list_tasks 的增量与水印", () => {
  test("① created_since 生效：旧的看不见、新的看得见", async () => {
    const call = client();
    const r = await call('list_tasks', { alias, network_id: net, created_since: '2026-11-05 08:00:00', omit_stats: true, limit: 20 });
    expect(r.ok).toBe(true);
    expect(r.tasks.map((t: any) => t.task_id)).toEqual(['t_since_new']);
  });

  test("①b ISO 带 T/Z 传参也必须生效（字符串比较会在第 11 个字符判错）", async () => {
    const call = client();
    // 同一天的午夜：用 ISO 传，库里是 'YYYY-MM-DD HH:MM:SS'（空格）。
    // 直接字符串比较 ⇒ ' ' < 'T' ⇒ 库里那条被判成"更早" ⇒ 返回空。
    const r = await call('list_tasks', { alias, network_id: net, created_since: '2026-11-05T00:00:00Z', omit_stats: true, limit: 20 });
    expect(r.tasks.map((t: any) => t.task_id).sort()).toEqual(['t_since_new', 't_since_old']);
  });

  test("② 镜像：不传 created_since ⇒ 两条都在（旧调用方零影响）", async () => {
    const call = client();
    const r = await call('list_tasks', { alias, network_id: net, limit: 20 });
    expect(r.tasks.map((t: any) => t.task_id).sort()).toEqual(['t_since_new', 't_since_old']);
    expect(r.stats).toBeDefined();
  });

  test("③ omit_stats ⇒ 不返回 stats，并明确写 stats_omitted（不是静默少一格）", async () => {
    const call = client();
    const r = await call('list_tasks', { alias, network_id: net, omit_stats: true, limit: 20 });
    expect(r.stats).toBeUndefined();
    expect(r.stats_omitted).toBe(true);
  });

  test("④ 两种分支都带 server_time（客户端的水位来源）", async () => {
    const call = client();
    const a = await call('list_tasks', { alias, network_id: net, limit: 20 });
    const b = await call('list_tasks', { alias, network_id: net, omit_stats: true, limit: 20 });
    expect(typeof a.server_time).toBe('string');
    expect(typeof b.server_time).toBe('string');
    expect(Number.isNaN(Date.parse(a.server_time))).toBe(false);
  });

  test("空窗口 ⇒ 短响应（tasks 空、无 stats、仍有 server_time）", async () => {
    const call = client();
    const r = await call('list_tasks', { alias, network_id: net, created_since: '2099-01-01 00:00:00', omit_stats: true, limit: 20 });
    expect(r.tasks).toEqual([]);
    expect(r.count).toBe(0);
    expect(typeof r.server_time).toBe('string');
  });
});
