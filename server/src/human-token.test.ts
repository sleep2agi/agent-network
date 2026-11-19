// #4825 —— isHumanToken：默认拒绝，别把身份不明的节点令牌当人。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-humantok-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  const owner = register(`ht_owner_${stamp}`, "Ht-Owner-1!");
  const uid = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ht_owner_${stamp}`)!.user_id;
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, created_at, updated_at)
     VALUES (?1, ?1, ?1, ?2, ?3, datetime('now'), datetime('now'))`,
    [`ht_node_${stamp}`, owner.network_id!, uid],
  );
  (globalThis as any).__ht = { uid, net: owner.network_id!, node: `ht_node_${stamp}`, stamp };
}, 60_000);

afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("isHumanToken (#4825)", () => {
  test("没有 tokenId（legacy 全局令牌）→ 是人", async () => {
    const { isHumanToken } = await import("./human-token.js");
    expect(isHumanToken(null)).toBe(true);
  });

  test("真节点令牌 → 不是人", async () => {
    const { createNetworkTokenForNode } = await import("./auth.js");
    const { isHumanToken } = await import("./human-token.js");
    const g: any = (globalThis as any).__ht;
    const nt = createNetworkTokenForNode(g.uid, g.net, g.node, g.node);
    expect(nt.ok).toBe(true);
    expect(isHumanToken(nt.token_id!)).toBe(false);
  });

  test("🔴 绑定已失效的节点令牌（token 名以 node: 开头）→ 仍然不是人", async () => {
    const { db } = await import("./db.js");
    const { isHumanToken } = await import("./human-token.js");
    const g: any = (globalThis as any).__ht;
    db.run(
      `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, bound_node_id) VALUES ('tok_ht_dead', ?1, ?2, 'network', 'node:gone', 'hash_dead', 'node_gone')`,
      [g.uid, g.net],
    );
    expect(isHumanToken("tok_ht_dead")).toBe(false);
  });
});
