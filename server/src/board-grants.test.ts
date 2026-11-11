// 第二期·任务看板（board）的判定口径。
//
// 与 schedules **不同**（别混）：
//   schedules 按「目标节点所在部门」判；
//   board    按「**卡的负责人所在部门**」判 —— 卡没有目标节点，只有 owner（人）/ agent_owner（节点）。
// 这里钉住四件事：network 范围命中任何卡、department 范围按负责人部门（含子树）、
// node 范围只命中 agent_owner 就是那个节点的卡、readonly 模式下 edit 降 read。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import "./departments.js";  // 建 network_departments（该表的 DDL 在 departments.ts，不在 db.ts）
import { boardGrantForCard, cardDepartments } from "./node-grants.js";

const NET = `net_board_${Date.now()}`;
const DEPT_PARENT = `dept_bp_${Date.now()}`;
const DEPT_CHILD = `dept_bc_${Date.now()}`;
const DEPT_OTHER = `dept_bo_${Date.now()}`;
const U_IN = `${NET}_u_in`, U_OUT = `${NET}_u_out`, U_PARENT = `${NET}_u_parent`;
const N_GRANTED = `node_granted_${NET}`, N_CARD = `node_card_${NET}`, N_OTHER = `node_other_${NET}`;

const userJson = (id: string) => JSON.stringify({ kind: "user", id });
const nodeJson = (id: string) => JSON.stringify({ kind: "node", id });

beforeAll(() => {
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, U_PARENT]);
  for (const [id, dept] of [[U_PARENT, DEPT_PARENT], [U_IN, DEPT_CHILD], [U_OUT, DEPT_OTHER]] as const) {
    db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))`, [id]);
    db.run("INSERT INTO network_members (user_id, network_id, role, department_id, joined_at) VALUES (?1, ?2, 'member', ?3, datetime('now'))", [id, NET, dept]);
  }
  for (const [id, dept] of [[DEPT_PARENT, null], [DEPT_CHILD, DEPT_PARENT], [DEPT_OTHER, null]] as const) {
    db.run("INSERT INTO network_departments (department_id, network_id, name, parent_id, sort, created_at) VALUES (?1, ?2, ?1, ?3, 0, datetime('now'))", [id, NET, dept]);
  }
  for (const [id, dept] of [[N_GRANTED, DEPT_OTHER], [N_CARD, DEPT_CHILD], [N_OTHER, DEPT_OTHER]] as const) {
    db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, department_id, created_at) VALUES (?1, ?1, ?1, ?2, ?3, datetime('now'))", [id, NET, dept]);
  }
});

afterAll(() => {
  try { db.run("DELETE FROM node_grants WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_departments WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id LIKE ?1", [`${NET}%`]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
});

const grant = (scope_kind: string, scope_id: string, level: string) =>
  db.run(
    "INSERT INTO node_grants (network_id, node_id, capability, scope_kind, scope_id, level, granted_by, created_at) VALUES (?1, ?2, 'board', ?3, ?4, ?5, ?6, datetime('now'))",
    [NET, N_GRANTED, scope_kind, scope_id, level, U_PARENT],
  );

describe("board 判定：按卡的负责人所在部门", () => {
  test("卡属于哪些部门：owner 人的部门 + agent_owner 节点的部门", () => {
    expect([...cardDepartments(NET, { owner_json: userJson(U_IN) })]).toEqual([DEPT_CHILD]);
    expect([...cardDepartments(NET, { owner_json: null, agent_owner_json: nodeJson(N_CARD) })]).toEqual([DEPT_CHILD]);
    expect([...cardDepartments(NET, { owner_json: userJson(U_OUT) })]).toEqual([DEPT_OTHER]);
  });

  test("没有授权 → null（不许默认放行）", () => {
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: userJson(U_IN) })).toBeNull();
  });

  test("department=父部门 ⇒ 子部门的卡也算（子树）", () => {
    grant("department", DEPT_PARENT, "read");
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: userJson(U_IN) })).toBe("read");
  });

  test("不在授权部门子树里的卡 → null", () => {
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: userJson(U_OUT), agent_owner_json: null })).toBeNull();
  });

  test("edit 授权 + readonly 模式 ⇒ 降为 read", () => {
    db.run("DELETE FROM node_grants WHERE network_id = ?1", [NET]);
    grant("department", DEPT_PARENT, "edit");
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: userJson(U_IN) })).toBe("edit");
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: userJson(U_IN) }, "readonly")).toBe("read");
  });

  test("node 范围只命中 agent_owner 就是该节点的卡", () => {
    db.run("DELETE FROM node_grants WHERE network_id = ?1", [NET]);
    grant("node", N_OTHER, "edit");
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: userJson(U_IN), agent_owner_json: nodeJson(N_OTHER) })).toBe("edit");
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: userJson(U_IN), agent_owner_json: nodeJson(N_CARD) })).toBeNull();
  });

  test("network 范围命中任何卡", () => {
    db.run("DELETE FROM node_grants WHERE network_id = ?1", [NET]);
    grant("network", NET, "read");
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: userJson(U_OUT) })).toBe("read");
    // 没有任何负责人的卡也归全网授权管（不是「默认放行」——是 network 范围本来覆盖全部卡）
    expect(boardGrantForCard(NET, N_GRANTED, { owner_json: null })).toBe("read");
  });
});
