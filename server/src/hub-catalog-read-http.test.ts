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

    // 2026-10-31 —— **闭集不许有死成员**：客户端 union 里写着 all_disabled，
    // 而这个端点原来只产出前两个 ⇒ 那一格永远不会出现、界面分支永远跑不到。
    // 本地 hub 实测：建了 enabled:true 的行 ⇒ configured；把 enabled 改成 false ⇒ **仍是 configured**
    // ⇒ 读的人会把「全都关了」看成「配置好了」。现在三态都必须可产出。
    db.run(`UPDATE hub_provider_configs SET config_json = json_set(config_json, '$.enabled', json('false'))
            WHERE network_id = ?1`, [ownerNet]);
    const disabled = await get(`/api/providers?network_id=${ownerNet}`, ownerToken);
    expect(disabled.body.state).toBe("all_disabled");
    expect(disabled.body.counts.providers_enabled).toBe(0);
    expect(disabled.body.counts.providers_disabled).toBeGreaterThan(0);
    expect(disabled.body.counts.models_enabled).toBe(0);
    expect(disabled.body.hint).toContain("全部被禁用");
    expect(disabled.body.hint).toContain("不是「还没配置」");

    // 还原：否则后面的用例会看到一个全禁用的网络
    db.run(`UPDATE hub_provider_configs SET config_json = json_set(config_json, '$.enabled', json('true'))
            WHERE network_id = ?1`, [ownerNet]);
    const back = await get(`/api/providers?network_id=${ownerNet}`, ownerToken);
    expect(back.body.state).toBe("configured");
    expect(back.body.counts.models_enabled).toBeGreaterThan(0);

    // 2026-10-31 —— **形状测试必须先证明输入彼此不同，再断言各自属性**
    // （外部复核 ③：「顺序不能反：先断言几种形状的字节两两不等，再断言各自含有应有的属性；
    //   反过来时『四种其实是一种』也能全绿。」）
    // 这里是三态：删掉 state 之后，三份载荷必须两两不同 —— 否则「三态」只是同一个载荷换了标签。
    const strip = (b: any) => { const { state: _s, ...rest } = b; return JSON.stringify(rest); };
    const three = [strip(before.body), strip(disabled.body), strip(back.body)];
    expect(new Set(three).size).toBe(3);
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
      expect(String(a.body.hint)).toContain("本地的默认配置");
      // 2026-10-31 —— **hint 必须自带动作**（外部复核：一句只描述状态的提示产不出下一步）。
      // 这条断言钉住「它至少告诉读者第一步是什么」，而不是只说「现在是这样」。
      expect(String(a.body.hint)).toMatch(/POST|GET|切一次/);

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
      // 2026-10-31 —— 这条 fixture 原来写 `"completed"`，而**生产端从不写这个值**
      // （daemon 成功时写的是 `succeeded`，见 daemon-provider-snapshots.ts:322）。
      // 于是这条断言只在「兜底分支」上成立：它证明的不是「applied 状态能读到」，
      // 而是「任何没枚举到的值都会被读成 applied」——一条把缺陷当契约保护起来的断言。
      // ⇒ fixture 改用生产者真的会写的值；兜底方向另立一条断言（见下面的 unknown 用例）。
      q("dpa_probe_2", "succeeded", JSON.stringify({ expected_revision: 7, provider_id: "main", model: "m1" }), null);
      const c = await read();
      expect(c.body.state).toBe("applied");
      expect(c.body.selection).toMatchObject({ provider_id: "main", model: "m1" });
      expect(c.body.revision).toBe(7);
      // 2026-10-31 —— 「存在/类型」不是断言（外部复核 (b)）：
      // observed_at 是「这份 selection 是什么时候观测到的」，它必须**可解析**且**不晚于现在**，
      // 否则它只是一个格式正确的字符串。
      expect(typeof c.body.observed_at).toBe("string");
      const observedMs = Date.parse(c.body.observed_at);
      expect(Number.isFinite(observedMs)).toBe(true);
      expect(observedMs).toBeLessThanOrEqual(Date.now() + 1000);
      expect(observedMs).toBeGreaterThan(Date.now() - 86_400_000);   // 不该是 1970 或其他纪元

      // ④ 失败：必须带 error（否则界面只能说「失败了」）
      q("dpa_probe_3", "failed", null, "daemon_rejected_selection");
      const d = await read();
      expect(d.body.state).toBe("failed");
      expect(d.body.error).toBe("daemon_rejected_selection");

      // ⑤ 未知状态：**兜底不许是最乐观的那一档**
      // 原实现是 `… ? "failed" : "applied"` ⇒ 任何没被枚举到的 status 都折叠成「已生效」。
      // daemon 侧只要新增一个状态（取消 / 回滚 / 拼错），界面就会读到「切好了」—— 唯一会主动撒谎的折叠方向。
      // 现在闭集显式映射，不认识的值报 unknown 且把原值带出去（不猜、不美化）。
      q("dpa_probe_4", "cancelled_by_operator", null, null);
      const e = await read();
      expect(e.body.state).toBe("unknown");
      expect(e.body.state).not.toBe("applied");
      expect(e.body.observed_status).toBe("cancelled_by_operator");
      expect(String(e.body.hint)).toContain("不等于已生效");

      // 2026-10-31 —— **要数的是「出口量里能独立变化的维度数」，不是「有几条路径」**
      // （外部复核 (d)：「出口三元组实测秩 = 1：头无条件设置、键数恒为 3、状态是 code 的纯函数
      //   ⇒ A、B 两条向量改变的是同一个出口量」）。
      // 对应到本路由：五个 state 如果**去掉 state 字段**就分不出来，那 state 就是唯一信息源，
      // 载荷只是标签的复读 —— 秩 = 1。判据：把 state 删掉之后，五个载荷仍两两可区分。
      // 2026-10-31 —— **从属字段在主条件为假时不得有值**（外部复核 (d)：
      // 「从属字段在主字段为假时不得有值；不校验就会存下不可能的状态，
      //   后来者无法区分它与历史遗留，只会当成有效读数。」）
      // 本路由的三个从属键：
      //   error            ⟺ state === "failed"
      //   observed_status  ⟺ state === "unknown"
      //   hint             ⟺ state ∈ {never_switched, unknown}（pending/applied 不该有 hint）
      const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);
      const cases: Array<[string, any, { error: boolean; observed_status: boolean; hint: boolean }]> = [
        ["never_switched", a.body, { error: false, observed_status: false, hint: true }],
        ["pending", b.body, { error: false, observed_status: false, hint: false }],
        ["applied", c.body, { error: false, observed_status: false, hint: false }],
        ["failed", d.body, { error: true, observed_status: false, hint: false }],
        ["unknown", e.body, { error: false, observed_status: true, hint: true }],
      ];
      for (const [label, body, want] of cases) {
        expect({ label, error: has(body, "error") }).toEqual({ label, error: want.error });
        expect({ label, observed: has(body, "observed_status") }).toEqual({ label, observed: want.observed_status });
        expect({ label, hint: has(body, "hint") }).toEqual({ label, hint: want.hint });
      }

      const strip = (b: any) => { const { state: _s, ...rest } = b; return JSON.stringify(rest); };
      const five = [a, b, c, d, e].map((r) => strip(r.body));
      expect(new Set(five).size).toBe(5);   // 两两不同 ⇒ 秩 ≥ 2，state 不是唯一维度
    } finally {
      db.run(`DELETE FROM daemon_provider_snapshots WHERE daemon_node_id = ?1`, [nodeId]);
      db.run(`DELETE FROM node_daemon_bindings WHERE request_id = 'bind_ps'`);
      db.run(`DELETE FROM nodes WHERE node_id = 'ps-target-node'`);
      db.run(`DELETE FROM api_tokens WHERE token_id = 'tok_ps_write'`);
      db.run(`DELETE FROM nodes WHERE node_id = ?1`, [nodeId]);
    }
  });

  // 2026-10-31 —— 写侧：切 provider 的**第一步**（排队 + 带切换前读数）。
  // 关键断言不是「返回 202」，而是「它把 before 带回来了」——没有 before，
  // 「切成功了吗」只能靠客户端自己记住上一次。
  test("POST /api/nodes/:id/provider-selection queues an application and returns the pre-state", async () => {
    const { db } = await import("./db.js");
    const nodeId = "ps-write-node";
    // provider 切换只对 host_supervisor 守护进程有意义 —— 那条前置条件本身也要先被证明：
    // 普通节点 ⇒ 404 daemon_not_found（下面第一条断言）。
    db.run(`INSERT OR REPLACE INTO nodes (node_id, node_name, network_id, alias, created_at, updated_at, config_snapshot)
            VALUES (?1, 'ps-write', ?2, 'ps-write', ?3, ?3, '{}')`, [nodeId, ownerNet, Date.now()]);
    const selection0 = { node_id: nodeId, node_revision: "a".repeat(64), provider_id: "main", auth_id: "auth1", model: "m1", confirm_restart: true };
    const postRaw = async (body: any) => {
      const r = await fetch(`${base}/api/nodes/${nodeId}/provider-selection`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() as any };
    };
    db.run(`INSERT OR REPLACE INTO daemon_provider_snapshots (request_id, network_id, daemon_node_id, requested_by, status, created_at, expires_at, observed_at, snapshot_json, error)
            VALUES ('dpa_prev', ?1, ?2, 'test', 'completed', ?3, ?4, ?3, ?5, NULL)`,
      [ownerNet, nodeId, Date.now(), Date.now() + 60_000, JSON.stringify({ expected_revision: 3, provider_id: "prev", model: "m0" })]);
    // 真实语义：切的是**被这个守护进程监督的节点**，不是守护进程自己 ⇒ 需要一个 target 节点 + 一条 active 绑定
    const targetId = "ps-target-node";
    db.run(`INSERT OR REPLACE INTO nodes (node_id, node_name, network_id, alias, created_at, updated_at)
            VALUES (?1, 'ps-target', ?2, 'ps-target', ?3, ?3)`, [targetId, ownerNet, Date.now()]);
    db.run(`INSERT OR REPLACE INTO node_daemon_bindings (request_id, network_id, node_id, daemon_node_id, workdir, requested_by, status, created_at, updated_at)
            VALUES ('bind_ps', ?1, ?2, ?3, '/tmp', 'test', 'active', ?4, ?4)`, [ownerNet, targetId, nodeId, Date.now()]);
    const selection = { node_id: targetId, node_revision: "a".repeat(64), provider_id: "main", auth_id: "auth1", model: "m1", confirm_restart: true };
    try {
      const post = async (body: any) => {
        const r = await fetch(`${base}/api/nodes/${nodeId}/provider-selection`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: r.status, body: await r.json() as any };
      };
      // ① 普通节点（不是 host_supervisor）⇒ 404：切换只对守护进程有意义
      expect((await postRaw({ revision: 3, selection: selection0 })).status).toBe(404);

      // 补上前置条件：节点既要有 node-scoped token，也要 config_snapshot.role=host_supervisor
      db.run(`INSERT OR REPLACE INTO api_tokens (token_id, token_hash, user_id, network_id, name, created_at)
              VALUES ('tok_ps_write', 'hash', ?1, ?2, 'node:ps-write', datetime('now'))`, [ownerUserId, ownerNet]);
      db.run(`UPDATE nodes SET config_snapshot = '{"role":"host_supervisor"}' WHERE node_id = ?1`, [nodeId]);

      // 缺 revision ⇒ 400（且提示「先 GET 同一路由」）
      const noRev = await post({ selection });
      expect(noRev.status).toBe(400);
      expect(noRev.body.error).toBe("invalid_revision");

      // 正常：202 + state=pending + before 是上一次生效的 selection
      const ok = await post({ revision: 3, selection });
      if (ok.status !== 202) throw new Error(`期望 202，实际 ${ok.status}：${JSON.stringify(ok.body)}`);
      expect(ok.status).toBe(202);
      expect(ok.body.state).toBe("pending");
      expect(ok.body.request_id).toMatch(/^dpa_/);
      expect(ok.body.before).toMatchObject({ provider_id: "prev", model: "m0" });
      expect(String(ok.body.hint)).toContain("pending 不等于生效");

      // 回读：pending 状态在 GET 上立刻可见（写与读用同一个状态源）
      const get = await fetch(`${base}/api/nodes/${nodeId}/provider-selection`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      const got = await get.json() as any;
      expect(got.state).toBe("pending");
    } finally {
      db.run(`DELETE FROM daemon_provider_applications WHERE request_id IN (SELECT request_id FROM daemon_provider_snapshots WHERE daemon_node_id = ?1)`, [nodeId]);
      db.run(`DELETE FROM daemon_provider_snapshots WHERE daemon_node_id = ?1`, [nodeId]);
      db.run(`DELETE FROM node_daemon_bindings WHERE request_id = 'bind_ps'`);
      db.run(`DELETE FROM nodes WHERE node_id = 'ps-target-node'`);
      db.run(`DELETE FROM api_tokens WHERE token_id = 'tok_ps_write'`);
      db.run(`DELETE FROM nodes WHERE node_id = ?1`, [nodeId]);
    }
  });

  // 2026-10-31 —— **格式约束与数量约束分开**（外部复核 (a)：
  // 「白名单管『怎么写』，这条管『写几处』」）。
  // 这两张状态映射各自只能有**一处定义**，且必须被生产代码**至少读一次**：
  //   只有定义、没有读取 ⇒ 它是一张装饰表（写 1 处、读 0 处）。
  test("status maps are defined exactly once and read by production code (a comment mentioning them does not count)", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dir);
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
      }
      return out;
    };
    const files = walk(root).map((f) => ({ f, src: readFileSync(f, "utf8") }));
    for (const name of ["PROVIDER_WRITE_STATUS", "TAG_CREATE_STATUS"]) {
      const defs = files.filter(({ src }) => src.includes(`export const ${name}`));
      expect(defs.length).toBe(1);
      const readers = files.flatMap(({ f, src }) =>
        src.split("\n").map((line, i) => ({ line, f, i }))
          .filter(({ line }) => line.includes(name) && !line.includes(`export const ${name}`))
          // 2026-10-31 —— **注释不是读点**：`// 状态码来自穷尽表（PROVIDER_WRITE_STATUS…）`
          // 会满足「读到过」而实际上没有任何代码用它。这正是本仓实测到的形态。
          .filter(({ line }) => {
            const t = line.trim();
            return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
          }));
      // 「读」= 出现但不是定义行（索引 / 展开 / 断言都算）
      expect(readers.length).toBeGreaterThan(0);
      // 2026-10-31 —— **计数 = 1 还不够，位置也要在集合内**（外部复核：
      // 「只断言计数 1 ⇒ 留下的是『1 个读点，它自己另搞一套』—— 完全满足计数 1，
      //  而语义已经不是你想的那个。」）
      // ⇒ 读点必须落在**路由文件**里（server.ts），否则等于表有了、用法另有其处。
      // 位置：读点必须落在**实现或路由**里（不是只落在注释里）
      // 2026-10-31 —— **同值不能证明同源**（外部复核：「facade 走映射链、pty 直接写字面，
      // 今天同值，而链改了 pty 不跟 ⇒ 任何静态断言都看不见这一格；
      // 同值能证明它们此刻一致，不能证明它们受同一个约束。」）
      //
      // 本仓的同形：`state` 的取值域由**服务端**产出（闭集映射 + never_switched + unknown），
      // 而**客户端**的 TS union 是另一份手写清单。两份今天相等，改一边不会红。
      // 判据：把「服务端实际可产出的集合」与「客户端 union 的集合」直接比；
      // 并且这条比较本身必须能红（witness：改客户端 union 少一个值 ⇒ 立刻红）。
      const { SELECTION_STATE_BY_STATUS } = await import("./server.js");
      const serverStates = new Set<string>([
        "never_switched",
        ...Object.values(SELECTION_STATE_BY_STATUS as Record<string, string>),
        "unknown",
      ]);
      const clientSrc = readFileSync(join(import.meta.dir, "..", "..", "prototype", "anet-client-app", "src", "api.ts"), "utf8");
      const unionLine = clientSrc.split("\n").find((l) => l.includes("export type ProviderSelectionState")) ?? "";
      const clientStates = new Set([...unionLine.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
      expect(clientStates.size).toBeGreaterThan(0);              // 解析不出 union ⇒ 没有读数
      expect([...clientStates].sort()).toEqual([...serverStates].sort());
      // 空集守卫：两边都不能是空（否则「相等」是真空真）
      expect(serverStates.size).toBe(5);

      // 2026-10-31 —— **兜底不许把「我们的缺陷」说成「客户端的错」**：
      // 表里查不到的码 ⇒ 归因指向了错误的行动方（返回 400 会让客户端去改自己的请求）。
      // 判据同「遍历每个抛点断言它不等于 catch-all」：逐个码断言它映射到**自己那一格**，
      // 再断言未登记的码落 500 而不是 400。
      const { PROVIDER_WRITE_ERROR_CODES: CODES, PROVIDER_WRITE_STATUS: STATUS, providerWriteStatus: statusOf } =
        await import("./hub-provider-config.js");
      const CLOSED = new Set([400, 401, 403, 404, 409, 500, 503]);
      // 2026-10-31 —— **把「恒真的断言」换成能假的那条**（外部复核 (a)：
      // 「同一个字面量 code 有两个 id 生产者，而选择依据是另一个观测量 ⇒
      //   两条测试都没覆盖第二个分支 ⇒ `observed.id === body.error.diagnosticId` 永远成立」）。
      //
      // 本仓原来这里写的是 `expect(statusOf(code)).toBe(STATUS[code])` ——
      // 而 statusOf 的实现就是 `STATUS[code] ?? 500` ⇒ 对表里的码**恒真**，
      // 它证明不了任何东西（把状态表整个改成 200 它也绿，只要两边一起改）。
      // ⇒ 换成两条能假、且各自守一件事的断言：
      //   ① 码清单与状态表的**键集相等**（新增一个码却没给状态 ⇒ 红）
      //   ② 每个值落在 HTTP 闭集里（有人写 299 / 0 ⇒ 红）
      expect(Object.keys(STATUS).sort()).toEqual([...CODES].sort());
      for (const code of CODES) {
        expect(CLOSED.has(STATUS[code])).toBe(true);
      }
      // 镜像（must-fire）：一个**不在表里**的码必须落到 500，不能落 400
      const bogus = statusOf("definitely_not_a_listed_code" as any);
      expect(bogus).toBe(500);
      expect(bogus).not.toBe(400);

      const readerFiles = new Set(readers.map((r) => String(r.f).split("/").pop()));
      expect(readerFiles.size).toBeGreaterThan(0);
      expect([...readerFiles].some((f) => f === "server.ts" || f === "hub-provider-config.ts" || f === "requirements.ts")).toBe(true);
    }
  });

  // 2026-10-31 —— **枚举里不能有打不中的值**（外部复核：
  // 「5 值枚举里 2 个不可达（stage_missing / id_not_uuid）——那是装饰，
  //  而读者会以为那两条分支存在且被测过」）。
  // 判据：每个成员的字面量必须在**生产源码**里出现（类型声明行不算）。
  test("every enum member is actually produced somewhere in production code", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
      }
      return out;
    };
    const prod = walk(join(import.meta.dir)).map((f) => readFileSync(f, "utf8")).join("\n");
    const enums: Record<string, string[]> = {
      version_source: ["embedded_env", "package_json", "read_failed", "empty_value"],
      provider_selection_state: ["never_switched", "pending", "applied", "failed"],
    };
    for (const [label, members] of Object.entries(enums)) {
      const dead = members.filter((m) => !new RegExp(`["']${m}["']`).test(prod));
      if (dead.length) {
        throw new Error(`${label} 里有打不中成员（生产源码没出现过这个字面量）：${dead.join(", ")}\n` +
          "  ⇒ 要么删掉该成员，要么补上产出它的分支；留着等于给读者一条不存在的分支。");
      }
    }
  });
});
