// #3432 —— 部门维度授权：把「人的组织架构」当授权单位。
//
// 用户问的是「给某个用户授权，让他看到某个组织架构下的所有节点」。
// 此前只有三档：all / 逐 Agent / Agent 组 —— 前两档都不回答这个问题，
// 第三档是 **Agent 侧**的树，而人的组织架构是另一条轴（network_departments + nodes.department_id）。
//
// 判据分两半，缺一半就只是「能写进去」：
//   ① 能看到：授权部门 D ⇒ D 与全部下级部门里的节点可见（含下级，这才是「组织架构下」）
//   ② 不该看到的看不到：没填部门的节点、别的部门的节点，都不出现（镜像否定）
import './require-explicit-test-db';
// network_departments 是在 departments.ts 的模块顶层建的（不是 db.ts）。
// 不把这个 import 放进来，测试会直接报 no such table —— 而生产是因为 server.ts 导入了它。
import './departments';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  departmentGrantNodes,
  visibleAgents,
  replaceAgentGrants,
  listDepartmentGrants,
  departmentCoverage,
} from './agent-access';

const net = 'net_deptgrant';
const user = 'u_deptgrant';
const actor = 'u_deptgrant_actor';
const root = 'd_root';
const child = 'd_child';
const other = 'd_other';

function cleanup() {
  for (const t of ['network_member_agent_grants', 'network_member_group_grants', 'network_member_department_grants']) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [net]); } catch {}
  }
  db.run('DELETE FROM nodes WHERE network_id = ?1', [net]);
  db.run('DELETE FROM network_departments WHERE network_id = ?1', [net]);
  db.run('DELETE FROM network_members WHERE network_id = ?1', [net]);
  db.run('DELETE FROM networks WHERE network_id = ?1', [net]);
  db.run('DELETE FROM users WHERE user_id IN (?1, ?2)', [user, actor]);
}

beforeEach(() => {
  cleanup();
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [user]);
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [actor]);
  db.run('INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)', [net, actor]);
  db.run("INSERT INTO network_members(user_id,network_id,role,agent_access) VALUES(?1,?2,'member','granted')", [user, net]);
  db.run("INSERT INTO network_members(user_id,network_id,role,agent_access) VALUES(?1,?2,'owner','all')", [actor, net]);
  // 三棵子树：root(父) → child(子)；另一棵 other。
  for (const [id, parent] of [[root, null], [child, root], [other, null]] as const) {
    db.run('INSERT INTO network_departments(network_id,department_id,name,parent_id) VALUES(?1,?2,?2,?3)', [net, id, parent]);
  }
  const node = (id: string, dept: string | null) => db.run(
    'INSERT INTO nodes(node_id,node_name,alias,network_id,department_id) VALUES(?1,?1,?1,?2,?3)', [id, net, dept]);
  node('n_root_direct', root);
  node('n_child_member', child);   // 下级部门里的节点
  node('n_other_dept', other);
  node('n_no_dept', null);         // 没填部门：永远不该因部门授权而可见
});
afterAll(cleanup);

const grantDept = (deptId: string, canMessage = true) => replaceAgentGrants({
  networkId: net, userId: user, grants: [], actorUserId: actor,
  departmentGrants: [{ department_id: deptId, can_message: canMessage }],
});

describe("#3432 部门维度授权", () => {
  test("① 授权部门 root ⇒ root 自己与**下级** child 里的节点都可见", () => {
    const r = grantDept(root);
    expect(r.ok).toBe(true);
    const ids = departmentGrantNodes(net, user).map((g) => g.node_id).sort();
    expect(ids).toEqual(['n_child_member', 'n_root_direct']);
    const visible = visibleAgents(user, net);
    expect(visible.nodeIds.sort()).toEqual(['n_child_member', 'n_root_direct']);
  });

  test("② 镜像否定：没填部门的节点、别的部门的节点都不出现", () => {
    grantDept(root);
    const ids = departmentGrantNodes(net, user).map((g) => g.node_id);
    expect(ids).not.toContain('n_no_dept');
    expect(ids).not.toContain('n_other_dept');
  });

  test("can_message 随部门授权传递；一处 false 不影响另一处 true（取并集）", () => {
    replaceAgentGrants({
      networkId: net, userId: user, grants: [], actorUserId: actor,
      departmentGrants: [{ department_id: root, can_message: false }, { department_id: other, can_message: true }],
    });
    const byId = new Map(departmentGrantNodes(net, user).map((g) => [g.node_id, g.can_message]));
    expect(byId.get('n_root_direct')).toBe(false);
    expect(byId.get('n_other_dept')).toBe(true);
  });

  test("撤掉授权 ⇒ 立刻看不见（现算，不留缓存）", () => {
    grantDept(root);
    expect(departmentGrantNodes(net, user).length).toBe(2);
    grantDept('') /* 非法，整批拒绝 */;
    replaceAgentGrants({ networkId: net, userId: user, grants: [], actorUserId: actor, departmentGrants: [] });
    expect(departmentGrantNodes(net, user)).toEqual([]);
  });

  test("部门里新挂的节点，下一次请求就可见（与组授权同一语义）", () => {
    grantDept(root);
    db.run('INSERT INTO nodes(node_id,node_name,alias,network_id,department_id) VALUES(?1,?1,?1,?2,?3)',
      ['n_new_in_child', net, child]);
    expect(departmentGrantNodes(net, user).map((g) => g.node_id)).toContain('n_new_in_child');
  });

  test("不在本网络的部门 ⇒ department_not_in_network（不静默忽略）", () => {
    const r = replaceAgentGrants({
      networkId: net, userId: user, grants: [], actorUserId: actor,
      departmentGrants: [{ department_id: 'd_does_not_exist' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('department_not_in_network');
  });

  test("listDepartmentGrants 带出部门名；coverage 把「没填部门」明说出来", () => {
    grantDept(root);
    expect(listDepartmentGrants(net, user)).toEqual([{ department_id: root, name: root, can_message: true }]);
    expect(departmentCoverage(net)).toEqual({ nodes_total: 4, nodes_with_department: 3, nodes_without_department: 1 });
  });

  test("传 undefined 时不清空已有部门授权（旧客户端的 PUT 不带这个键）", () => {
    grantDept(root);
    replaceAgentGrants({ networkId: net, userId: user, grants: [], actorUserId: actor });
    expect(listDepartmentGrants(net, user).length).toBe(1);
  });
});
