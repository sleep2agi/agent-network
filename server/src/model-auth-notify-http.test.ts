// #462 —— 节点模型登录失效 → 通知节点主人一次。
//
// 钉住:
//   1. 翻转判定(纯函数):进入 revoked/expired 发一次;坏→坏不再发(含 revoked⇄expired);回到 ok 才重新上膛;
//      unknown / 没报既不发也不上膛。
//   2. 真 report_status(节点令牌):ok→expired→expired→ok→expired = 恰好 2 条,只给节点主人;
//      网络 owner 和别的成员 0 条。正文带别名、原因、`codex login` 修法,不教人拷别人的 auth.json。
//   3. 别的节点 / 用户令牌替它报坏状态 → 不发(与 #448 同一条「只有本节点令牌能替自己说健康」)。
//   4. Hub 重启(内存标记清空)后第一眼看到坏状态:主人还有没读的同类消息 → 不再发;读过了 → 发。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/model-auth-notify-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { clearNodeHealthStore } from "./node-health-store.js";
import { __resetModelAuthNoticesForTest, decideModelAuthNotice, MODEL_AUTH_NOTICE_KIND, modelAuthNoticeText } from "./model-auth-notify.js";

const dir = mkdtempSync(join(tmpdir(), "anet-model-auth-notify-"));
const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("model-auth-notify requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const PW = "ModelAuthNotify123!";
const stamp = Date.now();
const NODE = `ma-node-${stamp}`;
const NODE_ID = `n_ma_node_${stamp}`;
const PEER = `ma-peer-${stamp}`;
const PEER_ID = `n_ma_peer_${stamp}`;
let netId = "";
let bossId = "", noraId = "", ottoId = "";
let nodeTokenId = "", peerTokenId = "";

async function connectAs(alias: string, userId: string, tokenId: string, isNetworkToken = true) {
  const s = new McpServer({ name: "model-auth-notify", version: "1" });
  registerTools(s, undefined, netId, userId, alias, isNetworkToken, tokenId);
  const client = new Client({ name: "model-auth-notify-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st);
  await client.connect(ct);
  const report = async (model_auth: string | undefined, asAlias = NODE, nodeId = NODE_ID) => {
    const r: any = await client.callTool({
      name: "report_status",
      arguments: { resume_id: `sdk-${nodeId}`, alias: asAlias, status: "idle", node_id: nodeId, network_id: netId, health: { bridge: "ok", ...(model_auth ? { model_auth } : {}) } },
    });
    expect(r.isError === true).toBe(false);
  };
  return { report, close: async () => { await client.close(); await s.close(); } };
}

const notices = (userId: string) => db.all<{ message_id: string; from_session: string; title: string; content: string; severity: string; meta_json: string; acked: number }>(
  "SELECT message_id, from_session, title, content, severity, meta_json, acked FROM user_inbox WHERE user_id = ?1 AND network_id = ?2 AND kind = ?3 ORDER BY created_at, message_id",
  userId, netId, MODEL_AUTH_NOTICE_KIND,
);
const clearNotices = () => db.run("DELETE FROM user_inbox WHERE network_id = ?1 AND kind = ?2", [netId, MODEL_AUTH_NOTICE_KIND]);

beforeAll(() => {
  process.env.COMMHUB_UPLOADS_DIR = join(dir, "uploads");
  const boss = register(`ma_boss_${stamp}`, PW);
  expect(boss.ok).toBe(true);
  bossId = boss.user!.user_id; netId = boss.network_id!;
  const nora = register(`ma_nora_${stamp}`, PW);
  const otto = register(`ma_otto_${stamp}`, PW);
  noraId = nora.user!.user_id; ottoId = otto.user!.user_id;
  addNetworkMember(netId, noraId, "member", bossId, { agentAccess: "all" });
  addNetworkMember(netId, ottoId, "member", bossId, { agentAccess: "all" });
  // 节点主人是 nora(她铸的节点令牌 → nodes.owner_user_id),不是网络 owner boss。
  const minted = createNetworkTokenForNode(noraId, netId, NODE, NODE_ID);
  expect(minted.ok).toBe(true);
  nodeTokenId = minted.token_id!;
  const peer = createNetworkTokenForNode(ottoId, netId, PEER, PEER_ID);
  expect(peer.ok).toBe(true);
  peerTokenId = peer.token_id!;
});
beforeEach(() => { __resetModelAuthNoticesForTest(); clearNodeHealthStore(); clearNotices(); });
afterAll(() => { clearNotices(); __resetModelAuthNoticesForTest(); clearNodeHealthStore(); });

describe("#462 transition logic", () => {
  test("bad once per entry, re-armed only by ok", () => {
    const seq: Array<Parameters<typeof decideModelAuthNotice>[1]> = ["ok", "expired", "expired", "revoked", "unknown", undefined, "expired", "ok", "unknown", "revoked", "revoked"];
    let mark: ReturnType<typeof decideModelAuthNotice>["mark"];
    const fired: boolean[] = [];
    for (const s of seq) { const d = decideModelAuthNotice(mark, s); fired.push(d.notify); mark = d.mark; }
    expect(fired).toEqual([false, true, false, false, false, false, false, false, false, true, false]);
  });

  test("first sight is bad → notify; unknown/missing never arms", () => {
    expect(decideModelAuthNotice(undefined, "revoked")).toEqual({ notify: true, mark: "notified" });
    expect(decideModelAuthNotice(undefined, "unknown")).toEqual({ notify: false, mark: undefined });
    expect(decideModelAuthNotice("notified", "unknown")).toEqual({ notify: false, mark: "notified" });
    expect(decideModelAuthNotice("notified", undefined)).toEqual({ notify: false, mark: "notified" });
    expect(decideModelAuthNotice("notified", "ok")).toEqual({ notify: false, mark: "armed" });
  });

  test("text names the node, the cause and the per-node re-login; never says to copy credentials", () => {
    for (const s of ["revoked", "expired"] as const) {
      const { title, text } = modelAuthNoticeText("node-a", s);
      expect(title).toBe("节点登录失效");
      expect(text).toContain("节点 node-a");
      expect(text).toContain("codex login");
      expect(text).toContain("CODEX_HOME=");
      expect(text).toContain("不要拷别的节点的 auth.json");
    }
    expect(modelAuthNoticeText("node-a", "revoked").text).toContain("作废");
    expect(modelAuthNoticeText("node-a", "expired").text).toContain("过期");
  });
});

describe("#462 report_status → owner notice", () => {
  test("ok → expired → expired → ok → expired = exactly 2 notices, owner only", async () => {
    const n = await connectAs(NODE, noraId, nodeTokenId);
    try {
      for (const s of ["ok", "expired", "expired", "ok", "expired"]) await n.report(s);
    } finally { await n.close(); }
    const mine = notices(noraId);
    expect(mine.length).toBe(2);
    for (const m of mine) {
      expect(m.from_session).toBe(NODE);
      expect(m.title).toBe("节点登录失效");
      expect(m.severity).toBe("warning");
      expect(m.content).toContain(`节点 ${NODE}`);
      expect(m.content).toContain("codex login");
      expect(JSON.parse(m.meta_json)).toEqual({ model_auth_notice: { alias: NODE, state: "expired" } });
    }
    expect(notices(bossId).length).toBe(0);
    expect(notices(ottoId).length).toBe(0);
  });

  test("a node that only ever reports ok / unknown / nothing gets no notice", async () => {
    const n = await connectAs(NODE, noraId, nodeTokenId);
    try {
      for (const s of ["unknown", "ok", undefined, "unknown", "ok"]) await n.report(s);
    } finally { await n.close(); }
    expect(notices(noraId).length).toBe(0);
  });

  test("another node or a user login cannot trigger a notice for this node", async () => {
    const p = await connectAs(PEER, ottoId, peerTokenId);
    try { await p.report("revoked", NODE, NODE_ID); } finally { await p.close(); }
    const u = await connectAs("", bossId, "", false);
    try { await u.report("revoked", NODE, NODE_ID); } finally { await u.close(); }
    expect(notices(noraId).length).toBe(0);
    expect(notices(bossId).length).toBe(0);
    expect(notices(ottoId).length).toBe(0);
  });

  test("hub restart: an unread notice suppresses the repeat; once read, the next sight notifies", async () => {
    const n = await connectAs(NODE, noraId, nodeTokenId);
    try {
      await n.report("revoked");
      expect(notices(noraId).length).toBe(1);
      __resetModelAuthNoticesForTest(); // = Hub 重启,内存标记没了
      await n.report("revoked");
      expect(notices(noraId).length).toBe(1);
      db.run("UPDATE user_inbox SET acked = 1 WHERE user_id = ?1 AND network_id = ?2 AND kind = ?3", [noraId, netId, MODEL_AUTH_NOTICE_KIND]);
      __resetModelAuthNoticesForTest();
      await n.report("revoked");
      expect(notices(noraId).length).toBe(2);
      await n.report("revoked");
      expect(notices(noraId).length).toBe(2);
    } finally { await n.close(); }
  });

  test("owner no longer in the network → nobody is notified", async () => {
    db.run("DELETE FROM network_members WHERE network_id = ?1 AND user_id = ?2", [netId, noraId]);
    try {
      const n = await connectAs(NODE, noraId, nodeTokenId);
      try { await n.report("expired"); } finally { await n.close(); }
      expect(notices(noraId).length).toBe(0);
      expect(notices(bossId).length).toBe(0);
    } finally {
      addNetworkMember(netId, noraId, "member", bossId, { agentAccess: "all" });
    }
  });
});
