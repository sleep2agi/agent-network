// #3119 —— 节点令牌没传 omit_stats 时，默认省略 stats。
//
// 为什么不给 since_last 设默认（同样重要，写在这里免得后来人"顺手"加上）：
//   list_tasks 同时被用来回答「我手上有哪些活」—— 那是个**全集**问题。
//   默认 since_last 会让「早就派给我、一直没动」的任务消失，节点据此得出「没活」。
//   那是把一个成本问题换成一个正确性问题，不划算。
//
// 判据三格：
//   ① 节点令牌 + 不传 omit_stats ⇒ 没有 stats，且 stats_omitted:true
//   ② 节点令牌 + 显式 false ⇒ stats 回来（默认不是强制）
//   ③ 用户令牌 + 不传 ⇒ 与以前一致（有 stats）—— 看板要计数
import './require-explicit-test-db';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { registerTools } from './tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const net = 'net_omit_defaults';
const nodeUser = 'u_omit_node';
const humanUser = 'u_omit_human';

function client(opts: { username: string; isNode: boolean }) {
  const handlers: Record<string, any> = {};
  const server = new McpServer({ name: 't-omit', version: '0' }) as any;
  const tool = server.tool.bind(server);
  server.tool = (name: string, desc: any, shape: any, handler: any) => { handlers[name] = handler; return tool(name, desc, shape, handler); };
  registerTools(server, undefined, opts.isNode ? net : null, opts.username, opts.username, opts.isNode, opts.isNode ? 'tok_omit' : null);
  return async (name: string, args: any = {}) => JSON.parse((await handlers[name](args)).content[0].text);
}

function cleanup() {
  db.run("DELETE FROM tasks WHERE task_id LIKE 't_omit_%'");
  db.run('DELETE FROM list_tasks_watermarks WHERE network_id=?1', [net]);
  db.run('DELETE FROM nodes WHERE network_id=?1', [net]);
  db.run('DELETE FROM network_members WHERE network_id=?1', [net]);
  db.run('DELETE FROM api_tokens WHERE network_id=?1', [net]);
  db.run('DELETE FROM networks WHERE network_id=?1', [net]);
  db.run('DELETE FROM users WHERE user_id IN (?1, ?2)', [nodeUser, humanUser]);
}

beforeEach(() => {
  cleanup();
  for (const u of [nodeUser, humanUser]) {
    db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [u]);
    db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'owner')", [u, net]);
    db.run('INSERT INTO nodes(node_id,node_name,alias,network_id) VALUES(?1,?2,?2,?3)', [`n_${u}`, u, net]);
  }
  db.run('INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)', [net, humanUser]);
  // 节点令牌：network token + bound_node_id，这样 callerTokenIsNetwork 路径成立
  db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash,bound_node_id) VALUES('tok_omit',?1,?2,'network','node',?3,?4)",
    [nodeUser, net, 'hash_omit', `n_${nodeUser}`]);
  db.run(`INSERT INTO tasks(task_id, from_name, to_name, status, content, created_at, network_id)
          VALUES ('t_omit_1', 'peer', ?1, 'delivered', 'work', '2026-11-05 01:00:00', ?2)`, [nodeUser, net]);
});
afterAll(cleanup);

describe("#3119 节点令牌默认省略 stats", () => {
  test("① 节点令牌 + 不传 ⇒ 无 stats，且明确 stats_omitted", async () => {
    const call = client({ username: nodeUser, isNode: true });
    const r = await call('list_tasks', { alias: nodeUser, network_id: net, limit: 20 });
    expect(r.ok).toBe(true);
    expect(r.stats).toBeUndefined();
    expect(r.stats_omitted).toBe(true);
  });

  test("② 节点令牌 + 显式 false ⇒ stats 回来（默认不是强制）", async () => {
    const call = client({ username: nodeUser, isNode: true });
    const r = await call('list_tasks', { alias: nodeUser, network_id: net, limit: 20, omit_stats: false });
    expect(Array.isArray(r.stats)).toBe(true);
  });

  test("③ 用户令牌 + 不传 ⇒ 与以前一致（有 stats）", async () => {
    const call = client({ username: humanUser, isNode: false });
    const r = await call('list_tasks', { alias: humanUser, network_id: net, limit: 20 });
    expect(Array.isArray(r.stats)).toBe(true);
  });

  test("镜像否定：节点令牌默认**不**启用 since_last（否则「早就派给我」的任务会消失）", async () => {
    const call = client({ username: nodeUser, isNode: true });
    const r = await call('list_tasks', { alias: nodeUser, network_id: net, limit: 20 });
    expect(r.since_from).toBeUndefined();
    expect(r.tasks.map((t: any) => t.task_id)).toContain('t_omit_1');
  });
});
