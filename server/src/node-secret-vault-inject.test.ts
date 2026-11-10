// #3148 —— 保险库的值要能**流向**真正要用的那个进程，但任何人仍然**读不出来**。
//
// admin 2026-11-01 在客户端里撞到的死结：
//   密钥已经在保险库里了，可没有任何路径把它送到目标节点；
//   于是人只能把明文再复制一遍，或者写进工作区文件 —— 两条都比保险库更差。
//
// 本文件的判据分两半，缺一半就只是「加了个功能」：
//   ① 流向成立：owner/admin 只给键名，节点真的收到值（用节点侧 pull 来验，不靠内部字段）
//   ② 读权不成立：任何读接口都不回值（getScopedSecrets / ack 回来的 snapshot / 响应体本身）
import './require-explicit-test-db';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getScopedSecrets, pullNodeSecrets, ackNodeSecrets, requestNodeSecrets } from './scoped-secrets';
import { vaultUpsert, vaultListKeys, vaultDelete } from './vault';

const net = 'net_vaultinject';
const baseNode = 'n_vaultinject';
let node = baseNode;
const owner = 'u_vaultinject_owner';
const member = 'u_vaultinject_member';
const KEY = 'TMPAT';
const VALUE = 'pat-value-that-must-never-be-readable-0123456789';

function cleanup() {
  db.run('DELETE FROM nodes WHERE network_id=?1', [net]);
  db.run('DELETE FROM network_members WHERE network_id=?1', [net]);
  db.run('DELETE FROM networks WHERE network_id=?1', [net]);
  db.run('DELETE FROM users WHERE user_id IN (?1, ?2)', [owner, member]);
  for (const k of vaultListKeys(net)) vaultDelete(net, k);
}

function makeNode(name: string) {
  node = name;
  db.run('INSERT INTO nodes(node_id,node_name,alias,network_id,config_snapshot) VALUES(?1,?1,?1,?2,?3)',
    [node, net, JSON.stringify({ node_secrets_capable: true })]);
  return node;
}

beforeEach(() => {
  cleanup();
  node = baseNode;
  process.env.ANET_HUB_SECRET_VAULT_KEY = '43'.repeat(32);
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [owner]);
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [member]);
  db.run('INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)', [net, owner]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'owner')", [owner, net]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'member')", [member, net]);
  vaultUpsert(net, KEY, VALUE);
});
afterAll(cleanup);

const human = (userId: string) => ({ userId, isNode: false, networkId: net });
// 必须是函数：node 每个用例都不同，写成常量会把第一个用例的节点名焊死。
const asDaemon = () => ({ ok: true as const, networkId: net, daemonNodeId: node, daemonAlias: node });

/** 节点侧真正会收到的那个请求（不是内部字段：走 pullNodeSecrets 这条公开路径）。 */
function pulledFor(requestId: string) {
  const pulled = pullNodeSecrets(asDaemon()) as any;
  expect(pulled.ok).toBe(true);
  return (pulled.requests as any[]).find((r) => r.request_id === requestId);
}

describe("#3148 保险库 → 节点：值能流过去，但读不回来", () => {
  test("① 流向：owner 只给键名（from_vault），节点 pull 到的那条请求里带着保险库的值", () => {
    makeNode("n_vi_flow");
    const created = requestNodeSecrets(human(owner), node, 'put', KEY, undefined, 0, true) as any;
    expect(created.ok).toBe(true);
    const pulled = pulledFor(created.request_id);
    expect(pulled).toBeDefined();
    expect(pulled.action).toBe('put');
    expect(pulled.key).toBe(KEY);
    // 这一条是「值真的到了目标进程手上」——流向成立。
    expect(pulled.value).toBe(VALUE);
  });

  test("② 读权：ack 回来的回执里只有键名与来源，没有任何值", () => {
    makeNode("n_vi_ack");
    const created = requestNodeSecrets(human(owner), node, 'put', KEY, undefined, 0, true) as any;
    pulledFor(created.request_id);
    const ack = ackNodeSecrets(asDaemon(), created.request_id, {
      network_id: net, daemon_node_id: null, node_id: node, revision: 1, activation: 'next_start',
      keys: [{ key: KEY, source: 'node' }],
    }) as any;
    expect(ack.ok).toBe(true);
    expect(JSON.stringify(ack)).not.toContain(VALUE);
  });

  test("② 镜像否定：getScopedSecrets 的回执里没有值，也没有请求体里的明文", () => {
    makeNode("n_vi_noread");
    const created = requestNodeSecrets(human(owner), node, 'put', KEY, undefined, 0, true) as any;
    const got = getScopedSecrets(human(owner), created.request_id) as any;
    expect(got.ok).toBe(true);
    expect(JSON.stringify(got)).not.toContain(VALUE);
    expect(JSON.stringify(got)).not.toContain('"value"');
  });

  test("保险库里没有这个键 ⇒ vault_key_missing（不许回一个看起来成功的请求）", () => {
    makeNode("n_vi_missing");
    expect(requestNodeSecrets(human(owner), node, 'put', 'NOT_THERE', undefined, 0, true)).toEqual({
      ok: false, error: 'vault_key_missing',
    });
  });

  test("from_vault 只对 put 有意义：list / delete 用它是无效输入", () => {
    makeNode("n_vi_list");
    expect((requestNodeSecrets(human(owner), node, 'list', KEY, undefined, 0, true) as any).error).toBe('invalid_secret_input');
    expect((requestNodeSecrets(human(owner), node, 'delete', KEY, undefined, 0, true) as any).error).toBe('invalid_secret_input');
  });

  test("同时给 value 与 from_vault ⇒ 无效输入（两种来源不许混用，否则说不清写进去的是哪一个）", () => {
    makeNode("n_vi_mix");
    expect((requestNodeSecrets(human(owner), node, 'put', KEY, 'another-value', 0, true) as any).error).toBe('invalid_secret_input');
  });

  test("普通成员用 from_vault ⇒ secret_admin_required（这是权限边界，不是能力边界）", () => {
    makeNode("n_vi_member");
    expect((requestNodeSecrets(human(member), node, 'put', KEY, undefined, 0, true) as any).error).toBe('secret_admin_required');
  });

  test("节点令牌（isNode）自己调 ⇒ user_token_required（机器不能给自己发密钥）", () => {
    makeNode("n_vi_nodetoken");
    expect((requestNodeSecrets({ userId: null, isNode: true, networkId: net }, node, 'put', KEY, undefined, 0, true) as any)
      .error).toBe('user_token_required');
  });

  test("不支持的节点 ⇒ node_secrets_upgrade_required（先升级，不是先提权）", () => {
    makeNode("n_vi_oldnode");
    db.run('UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2', [JSON.stringify({}), node]);
    expect((requestNodeSecrets(human(owner), node, 'put', KEY, undefined, 0, true) as any).error)
      .toBe('node_secrets_upgrade_required');
  });
});
