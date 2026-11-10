// admin 2026-11-10「fork 到新目录」走 clone_node(new_empty)。两条 Hub 侧前提：
//   ① 被 daemon **收编**（adopt）的节点也是它的子节点 —— 此前只认 succeeded 的
//      create 行，收编节点（vdev 上 35 个里的 31 个）一律 source_not_daemon_child；
//   ② 克隆出来的节点落在源节点的部门（与 source fork #3485 同一条规则），
//      已被人显式放过部门的不覆盖。
import './require-explicit-test-db';
import './departments';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { db } from './db';
import { adoptedCloneSourceRow } from './node-daemon-bindings';
import { finalizeCreateOnFirstRegister } from './create-node';
import { factsFromRows } from './clone-node';

const NET = 'net_clone_adopted';
const DAEMON = 'node_daemon_clone_adopted';

function cleanup() {
  db.run('DELETE FROM node_daemon_bindings WHERE network_id = ?1', [NET]);
  db.run('DELETE FROM node_create_requests WHERE network_id = ?1', [NET]);
  db.run('DELETE FROM nodes WHERE network_id = ?1', [NET]);
}
beforeEach(cleanup);
afterAll(cleanup);

function node(id: string, dept: string | null) {
  db.run('INSERT INTO nodes(node_id,node_name,alias,network_id,department_id) VALUES(?1,?1,?1,?2,?3)', [id, NET, dept]);
}
function binding(nodeId: string, status: string) {
  db.run(`INSERT INTO node_daemon_bindings(request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at)
    VALUES(?1,?2,?3,?4,'/srv/ws/x','u_test',?5,1,1)`, [`adopt_${nodeId}_${status}`, NET, nodeId, DAEMON, status]);
}

test('an actively adopted node is a clone source on its daemon; refused/revoked/none are not', () => {
  binding('n_adopted', 'active');
  expect(adoptedCloneSourceRow('n_adopted', NET, 'opencode-cli', 'n_adopted')).toEqual({
    daemon_node_id: DAEMON, runtime: 'opencode-cli', model: null, flags_json: '{}', child_name: 'n_adopted',
  });
  binding('n_refused', 'refused');
  expect(adoptedCloneSourceRow('n_refused', NET, 'opencode-cli', 'n_refused')).toBeUndefined();
  expect(adoptedCloneSourceRow('n_none', NET, 'opencode-cli', 'n_none')).toBeUndefined();
  // Another network's binding never counts.
  expect(adoptedCloneSourceRow('n_adopted', 'net_other', 'opencode-cli', 'n_adopted')).toBeUndefined();
});

test('a clone inherits the source department on first register; explicit placement wins', () => {
  node('n_src', 'dept_tma');
  node('n_clone', null);
  node('n_placed', 'dept_elsewhere');
  node('n_plain', null);
  const seed = (id: string, name: string, clone: object | null) => db.run(
    `INSERT INTO node_create_requests
       (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, created_at, created_by_token, clone_json)
     VALUES (?1, ?2, ?3, ?4, 'opencode-cli', NULL, '{}', '[]', 'pending', ?5, 'tok_test', ?6)`,
    [id, DAEMON, name, NET, Date.now(), clone ? JSON.stringify(clone) : null]);
  seed('cr_clone', 'n_clone', { source_node_id: 'n_src', source_alias: 'n_src', workdir_policy: 'new_empty' });
  seed('cr_placed', 'n_placed', { source_node_id: 'n_src', source_alias: 'n_src', workdir_policy: 'new_empty' });
  seed('cr_plain', 'n_plain', null);
  for (const id of ['n_clone', 'n_placed', 'n_plain']) {
    expect(finalizeCreateOnFirstRegister({ node_id: id, alias: id, network_id: NET }).finalized).toBe(1);
  }
  const dept = (id: string) => db.get<{ department_id: string | null }>('SELECT department_id FROM nodes WHERE node_id=?1', id)?.department_id ?? null;
  expect(dept('n_clone')).toBe('dept_tma');
  expect(dept('n_placed')).toBe('dept_elsewhere');
  // An ordinary create (no clone_json) is untouched.
  expect(dept('n_plain')).toBeNull();
});

test('an OpenCode node reporting the "opencode-sdk" label clones as opencode-cli (vdev 2026-11-11)', () => {
  const facts = (runtime: string | null, snapRuntime?: string) => factsFromRows({
    node: { node_id: 'n_oc', alias: 'n_oc', runtime, config_snapshot: snapRuntime ? JSON.stringify({ runtime: snapRuntime }) : null },
    createRow: null, existingNames: [], inflightNames: [],
  }).runtime;
  expect(facts('opencode-sdk')).toBe('opencode-cli');
  expect(facts('opencode')).toBe('opencode-cli');
  expect(facts(null, 'opencode-sdk')).toBe('opencode-cli');
  expect(facts('opencode-cli')).toBe('opencode-cli');
  expect(facts('claude-code-cli')).toBe('claude-code-cli');
});
