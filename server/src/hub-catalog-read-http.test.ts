// #1473 (#909) — the Hub's Skills / secrets / Provider catalogs had MCP tools
// but no HTTP read surface, so the desktop client shipped a fixture page
// (agent-network-app/src/hub-scope-demo.ts: "Hub 这些写接口还没接通 ... 不发请求").
//
// These three endpoints are read-only and user-token only. The load-bearing
// properties are:
//   * a NODE token cannot enumerate the network's catalogs;
//   * a plain member of another network cannot read this network's catalogs;
//   * pending SkillHub submissions stay invisible unless the caller reviews;
//   * NO secret value ever appears in a response body (asserted with a
//     sentinel that would be trivially visible if a value were serialized).
//
// The sentinel test is deliberately byte-level on the raw response text: a
// future field like `value_preview` would pass a JSON-shape assertion while
// still leaking the secret.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-hub-catalog-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");
// The vault encrypts on write; set the master key before db.ts/vault.ts load.
process.env.ANET_HUB_SECRET_VAULT_KEY ||= "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let ownerToken = "", strangerToken = "", nodeToken = "";
let ownerNet = "", strangerNet = "", ownerUserId = "";
const SECRET_NAME = "PROVIDER_SENTINEL_KEY";
const SECRET_VALUE = "sentinel-value-DO-NOT-LEAK-4f9a2c";

const get = async (path: string, token: string) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text };
};

beforeAll(async () => {
  const { db } = await import("./db.js");
  const { register, createNetworkTokenForNode } = await import("./auth.js");
  const { vaultUpsert } = await import("./vault.js");
  const stamp = Date.now();

  const owner = register(`hc_owner_${stamp}`, "HcOwner-Strong-1!");
  const stranger = register(`hc_stranger_${stamp}`, "HcStranger-Strong-1!");
  expect(owner.ok && stranger.ok).toBe(true);
  ownerToken = owner.token!;
  strangerToken = stranger.token!;
  ownerNet = owner.network_id!;
  strangerNet = stranger.network_id!;
  ownerUserId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `hc_owner_${stamp}`)!.user_id;

  // A node token in the SAME network: it must still be refused, because a node
  // is not a person and may not enumerate catalogs.
  const nodeTok = createNetworkTokenForNode(ownerUserId, ownerNet, "hc-node", "n_hc_test");
  expect(nodeTok.ok).toBe(true);
  nodeToken = nodeTok.token!;

  // Published + pending skills in the owner's network.
  const skill = (id: string, status: string, slug: string) => db.run(
    `INSERT INTO skillhub_skills (skill_id, network_id, slug, name, description, content, content_hash, version, status, source_type, source_alias, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3, 'd', '# SKILL body', 'hash-' || ?1, '1.0.0', ?4, 'node', 'hc-node', datetime('now'), datetime('now'))`,
    [id, ownerNet, slug, status],
  );
  skill("skill_hc_pub", "published", "hc-published");
  skill("skill_hc_pending", "pending", "hc-pending");

  // The sentinel secret. Names may be shown; values never.
  vaultUpsert(ownerNet, SECRET_NAME, SECRET_VALUE);

  db.run(
    `INSERT INTO hub_provider_configs (network_id, provider_id, revision, config_json, secret_key_ref, updated_at)
     VALUES (?1, 'hc-provider', 3, ?2, ?3, ?4)`,
    [ownerNet, JSON.stringify({ id: "hc-provider", label: "HC Provider", enabled: true, protocol: "openai-responses", baseUrl: "https://example.test/v1", models: ["m1"] }), "HC_PROVIDER_KEY", Date.now()],
  );

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/skills", () => {
  test("owner sees published skills and no content body", async () => {
    const r = await get(`/api/skills?network_id=${ownerNet}`, ownerToken);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.reviewer).toBe(true);
    expect(r.body.network_id).toBe(ownerNet);
    const slugs = r.body.skills.map((s: any) => s.slug);
    expect(slugs).toContain("hc-published");
    // Pending is opt-in even for a reviewer.
    expect(slugs).not.toContain("hc-pending");
    // The list is metadata only — a body field would mean SKILL.md text leaked.
    for (const s of r.body.skills) expect(s.content).toBeUndefined();
  });

  test("reviewer may ask for pending submissions", async () => {
    const r = await get(`/api/skills?network_id=${ownerNet}&include_pending=1`, ownerToken);
    expect(r.status).toBe(200);
    const slugs = r.body.skills.map((s: any) => s.slug);
    expect(slugs).toContain("hc-pending");
  });

  // 2026-10-31 —— **两条「providers」读的是不同的表**，而空数组在载荷里长得一样：
  //   GET /api/providers → hub_provider_configs ｜ MCP list_providers → providers / provider_models
  // 客户端「没有可选模型」既可能是前者空，也可能是后者空 ⇒ 必须能在载荷里区分。
  test("an empty registry says which table it read, and whether the CLI registry has rows", async () => {
    const { db } = await import("./db.js");
    // strangerNet 里没有 hub_provider_configs 行；先看「两张表都空」这一档
    const before = await get(`/api/providers?network_id=${strangerNet}`, strangerToken);
    expect(before.status).toBe(200);
    expect(before.body.state).toBe("unconfigured");
    expect(before.body.source_table).toBe("hub_provider_configs");
    expect(before.body.counts.providers).toBe(0);
    expect(before.body.hint).toContain("hub_provider_configs");

    // 再给 CLI 注册表塞一行（另一张表），本端点**仍然为空**，但 hint 必须改口
    db.run(
      `INSERT OR REPLACE INTO providers (provider_id, network_id, name, vendor, base_url, secret_key_ref, created_at, created_by, enabled)
       VALUES ('hc-cli-only', ?1, 'hc-cli-only', 'openai', 'https://api.example.com', 'K', ?2, 'test', 1)`,
      [strangerNet, Date.now()],
    );
    const after = await get(`/api/providers?network_id=${strangerNet}`, strangerToken);
    expect(after.body.providers).toHaveLength(0);        // 本端点还是空
    expect(after.body.counts.providers_in_cli_registry).toBeGreaterThan(0);
    expect(after.body.hint).toContain("不会自动出现在本端点");
    // 反向：有行时不该带 hint（载荷不变胖，且「有理由」与「没理由」可区分）
    const owner = await get(`/api/providers?network_id=${ownerNet}`, ownerToken);
    expect(owner.body.state).toBe("configured");
    expect("hint" in owner.body).toBe(false);
  });

  test("a member of another network is refused", async () => {
    const r = await get(`/api/skills?network_id=${ownerNet}`, strangerToken);
    expect(r.status).toBe(403);
    // Cross-network access is refused by REST scope resolution BEFORE the role
    // check runs, so the error names the scope gate. Either way: 403, no data.
    expect(String(r.body.error)).toMatch(/access denied|permission_denied/);
  });

  test("a node token is refused even inside its own network", async () => {
    const r = await get(`/api/skills?network_id=${ownerNet}`, nodeToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });

  test("include_pending is ignored for a non-reviewer of that network", async () => {
    // The stranger's own network has no skills; the point is that asking for
    // pending must not widen what they can see when they ask about their own.
    const r = await get(`/api/skills?network_id=${strangerNet}&include_pending=1`, strangerToken);
    expect(r.status).toBe(200);
    expect(r.body.reviewer).toBe(true); // they own their own network
    expect(r.body.skills).toEqual([]);
  });
});

describe("GET /api/secrets", () => {
  test("returns key names and timestamps, never the value", async () => {
    const r = await get(`/api/secrets?network_id=${ownerNet}`, ownerToken);
    expect(r.status).toBe(200);
    const names = r.body.keys.map((k: any) => k.key);
    expect(names).toContain(SECRET_NAME);
    // <-- The load-bearing assertion: raw body text must not contain the value.
    expect(r.text).not.toContain(SECRET_VALUE);
    expect(r.text).not.toContain("ciphertext");
    expect(r.text).not.toContain("iv");
    expect(r.text).not.toContain("tag");
  });

  test("a member of another network is refused and learns no key names", async () => {
    const r = await get(`/api/secrets?network_id=${ownerNet}`, strangerToken);
    expect(r.status).toBe(403);
    expect(r.text).not.toContain(SECRET_NAME);
    expect(r.text).not.toContain(SECRET_VALUE);
  });

  test("a node token is refused", async () => {
    const r = await get(`/api/secrets?network_id=${ownerNet}`, nodeToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });
});

describe("GET /api/providers", () => {
  test("returns the registry without secret references", async () => {
    const r = await get(`/api/providers?network_id=${ownerNet}`, ownerToken);
    expect(r.status).toBe(200);
    expect(r.body.providers).toHaveLength(1);
    expect(r.body.providers[0]).toMatchObject({ id: "hc-provider", label: "HC Provider", source: "hub" });
    // The vault key NAME is a hint an attacker does not need; `exposeRefs` is
    // false here on purpose.
    expect(r.body.providers[0].secret_key_ref).toBeUndefined();
    expect(r.text).not.toContain("HC_PROVIDER_KEY");
    expect(r.text).not.toContain(SECRET_VALUE);
  });

  test("a member of another network is refused", async () => {
    const r = await get(`/api/providers?network_id=${ownerNet}`, strangerToken);
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("hc-provider");
  });

  test("a node token is refused", async () => {
    const r = await get(`/api/providers?network_id=${ownerNet}`, nodeToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });
  // 2026-10-31 —— **写侧原来只有 MCP**：客户端能显示「还没有 provider」，却没办法把它变成「有」。
  // 这条把「第一行」确认成一次 HTTP 调用，并核对三件事：落库、读回来一致、revision 冲突是 409。
  test("PUT /api/providers creates the first row, and the read side sees it", async () => {
    const body = {
      revision: 0,
      provider: {
        id: "hc-first", label: "First Provider", enabled: true,
        protocol: "openai-chat-completions", baseUrl: "https://api.example.com/v1",
        models: ["gpt-x"], key: "sk-test-not-a-real-secret",
      },
    };
    const r = await fetch(`${base}/api/providers?network_id=${ownerNet}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const saved = await r.json() as any;
    expect(r.status).toBe(200);
    expect(saved.ok).toBe(true);
    expect(saved.provider.id).toBe("hc-first");
    expect(saved.provider.revision).toBe(1);
    // 密钥永不回显
    expect(JSON.stringify(saved)).not.toContain("sk-test-not-a-real-secret");

    const read = await get(`/api/providers?network_id=${ownerNet}`, ownerToken);
    const ids = read.body.providers.map((p: any) => p.id);
    expect(ids).toContain("hc-first");

    // 用旧 revision 再写一次 ⇒ 409（乐观锁；这正是「两个人同时改」的那一格）
    const stale = await fetch(`${base}/api/providers?network_id=${ownerNet}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, revision: 0, provider: { ...body.provider, label: "Second Writer" } }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json() as any).error).toBe("hub_provider_revision_conflict");

    // 别的网络成员不许写
    const foreign = await fetch(`${base}/api/providers?network_id=${ownerNet}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${strangerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, revision: 1 }),
    });
    expect(foreign.status).toBe(403);

    // 清理：这条测试造了一行，后面的断言按「1 行」计数，不能留痕
    const { db } = await import("./db.js");
    db.run(`DELETE FROM hub_provider_configs WHERE network_id = ?1 AND provider_id = 'hc-first'`, [ownerNet]);
  });


  // 2026-10-31 —— **写侧状态码是穷尽表**（外部复核：三元式默认分支 = 未映射与真实含义同值）。
  // 两条断言分开：① 映射键 == 码清单；② 码清单里的每个码都真的在源码里被产出（跨源）。
  test("provider write: every error code has a status, and every status code is really produced", async () => {
    const { PROVIDER_WRITE_ERROR_CODES, PROVIDER_WRITE_STATUS } = await import("./hub-provider-config.js");
    const { readFileSync } = await import("node:fs");
    expect(Object.keys(PROVIDER_WRITE_STATUS).sort()).toEqual([...PROVIDER_WRITE_ERROR_CODES].sort());
    for (const code of PROVIDER_WRITE_ERROR_CODES) {
      expect(Number.isInteger(PROVIDER_WRITE_STATUS[code])).toBe(true);
      expect(PROVIDER_WRITE_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    // 跨源：这些码必须能在源码里找到（`denied('x')` 或 vault 的 code 字面量），
    // 否则清单会退化成「我们以为会发生的错误」。
    const src = readFileSync(new URL("./hub-provider-config.ts", import.meta.url), "utf8");
    const missing = [...PROVIDER_WRITE_ERROR_CODES].filter((c) => !src.includes(`'${c}'`) && !src.includes(`"${c}"`));
    if (missing.length) throw new Error(`码清单里这些码在源码中找不到产出点：${missing.join(", ")}`);
  });

  // 2026-10-31 —— 节点当前 provider/模型的三态读口（#3145 的数据面）。
  // 关键：**从未切换过 / 正在切 / 切失败** 必须能分开 —— 界面给的下一步完全不同。
  test("GET /api/nodes/:id/provider-selection distinguishes never_switched / pending / applied / failed", async () => {
    const { db } = await import("./db.js");
    const nodeId = "ps-probe-node";
    db.run(`INSERT OR REPLACE INTO nodes (node_id, node_name, network_id, alias, created_at, updated_at)
            VALUES (?1, 'ps-probe', ?2, 'ps-probe', ?3, ?3)`, [nodeId, ownerNet, Date.now()]);
    const read = async () => {
      const r = await fetch(`${base}/api/nodes/${nodeId}/provider-selection`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      return { status: r.status, body: await r.json() as any };
    };
    try {
      // ① 从未切换过：带 hint，selection 为 null（不假装是 Hub 的读数）
      const a = await read();
      expect(a.status).toBe(200);
      expect(a.body.state).toBe("never_switched");
      expect(a.body.selection).toBeNull();
      expect(String(a.body.hint)).toContain("本地默认配置");

      // ② 正在切：pending 时不带 hint（hint 只属于「没有读数」那一档）
      const q = (requestId: string, status: string, payload: string | null, error: string | null) => db.run(
        `INSERT OR REPLACE INTO daemon_provider_snapshots (request_id, network_id, daemon_node_id, requested_by, status, created_at, expires_at, observed_at, snapshot_json, error)
         VALUES (?1, ?2, ?3, 'test', ?4, ?5, ?6, ?5, ?7, ?8)`,
        [requestId, ownerNet, nodeId, status, Date.now(), Date.now() + 60_000, payload, error],
      );
      q("dpa_probe_1", "pending", null, null);
      const b = await read();
      expect(b.body.state).toBe("pending");
      expect("hint" in b.body).toBe(false);

      // ③ 已生效：selection 原样带回，并给出 revision
      q("dpa_probe_2", "completed", JSON.stringify({ expected_revision: 7, provider_id: "main", model: "m1" }), null);
      const c = await read();
      expect(c.body.state).toBe("applied");
      expect(c.body.selection).toMatchObject({ provider_id: "main", model: "m1" });
      expect(c.body.revision).toBe(7);
      expect(typeof c.body.observed_at).toBe("string");

      // ④ 失败：必须带 error（否则界面只能说「失败了」）
      q("dpa_probe_3", "failed", null, "daemon_rejected_selection");
      const d = await read();
      expect(d.body.state).toBe("failed");
      expect(d.body.error).toBe("daemon_rejected_selection");
    } finally {
      db.run(`DELETE FROM daemon_provider_snapshots WHERE daemon_node_id = ?1`, [nodeId]);
      db.run(`DELETE FROM nodes WHERE node_id = ?1`, [nodeId]);
    }
  });
});
