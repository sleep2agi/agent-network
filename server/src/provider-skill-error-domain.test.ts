// #3309 读数覆盖第六批 —— 四个 error 字面量此前在测试里一次都没出现过：
//
//   upsert_provider : insufficient_role_for_provider / provider_name_conflict
//   review_skill    : skill_review_admin_required / skill_not_pending
//
// 两对各有一个「只差一层」的近邻，而处置完全不同：
//   insufficient_role_for_provider ↔ provider_name_conflict
//        换人提权            ↔ 换个名字（或先删旧的）
//   skill_review_admin_required ↔ skill_not_pending
//        换人提权            ↔ 这个技能已经被审过，不必再审
//
// 只断言 ok===false 时，四条与「网络不通」「id 不存在」同形。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

// vault 根密钥必须存在，否则 upsert_network_secret 直接失败（与 provider-tools-shape.test.ts 同一做法）。
process.env.ANET_HUB_SECRET_VAULT_KEY ||= "44".repeat(32);

const NET = "net_6th_err";
const ADMIN = "u_6th_admin";
const MEMBER = "u_6th_member";
const SKILL = "skill_6th_pending";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function handlers(userId: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const orig = server.tool.bind(server);
  server.tool = (n: string, d: string, s: any, h: ToolHandler) => { out[n] = h; return orig(n, d, s, h); };
  registerTools(server, undefined, NET, userId, null, false, null);
  return out;
}

async function call(userId: string, name: string, args: Record<string, unknown>) {
  const r = await handlers(userId)[name](args as any);
  return JSON.parse(r.content[0].text) as { ok?: boolean; error?: string; [k: string]: unknown };
}

function cleanup() {
  try { db.run("DELETE FROM provider_models WHERE provider_id IN (SELECT provider_id FROM providers WHERE network_id = ?1)", [NET]); } catch {}
  try { db.run("DELETE FROM providers WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM skillhub_skills WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_secrets WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id IN (?1, ?2)", [ADMIN, MEMBER]); } catch {}
}

function seed() {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [ADMIN]);
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [MEMBER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, ADMIN]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [ADMIN, NET]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'member', datetime('now'))", [MEMBER, NET]);
  db.run(
    `INSERT INTO skillhub_skills (skill_id, network_id, slug, name, description, content, content_hash, version,
                                  status, source_type, created_at, updated_at)
     VALUES (?1, ?2, 'sixth', 'Sixth', 'd', 'body', 'h', '1.0.0', 'published', 'user',
             datetime('now'), datetime('now'))`,
    [SKILL, NET],
  );
}

beforeEach(seed);
afterAll(cleanup);

describe("#3309 upsert_provider / review_skill 的错误值域", () => {
  test("成员建 provider ⇒ insufficient_role_for_provider（带 required_role / caller_role）", async () => {
    const r = await call(MEMBER, "upsert_provider", {
      name: "sixth-provider", vendor: "anthropic", base_url: "https://api.anthropic.com",
      secret_key_ref: "SIXTH_KEY", models: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("insufficient_role_for_provider");
    expect(r.required_role).toBe("admin");
    expect(r.caller_role).toBe("member");
  });

  test("同名 provider 第二次入库 ⇒ provider_name_conflict（带 name）", async () => {
    // 先把 vault key 备好，否则会先撞 secret_not_in_vault，走不到 UNIQUE 那一步。
    const sec = await call(ADMIN, "upsert_network_secret", { key: "SIXTH_KEY", value: "sk-sixth-not-real" });
    expect(sec.ok).toBe(true);
    const args = {
      name: "sixth-dup", vendor: "anthropic", base_url: "https://api.anthropic.com",
      secret_key_ref: "SIXTH_KEY", models: [],
    };
    const first = await call(ADMIN, "upsert_provider", args);
    expect(first.ok).toBe(true);
    const second = await call(ADMIN, "upsert_provider", args);
    expect(second.ok).toBe(false);
    expect(second.error).toBe("provider_name_conflict");
    expect(second.name).toBe("sixth-dup");
    // 与 insufficient_role 的区别：这不是权限问题，换个名字就好。
    expect(second.error).not.toBe("insufficient_role_for_provider");
  });

  test("成员审技能 ⇒ skill_review_admin_required", async () => {
    const r = await call(MEMBER, "review_skill", { skill_id: SKILL, decision: "published" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("skill_review_admin_required");
  });

  test("审一个已发布的技能 ⇒ skill_not_pending（带当前 status）", async () => {
    const r = await call(ADMIN, "review_skill", { skill_id: SKILL, decision: "rejected" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("skill_not_pending");
    expect(r.status).toBe("published");
    // 与 skill_review_admin_required 的区别：权限没问题，是这个对象的状态不该再审。
    expect(r.error).not.toBe("skill_review_admin_required");
  });

  test("四条载荷都没有 code 字段（现状，不是契约）", async () => {
    const replies = [
      await call(MEMBER, "upsert_provider", {
        name: "x", vendor: "anthropic", base_url: "https://api.anthropic.com",
        secret_key_ref: "K", models: [],
      }),
      await call(MEMBER, "review_skill", { skill_id: SKILL, decision: "published" }),
      await call(ADMIN, "review_skill", { skill_id: SKILL, decision: "published" }),
    ];
    for (const r of replies) {
      expect(r.ok).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(false);
    }
  });
});
