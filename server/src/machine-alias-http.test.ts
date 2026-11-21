// 机器别名 HTTP 边界（admin 2026-11-21）：读（人/节点）都能；写只有用户令牌。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-machine-alias-http-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

let hub: ReturnType<typeof Bun.serve>;
let base = "", userToken = "", nodeToken = "";
const host = "host-alias-test";

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j: any = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register, createToken, createNetworkTokenForNode } = await import("./auth.js");
  const stamp = Date.now();
  const u = register(`ma_user_${stamp}`, "Ma-User-1!");
  userToken = createToken(db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ma_user_${stamp}`)!.user_id, `ma-${stamp}`, u.network_id!).token!;
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at) VALUES (?1,?1,?1,?2,?3,datetime('now'),datetime('now'))`,
    [`node_ma_${stamp}`, u.network_id!, host]);
  const uid2 = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ma_user_${stamp}`)!.user_id;
db.run("UPDATE nodes SET owner_user_id = ?1 WHERE node_id = ?2", [uid2, `node_ma_${stamp}`]);
const nt = createNetworkTokenForNode(uid2, u.network_id!, `node_ma_${stamp}`, `node_ma_${stamp}`);
  nodeToken = nt.token!;
  db.run("UPDATE nodes SET owner_user_id = (SELECT user_id FROM users WHERE username = ?1) WHERE hostname = ?2", [`ma_user_${stamp}`, host]);
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => { try { hub?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("/api/machines/:hostname", () => {
  test("未设置 ⇒ alias=null（前端回落 hostname），并给出该机器上的节点数", async () => {
    const { status, body } = await call("GET", `/api/machines/${host}`, userToken);
    expect(status).toBe(200);
    expect(body.alias).toBeNull();
    expect(body.nodes_on_host).toBeGreaterThanOrEqual(1);
  });

  test("用户令牌可写，读回一致", async () => {
    const put = await call("PUT", `/api/machines/${host}`, userToken, { alias: "机房 A 主力机" });
    expect(put.status).toBe(200);
    expect(put.body.alias).toBe("机房 A 主力机");
    const got = await call("GET", `/api/machines/${host}`, userToken);
    expect(got.body.alias).toBe("机房 A 主力机");
  });

  test("🔴 节点令牌写 ⇒ 403 user_token_required（agent 不能给机器改名）", async () => {
    const put = await call("PUT", `/api/machines/${host}`, nodeToken, { alias: "被 agent 改名" });
    expect(put.status).toBe(403);
    const got = await call("GET", `/api/machines/${host}`, userToken);
    expect(got.body.alias).toBe("机房 A 主力机");  // 没被改
  });

  test("节点令牌可读（上报/展示用）", async () => {
    const { status, body } = await call("GET", `/api/machines/${host}`, nodeToken);
    expect(status).toBe(200);
    expect(body.alias).toBe("机房 A 主力机");
  });

  test("非法别名 ⇒ 400 invalid_machine_alias", async () => {
    const r1 = await call("PUT", `/api/machines/${host}`, userToken, { alias: "   " });
    expect(r1.status).toBe(400); expect(r1.body.error).toBe("invalid_machine_alias");
    const r2 = await call("PUT", `/api/machines/${host}`, userToken, { alias: "x".repeat(65) });
    expect(r2.status).toBe(400);
  });
});
