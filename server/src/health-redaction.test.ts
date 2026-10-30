// #473 — /health information-leak redaction.
//
// Public-hub audit (通信龙, 2026-07-30) showed anonymous GET /health
// returning the full SSE key breakdown: `{networkId}:{alias}` for every
// live connection — network id + all 95 agent aliases on the audited
// hub. The fix keeps /health anonymous (HARD CONSTRAINT: the central
// watchdog curls it every minute; auth here would blind it) but strips
// the per-key detail down to aggregate counts; the detail moved behind
// auth at GET /api/stats/sse (master token or admin only).
//
// Witnessed-red: on pre-fix main (8c11edf5) the "no leak" test below is
// red — the /health body contains the connected alias and network id.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, addNetworkMember, removeNetworkMember } from "./auth.js";
import { db } from "./db.js";
import { MAX_REQUEST_CONTENT_LENGTH, MAX_UPLOAD_BYTES } from "./uploads.js";
import { HEALTH_FIELD_META, PUBLIC_HEALTH_KEYS, mayBePublic, projectPublicHealth } from "./server.js";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-health-red-db-")) + "/commhub.db";

let BASE = "";
let server: any = null;
let sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

let userToken = "";
let userNetworkId = "";
let userName = "";
let adminToken = "";

// 30s 而不是 bun 默认的 5s:这个 hook 跑 register()(KDF)+bootServer(),
// 本机空载基线 ~620ms,而 2026-08-17 与 2026-08-31 两次 CI 上它被 5s 上限打死
// (0 pass / 1 fail / Ran 1 test —— 见 #928、#1627)。5247ms 是**被截断的下界**,
// 不是测量值,所以余量按基线的 ~48x 取,而不是按那个数取。
beforeAll(async () => {
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || SERVER_DB;
  process.env.HOST = "127.0.0.1";

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const pw = "BootstrapPw123Aa!";

  // Burn a seed registration first so our member is NOT auto-admin (the
  // "first registered user → admin" rule only bites when this suite owns
  // the DB; per-file runs need this guard). We set roles explicitly below.
  register(`health_seed_${suffix}`, pw, undefined, "seed");

  userName = `health_user_${suffix}`;
  const r = register(userName, pw, undefined, "seed");
  if (!r.ok || !r.token) throw new Error("register failed: " + JSON.stringify(r));
  userToken = r.token;
  userNetworkId = r.network_id ?? "";
  if (!userNetworkId) throw new Error("no network for user");
  // Pin to plain member — defend against any residual auto-admin.
  db.run("UPDATE users SET role = 'user' WHERE username = ?1", [userName]);

  const adminName = `health_admin_${suffix}`;
  const a = register(adminName, pw, undefined, "seed");
  if (!a.ok || !a.token) throw new Error("admin register failed: " + JSON.stringify(a));
  adminToken = a.token;
  // Explicit promotion — "first registered user is auto-admin" does not
  // hold in aggregate runs (see api-host-supervisors-fallback.test.ts).
  db.run("UPDATE users SET role = 'admin' WHERE username = ?1", [adminName]);

  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;

  // Open a real SSE connection so the stats have a key that WOULD leak:
  // the dashboard-user channel (sessionName === own username, Path 3
  // gate 4a) registers `${networkId}:${username}` in the clients map.
  const res = await fetch(`${BASE}/events/${encodeURIComponent(userName)}?network_id=${userNetworkId}`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (res.status !== 200) throw new Error("SSE subscribe failed: " + res.status);
  sseReader = res.body!.getReader();
  await sseReader.read(); // consume the connected frame → registration done
}, 30_000);

afterAll(() => {
  try { sseReader?.cancel(); } catch {}
  try { server?.stop?.(true); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
});

describe("#473 anonymous /health — watchdog contract intact, no topology leak", () => {
  test("stays anonymous 200 with parseable aggregates (watchdog judge: curl -sf gets 2xx)", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.sessions_count).toBe("number");
    expect(typeof body.sse_connections).toBe("number");
    expect(body.sse_connections).toBeGreaterThanOrEqual(1);
  });

  // 2026-10-31 —— 站位要可验，但**匿名读者只配知道「有没有」，不配知道「是什么」**。
  // /health 是匿名端点；commit sha 对匿名读者 = 精确告诉外部这是哪一版代码（本仓公开）。
  // ⇒ 匿名给布尔 build_identified；完整 sha（+dirty）只给已鉴权者。
  test("anonymous /health discloses only whether a build id exists, never the sha", async () => {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json() as any;
    expect("git_commit" in body).toBe(false);
    expect("git_dirty" in body).toBe(false);
    expect(typeof body.build_identified).toBe("boolean");
  });

  test("authenticated admin /health carries git_commit (40-hex or null) and git_dirty", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const body = await res.json() as any;
    expect("git_commit" in body).toBe(true);
    const value = body.git_commit;
    const isSha = typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
    // null 是设计（没有 .git），不是缺陷；但任何别的形状都不允许。
    expect(isSha || value === null).toBe(true);
    if (value !== null) expect(value).not.toBe(body.version);
    // dirty 位必须与 sha 成对，否则 vantage 会把脏树读数当成提交。
    expect(typeof body.git_dirty).toBe("boolean");
    if (value === null) expect(body.git_dirty).toBe(false);
  });

  // 2026-10-31 —— 拒绝计数的 **must-fire**：注入一次真实拒绝，看它跳不跳。
  //
  // 为什么必须有这一条：光断言 by_reason 存在，测的是形状；形状对、接线错，读数照样是 0。
  // 而「只有异常路径能让它 +1」这一类，0 与「从没出过错」同形 —— 不注入就永远发现不了。
  test("a real rejected /api/task actually bumps the counter (must-fire, not just shape)", async () => {
    const before = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    const beforeTotal = before.counters.task_rejections.total as number;

    // 🔴 必须**带登录态**、并在 handler 内部失败：
    // 全局鉴权中间件的 401 在到达 /api/task 之前就返回 ⇒ 根本不经过 logTaskRejection。
    // （这本身就是一条已知缺口，写在 rejection-counters.ts 的注释里。）
    const rej = await fetch(`${BASE}/api/task`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({}),   // schema 校验失败 ⇒ 400，走 reject()
    });
    expect(rej.status).toBeGreaterThanOrEqual(400);

    const after = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect(after.counters.task_rejections.total).toBe(beforeTotal + 1);
    // 🔴 窗口起点必须不动：计数器 +1 而 since 变化，会让「这段时间拒了几次」算错。
    //    没有窗口的计数器是「没有域的数」；没有 must-fire 的计数器是「没有证据的数」。
    expect(after.counters.since).toBe(before.counters.since);
    expect(after.startedAt).toBe(before.startedAt);
    const bumped = Object.keys(after.counters.task_rejections.by_reason).find(
      (k) => k.startsWith(`${rej.status}:`),
    );
    expect(bumped).toBeTruthy();
  });

  // 2026-10-31 —— 把「已知缺口」钉在 CI 里，而不是只写在注释里。
  //
  // 🔴 这条断言的语义是：**目前如此**，不是「应该如此」。
  //    将来谁把计数上移到中间件，这条会红 —— 那就对了：他必须同时更新
  //    模块注释里的覆盖比例（现在是 2/6 类出口）。
  test("KNOWN GAP: unauthenticated /api/task rejection is NOT counted (see rejection-counters.ts)", async () => {
    const before = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    const beforeTotal = before.counters.task_rejections.total as number;

    // 不带 Authorization ⇒ 鉴权中间件在到达 handler 之前就返回 401。
    const rej = await fetch(`${BASE}/api/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(rej.status).toBeGreaterThanOrEqual(400);

    const after = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    if (after.counters.task_rejections.total !== beforeTotal) {
      throw new Error(
        "已知缺口已被修复？401 出口现在会计数了 —— "
        + "请同时更新 rejection-counters.ts 的出口清单与覆盖比例（当前 2/6），"
        + "并把这条测试改成断言「已被计数」。",
      );
    }
    expect(after.counters.task_rejections.total).toBe(beforeTotal);
  });

  // 2026-10-31 —— parser 级拒绝在本仓**是**被计数的，因为我们在 handler 内 await req.json()。
  // 与 Express 恰好相反（express.json() 走 next(err) ⇒ 错误中间件 ⇒ 不计）。
  // ⇒ 这类出口的归属取决于 parser 放在哪，而不是取决于框架。
  test("malformed JSON on /api/task IS counted — parser lives inside our handler", async () => {
    const before = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    const beforeTotal = before.counters.task_rejections.total as number;
    const rej = await fetch(`${BASE}/api/task`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${userToken}` },
      body: "{bad",
    });
    expect(rej.status).toBe(400);
    const after = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect(after.counters.task_rejections.total).toBe(beforeTotal + 1);
  });

  // 2026-10-31 —— served_at 的**敏感性**：单调不减只证「它没倒退」，常量也满足。
  // 要证「它在跟着墙钟走」，断言里必须出现**两次读数之差**。
  // （今晚的教训：startedAt 的敏感性当初是靠「换进程才变」证的，不是靠「刷新两次相同」。）
  test("served_at actually advances with the wall clock (difference, not just monotonicity)", async () => {
    const t1 = (await (await fetch(`${BASE}/health`)).json() as any).served_at;
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, 250));
    const t2 = (await (await fetch(`${BASE}/health`)).json() as any).served_at;
    const elapsed = Date.now() - startedAt;
    const delta = Date.parse(t2) - Date.parse(t1);
    expect(delta).toBeGreaterThan(0);                       // 真的走了
    expect(Math.abs(delta - elapsed)).toBeLessThanOrEqual(1000); // 且走的是同一个墙钟（容差 1s）
  });

  // 2026-10-31 —— license 三态必须是「三种不同的可修性」，不能折成一个 "none"。
  // 本条只断言形状（测试库没有 license 行 ⇒ absent）；四种映射由 license-state.test.ts 钉死。
  test("license_state distinguishes absent from unknown instead of collapsing to none", async () => {
    const body = await (await fetch(`${BASE}/health`)).json() as any;
    expect(typeof body.license).toBe("string");           // 兼容字段仍在
    const st = body.license_state;
    expect(st && typeof st.kind).toBeTruthy();
    expect(["known", "absent", "unknown"]).toContain(st.kind);
    if (st.kind === "known") expect(typeof st.type).toBe("string");
    if (st.kind === "unknown") expect(typeof st.reason).toBe("string");
  });

  // 2026-10-31 —— 匿名投影必须是**白名单**：新字段默认不出现。
  // 这条断言的是「每一个匿名可见的键都在白名单里」——
  // 于是「忘了想」的结果是**少给**，不是泄露。
  test("anonymous /health exposes ONLY allow-listed keys (new fields default to authenticated)", async () => {
    const body = await (await fetch(`${BASE}/health`)).json() as any;
    const { PUBLIC_HEALTH_KEYS } = await import("./server.js");
    for (const key of Object.keys(body)) {
      expect(PUBLIC_HEALTH_KEYS.has(key)).toBe(true);
    }
    // 两个敏感的典型：不进匿名投影。
    expect("git_commit" in body).toBe(false);
    expect("counters" in body).toBe(false);
    expect("sse_sessions" in body).toBe(false);
  });

  // 2026-10-31 —— 内核口径的进程身份：与自报 startedAt 互为独立的第二条腿。
  // 2026-10-31 修订 —— 原来这条写的是「两条腿一致才发布」，那是**让自报字段否决内核读数**。
  // 现在：判据 = 内核三元组（无条件发布）;展示 = kernel_started_at（永远带 agreement 标记）;
  // 不一致 = 一条独立读数（disagree + delta），**不再折成 null**。
  test("kernel identity is the judgment basis; disagreement with the self-report is its own reading, not a null", async () => {
    // 🔴 用**鉴权**响应：pid / boot_id / kernel_started_at 是「路标」不是「仪表」
    //    ⇒ 不在匿名白名单里（这条测试第一次就是因为读了匿名响应而红 —— 白名单生效了）。
    const body = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect(body.pid).toBe(process.pid);
    if (body.boot_id !== null) expect(String(body.boot_id)).toMatch(/^[0-9a-f-]{16,64}$/i);
    expect(body.proc_start_ticks === null || typeof body.proc_start_ticks === "number").toBe(true);

    // 判据三元组：pid 必须等于真值；boot_id 可读时必须合法 —— 二者都不依赖 startedAt
    // 换算假设必须显式
    // 一个叫 assumed 的字段必须有一条「它是否成立」的判定：
    // 在 x86 上应当 confirmed；非 100 的架构上应当 derived；读不到才 assumed。
    expect([100].includes(body.clk_tck_assumed) || Number.isInteger(body.clk_tck_assumed)).toBe(true);
    expect(["confirmed", "derived", "assumed"]).toContain(body.clk_tck_source);
    expect(["agree", "disagree", "unknown"]).toContain(body.epoch_agreement);

    if (body.kernel_started_at !== null) {
      expect(typeof body.kernel_started_at).toBe("string");
      expect(body.kernel_started_at_note).toBeNull();
      // 🔴 关键：发布条件**不再**是「与自报一致」
      //    实测这台机器上应当一致 ⇒ 断言的是一条**真实现象**，而不是发布条件的复述
      const delta = Math.abs(Date.parse(body.kernel_started_at) - Date.parse(body.startedAt));
      if (body.epoch_agreement === "agree") expect(delta).toBeLessThanOrEqual(10_000);
      if (body.epoch_agreement === "disagree") {
        // 分歧必须能被外部算出来：delta 与 agreement 同向，不能一个说 disagree 一个给个小 delta
        expect(delta).toBeGreaterThan(10_000);
        expect(typeof body.epoch_delta_ms).toBe("number");
      }
    } else {
      // 算不出来时必须给出原因，不能是“静默的 null”
      expect(typeof body.kernel_started_at_note).toBe("string");
      expect(body.epoch_agreement).toBe("unknown");
    }
  });

  // 否定断言必须配镜像肯定断言：上面允许 null，这条要求「在 Linux 上它必须不是 null」。
  // 否则「永远给 null」也能满足上面那条。
  test("on Linux the kernel trio is actually present (a permanent null would satisfy the test above)", async () => {
    if (process.platform !== "linux") return;
    const body = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect(body.boot_id).not.toBeNull();
    expect(body.proc_start_ticks).not.toBeNull();
    expect(body.kernel_started_at).not.toBeNull();
    expect(body.epoch_agreement).not.toBe("unknown");
  });

  // 2026-10-31 —— 头集合断言：**与登录无关**的那条判据。
  //
  // 为什么需要它：凡是「需要会话才能判」的断言都会继承 vantage 病
  // （未登录 CI 恒红 / 有会话环境恒绿 ⇒ 它测的是环境，不是代码）。
  // 头集合不需要会话就能读 ⇒ 它回答的是「我站在哪一层」，而不是「我有没有登录」。
  describe("header set (vantage-free: readable without a session)", () => {
    test("anonymous /health does not leak build identity through headers", async () => {
      const res = await fetch(`${BASE}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") || "").toContain("application/json");
      // 正文里我们只给 build_identified；头里更不能给指纹
      const leaky = [...res.headers.keys()].filter((h) => /git|commit|build[-_]?(sha|id)/i.test(h));
      expect(leaky).toEqual([]);
    });

    test("version carries its role in the payload (a label, not a fingerprint)", async () => {
      const body = await (await fetch(`${BASE}/health`)).json() as any;
      expect(body.version_role).toBe("deployment_label");
      // 反证：同一次响应里**没有**匿名可读的 commit（否则那条角色声明是多余的）
      expect(body.git_commit).toBeUndefined();
    });
  });

  // #3174 —— stall_count / last_stall_at 原来只有 [startedAt, now] 这个**隐含**窗口：
  // 单独引用它，读者会把「计数器归零」读成「从未卡过」。
  // ⇒ 现在窗口两端跟着读数一起走（event_loop.since / event_loop.observed_at）。
  describe("event_loop carries its own window (no implicit [startedAt, now])", () => {
    test("both ends are present, and they are ordered", async () => {
      const body = await (await fetch(`${BASE}/health`)).json() as any;
      expect(typeof body.event_loop.since).toBe("string");
      expect(typeof body.event_loop.observed_at).toBe("string");
      expect(Date.parse(body.event_loop.since)).toBeLessThanOrEqual(Date.parse(body.event_loop.observed_at));
    });

    // 敏感性：起点**不许**跟着时间走，终点**必须**跟着时间走。
    // 只断言「两者可比」的话，一个冻结的时钟也能通过。
    test("since is frozen while observed_at advances (difference, not just comparability)", async () => {
      const a = (await (await fetch(`${BASE}/health`)).json() as any).event_loop;
      const waitStart = Date.now();
      await new Promise((r) => setTimeout(r, 250));
      const b = (await (await fetch(`${BASE}/health`)).json() as any).event_loop;
      const elapsed = Date.now() - waitStart;

      expect(b.since).toBe(a.since);                                   // 起点不动
      const delta = Date.parse(b.observed_at) - Date.parse(a.observed_at);
      expect(delta).toBeGreaterThan(0);                                // 终点真的走
      expect(Math.abs(delta - elapsed)).toBeLessThanOrEqual(1000);     // 且走的是同一个墙钟
    });
  });

  // 2026-10-31 —— 「累计值 ÷ (now − since)」这个用法本身是错的，而且错法很隐蔽。
  //
  // 本仓的 counters.since **就等于 startedAt**（同一个字符串）⇒ 分母是 uptime，不是窗口长度。
  //   · 进程刚重启 ⇒ 分母趋近 0 ⇒ 比值巨大 ⇒ 与 flapping 长得一模一样
  //     而「刚部署」比 flapping 常见得多 ⇒ **这条判据的主要阳性是正常状态**
  //   · 而且分子会被派去看它的人推动（如果那是应答计数）
  // ⇒ 正确判据是**两次读数的差分**：S2 ≠ S1 ∧ (t2 − t1 很小)，不需要除法。
  //
  // 这条测试不是「验证除法」，是**把那个事实钉住**：
  // 哪一天有人给 counters 加了真正的窗口起点，这里会红，届时才允许重新讨论除法。
  test("counters.since is the process start, so it is NOT a window length (denominator trap)", async () => {
    const body = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect(body.counters.since).toBe(body.startedAt);
    expect(body.counters.task_rejections.scope).toBe("process_lifetime");
  });

  // 2026-10-31 —— 304 会让「重启判据」假阳性：
  // 若某层做协商缓存，304 会冻结 startedAt，而 counters 照涨 ⇒ 看起来像 flapping。
  // ⇒ 探针必须显式拿到 200，且服务端必须禁止缓存。
  test("health is never cacheable, and a conditional request still yields 200 (not 304)", async () => {
    const plain = await fetch(`${BASE}/health`);
    expect(plain.status).toBe(200);
    expect((plain.headers.get("cache-control") || "").toLowerCase()).toContain("no-store");

    const conditional = await fetch(`${BASE}/health`, {
      headers: { "cache-control": "no-cache", "if-none-match": "*" },
    });
    expect(conditional.status).toBe(200);   // 304 会让 startedAt 冻结、counters 照涨 = 假 flapping
    const body = await conditional.json() as any;
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.served_at).toBe("string");
  });

  // 2026-10-31 —— 「200 那一格」必须有 body 判据：ok 恒 true 不等于健康。
  // 与 counters.releases 同族：一个恒真的字段，读起来像「一切正常」。
  test("status separates alive-but-degraded from all-normal (200 stays a promise, not a verdict)", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);                       // 承诺不变
    const b = await res.json() as any;
    expect(["ok", "degraded"]).toContain(b.status);
    expect(Array.isArray(b.status_reasons)).toBe(true);
    if (b.status === "ok") expect(b.status_reasons).toEqual([]);   // 两字段必须自洽
    else expect(b.status_reasons.length).toBeGreaterThan(0);
    expect(b.ok).toBe(true);                            // 兼容字段仍在，但不再承担判据
  });

  // 2026-10-31 —— 形状测试必须先证明**输入彼此不同**，否则它测的是同一个形状 N 次。
  // 顺序不能反：先断言两两不等，再断言各自的行为。
  test("the four projection witnesses are pairwise distinct inputs (else it is four selfies)", () => {
    const cases = {
      unknown_field: { ok: true, future_issued_token: "abc" },   // 未登记 ⇒ 丢
      landmark: { ok: true, git_commit: "deadbeef" },            // landmark ⇒ 丢
      gauge: { ok: true, sessions_count: 3 },                    // gauge ⇒ 留
      echo: { probe_nonce: "n-1" },                              // credential(echo) ⇒ 留
    };
    const serialized = Object.entries(cases).map(([k, v]) => [k, JSON.stringify(v)] as const);
    for (let i = 0; i < serialized.length; i += 1) {
      for (let j = i + 1; j < serialized.length; j += 1) {
        expect(serialized[i][1]).not.toBe(serialized[j][1]);     // 两两不等
      }
    }
    // 再断言各自行为（顺序与上面一致：先证输入不同，再看结果）
    expect(Object.keys(projectPublicHealth(cases.unknown_field))).toEqual(["ok"]);
    expect(Object.keys(projectPublicHealth(cases.landmark))).toEqual(["ok"]);
    expect(Object.keys(projectPublicHealth(cases.gauge)).sort()).toEqual(["ok", "sessions_count"]);
    expect(Object.keys(projectPublicHealth(cases.echo))).toEqual(["probe_nonce"]);
  });

  // 2026-10-31 —— 分类必须写出**谁不算**：形似启动快照但会变的那个字段。
  // 读初始快照的判据只会漏报、不会误报；而它的失效形态与「真的没有」同形。
  test("test_spawn_time_snapshot_family_excludes_the_one_field_that_must_change", async () => {
    const { HEALTH_FIELD_META } = await import("./server.js");
    // 分子：至少 5 个被明确标成启动快照（今天：startedAt / git_commit / boot_id / pid / proc_start_ticks / kernel_started_at）
    const frozen = Object.entries(HEALTH_FIELD_META).filter(([, m]) => m.frozen_at_boot === true).map(([k]) => k);
    expect(frozen.length).toBeGreaterThanOrEqual(5);
    // 例外必须显式：served_at 长得一模一样，但它会变
    expect(frozen).not.toContain("served_at");
    expect(HEALTH_FIELD_META.served_at.frozen_at_boot).toBeUndefined();
  });

  // 2026-10-31 —— credential 的「可对账性」是**字段取值**，不是注释里的辩论。
  test("joinability decides anonymity, not the reader's interpretation", async () => {
    const { HEALTH_FIELD_META, mayBePublic } = await import("./server.js");
    const creds = Object.entries(HEALTH_FIELD_META).filter(([, m]) => m.class === "credential");
    expect(creds.length).toBeGreaterThan(0);                       // 分母非空
    const bad = creds.filter(([, m]) => m.joinability !== "echo_only" && mayBePublic(m)).map(([k]) => k);
    expect(bad).toEqual([]);                                       // 服务端生成的一律不可匿名
    expect(HEALTH_FIELD_META.probe_nonce.joinability).toBe("echo_only");
  });

  // 2026-10-31 —— gauge 的粒度词表是**封闭枚举**，且必须分清「电平」与「累积」。
  // 一个电平不能算速率，一个累积不能回答「现在怎么样」——两者在 JSON 里都是数字。
  describe("granularity vocabulary is closed and distinguishes level from cumulative", () => {
    test("every gauge declares one of level/cumulative/instant/label/boolean", async () => {
      const { HEALTH_FIELD_META } = await import("./server.js");
      const allowed = ["level", "cumulative", "instant", "label", "boolean"];
      const bad = Object.entries(HEALTH_FIELD_META)
        .filter(([, m]) => m.class === "gauge" && !allowed.includes(String(m.granularity)))
        .map(([k, m]) => `${k}=${m.granularity}`);
      expect(bad).toEqual([]);
      // 分母非空：这一条今天必须有东西可查
      expect(Object.values(HEALTH_FIELD_META).filter((m) => m.class === "gauge").length).toBeGreaterThan(20);
    });

    test("the two that people confuse are labelled right (peak is cumulative, inflight is a level)", async () => {
      const { HEALTH_FIELD_META } = await import("./server.js");
      expect(HEALTH_FIELD_META.mcp_inflight_peak.granularity).toBe("cumulative");
      expect(HEALTH_FIELD_META.mcp_inflight.granularity).toBe("level");
      expect(HEALTH_FIELD_META.uptime.granularity).toBe("cumulative");
    });
  });

  // 2026-10-31 —— 规则：「每个可为 null 的字段都必须有一个能解释它的兄弟字段。」
  // 反过来：不许用 false 冒充「不知道」—— git_dirty=false 读起来是「干净树」。
  describe("nullable fields carry an explainer", () => {
    test("git identity: committed ⇒ note null & dirty boolean; absent ⇒ note non-null & dirty null", async () => {
      const b = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      if (b.git_commit !== null) {
        expect(b.build_identity_note).toBeNull();
        expect(typeof b.git_dirty).toBe("boolean");
      } else {
        expect(typeof b.build_identity_note).toBe("string");
        expect(b.git_dirty).toBeNull();   // 不知道 ≠ 干净
      }
    });

    test("kernel_started_at has its explainer sibling (already true, pinned so it stays true)", async () => {
      const b = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      if (b.kernel_started_at === null) expect(typeof b.kernel_started_at_note).toBe("string");
      else expect(b.kernel_started_at_note).toBeNull();
    });
  });

  // 2026-10-31 —— 三分类从「注释里的提醒」变成「字段上的必填标签」。
  //
  // 原来的问题：probe_nonce 恰好是对的，但那是因为**恰好这样写**；
  // 「凭证类要慎给」这四个字在代码里没有任何东西能检查。
  // ⇒ 现在每个字段必填一档，匿名合法与否由这一档推出来。
  describe("field classification is machine-checked, not documentation", () => {
    test("every field in the authenticated body carries a class (no untagged field may exist)", async () => {
      const body = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      const untagged = Object.keys(body).filter((k) => !HEALTH_FIELD_META[k]);
      expect(untagged).toEqual([]); // 空数组 ⇒ 没有「加字段忘了分类」的路
    });

    test("nothing in the anonymous whitelist is a landmark or a server-issued credential", () => {
      const illegal = [...PUBLIC_HEALTH_KEYS].filter((k) => !mayBePublic(HEALTH_FIELD_META[k]));
      expect(illegal).toEqual([]);
    });

    test("no landmark field actually appears in the anonymous body (the rule has a witness today: git_commit/pid/boot_id)", async () => {
      const authBody = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      const anonBody = await (await fetch(`${BASE}/health`)).json() as any;
      const landmarks = Object.keys(HEALTH_FIELD_META).filter((k) => HEALTH_FIELD_META[k].class === "landmark");
      // 分母：这份断言今天必须有分子可看，否则它是空的。
      // 2026-10-31 —— 分母**写死今天的数**（不是在运行时重算），这样：
      //   有人把某个字段从 landmark 改成 gauge ⇒ 分母下降 ⇒ 这里先红。
      //   若只检查「一个都不出现」，那次改动会让断言**更容易通过**。
      const present = landmarks.filter((k) => k in authBody).length;
      expect(present).toBeGreaterThanOrEqual(5);
      expect(landmarks.filter((k) => k in anonBody)).toEqual([]);
    });

    // 合成体见证：将来有人加一个「我们生成的凭证」字段，这一条必须红。
    test("projection drops unknown fields and landmarks; keeps only gauge + caller-supplied echo (synthetic witness)", () => {
      const out = projectPublicHealth({
        ok: true,
        git_commit: "deadbeef",
        future_issued_token: "abc123",   // 没登记 ⇒ 未分类 ⇒ 丢掉（默认安全方向）
        probe_nonce: "n-1",              // 请求方自带 ⇒ 保留
      });
      expect(out).toEqual({ ok: true, probe_nonce: "n-1" });
    });
  });

  // 2026-10-31 —— 白名单的另一半：**无死条目**。
  //
  // 已有的那条断言「匿名响应里每个键都在白名单内」防的是泄露；
  // 缺的这半边防的是「死条目」：白名单里的键若早就不再出现（改名/删除），
  // 它却一直躺在那里，看起来「这个字段是公开的」⇒ 下一个人把同名字段加回来时**默认就是公开的**。
  // ⇒ 白名单会从「审批记录」退化成「历史残留」。
  // 这与今晚那条镜像规则同构：否定断言必须配肯定断言，否则前者可被「永远不给」满足。
  test("no dead entries: every allow-listed key is actually served to anonymous callers", async () => {
    const { PUBLIC_HEALTH_KEYS } = await import("./server.js");
    const plain = await (await fetch(`${BASE}/health`)).json() as any;
    // 条件出现的键（只在带 X-Probe-Nonce 时出现）要在第二种请求里核对
    const probed = await (await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": "dead-entry-check" } })).json() as any;
    const seen = new Set([...Object.keys(plain), ...Object.keys(probed)]);
    const dead = [...PUBLIC_HEALTH_KEYS].filter((k) => !seen.has(k));
    expect(dead).toEqual([]);
  });

  test("exposes stable upload limits anonymously without exposing topology", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.limits).toEqual({
      max_upload_bytes: MAX_UPLOAD_BYTES,
      max_request_content_length: MAX_REQUEST_CONTENT_LENGTH,
    });
    expect(body.limits.max_request_content_length).toBeGreaterThan(body.limits.max_upload_bytes);
  });

  // 2026-10-31 —— 「这一次」的判据。
  //
  // /health 恒 200，所以「200」不证明是这台机器、这个进程、更不证明是**这个请求**。
  // 缓存层 / 前面的代理 / 上一次运行留下的响应，都给同一个 200。
  // 请求方带随机 nonce ⇒ 回显 ⇔ 这个响应生成于收到这个请求之后。
  test("echoes a caller-supplied probe nonce so 'this very request' is provable", async () => {
    const nonce = `p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": nonce } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as any;
    expect(body.probe_nonce).toBe(nonce);
    // 🔴 served_at 的断言只到「可解析」——它**不证明新鲜**，也不参与任何判据。
    //    真正证明“这一次”的是 probe_nonce（缓存不可能为它生成响应）。
    //    这里把它标清楚，否则它就会变成下一个 startedAt：看着像证据，却没有消费者。
    const servedAt = Date.parse(body.served_at);
    expect(Number.isFinite(servedAt)).toBe(true);
    expect(servedAt).toBeGreaterThan(0);
  });

  // 三件套的第③件：nonce 必须也出现在**响应之外**（服务端日志）。
  // 判据：一次探针之后，日志里该 nonce 出现**恰好 1 次**。
  //   == 1 ⇒ 这次请求真的到了这个进程（中间层伪造不了服务端日志）
  //   == 0 ⇒ 缺日志
  //   >  1 ⇒ 有人复用了同一个 nonce（重试没换）⇒ 那次读数不可信
  test("logs the probe nonce exactly once, outside the response", async () => {
    const nonce = `log-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const seen: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes(nonce)) seen.push(line);
      original(...args);
    };
    try {
      const res = await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": nonce } });
      await res.json();
    } finally {
      console.log = original;
    }
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("[health] probe nonce=");
  });

  // 2026-10-31 —— served_at 变成**常驻**：窗口的两端必须在同一个时钟域里。
  // 没有它，读者只能拿自己的钟去减 since ⇒ 偷偷假设两边时钟一致。
  // 而 probe_nonce 仍然只在带 X-Probe-Nonce 时出现（它是“这一次”的凭据）。
  test("default /health always carries served_at (same clock domain) but never probe_nonce", async () => {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json() as any;
    expect("probe_nonce" in body).toBe(false);
    expect(typeof body.served_at).toBe("string");
    const served = Date.parse(body.served_at);
    expect(Number.isFinite(served)).toBe(true);
    // 同一时钟域：served_at 不早于进程起点，且两次读数单调不减。
    expect(served).toBeGreaterThanOrEqual(Date.parse(body.startedAt));
    const second = await (await fetch(`${BASE}/health`)).json() as any;
    expect(Date.parse(second.served_at)).toBeGreaterThanOrEqual(served);
    // 2026-10-31 修订：**一律 no-store**。原来只在带 nonce 时设，
    // 而 /health 每个字段都是「此刻的读数」——304 会冻结 startedAt 而 counters 照涨，
    // 那正是 flapping 的假阳性形状。断言方向随之从 null 改成必须存在。
    expect((res.headers.get("cache-control") || "").toLowerCase()).toContain("no-store");
  });

  test("refuses a nonce it cannot echo verbatim instead of half-accepting it", async () => {
    // 注意：非 ASCII 那类（如「中文」）到不了这一层 —— fetch/undici 在**发送端**
    // 就拒绝非 token 的 header 值。所以这里只用能被发出去的非法值。
    for (const bad of ["has space", "semi;colon", "a".repeat(65)]) {
      const res = await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": bad } });
      const body = await res.json() as any;
      // 半接受会造出「看起来回显了、其实被改过」的值 —— 比不回显更糟。
      expect("probe_nonce" in body).toBe(false);
    }
  });

  test("CLI count source stays truthful: health.sse_connections == /api/stats/sse total (no fake 0)", async () => {
    // The CLI's `anet doctor` line reads health.sse_connections now
    // (was Object.keys(sse_sessions).length). This pins that aggregate to
    // the same number the auth-gated detail endpoint reports — so a live
    // hub with N connections shows N, never the "0 active" regression the
    // review caught. There is exactly one live SSE connection in setup.
    const health = await (await fetch(`${BASE}/health`)).json() as any;
    const detail = await (await fetch(`${BASE}/api/stats/sse`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect(health.sse_connections).toBe(detail.total);
    expect(health.sse_connections).toBeGreaterThanOrEqual(1);
  });

  test("does NOT expose SSE key detail: no sse_sessions field, no alias, no network id", async () => {
    const res = await fetch(`${BASE}/health`);
    const text = await res.text();
    const body = JSON.parse(text);
    expect("sse_sessions" in body).toBe(false);
    // The live connection's identifying strings must not appear anywhere
    // in the anonymous body.
    expect(text).not.toContain(userName);
    expect(text).not.toContain(userNetworkId);
  });
});

describe("f28a6c1b /health sse_sessions — auth-gated restoration for dashboard 'online' widget", () => {
  // The dashboard's server-side Next.js proxy (agent-network-dashboard
  // `app/api/hub/health/route.ts` → `hubFetch('/health')`) forwards the
  // logged-in user's V3 utok_ as `Authorization: Bearer …`. Anonymous
  // callers (public watchdog, internet strangers) still get NO
  // sse_sessions — that leak stays closed. Authenticated callers get
  // the sessions map scoped to their networks (ops sees all).

  test("regular member with valid utok_: sse_sessions present, filtered to member's networks", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Field must be present when authenticated — otherwise dashboard
    // "online" widget shows 0.
    expect("sse_sessions" in body).toBe(true);
    // Must contain the member's own SSE connection key.
    const ownKey = `${userNetworkId}:${userName}`;
    expect(body.sse_sessions[ownKey]).toBeGreaterThanOrEqual(1);
    // Watchdog aggregate contract unchanged.
    expect(body.sse_connections).toBeGreaterThanOrEqual(1);
  });

  test("admin with valid utok_: sse_sessions present, full unfiltered map (ops parity with /api/stats/sse)", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(true);
    // Admin sees the member's key even though they live in a different
    // network (admin scope spans everything, same as /api/stats/sse).
    const memberKey = `${userNetworkId}:${userName}`;
    expect(body.sse_sessions[memberKey]).toBeGreaterThanOrEqual(1);
    // Sanity: admin's view must match the auth-gated ops endpoint.
    const opsRes = await fetch(`${BASE}/api/stats/sse`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const ops = await opsRes.json() as any;
    expect(body.sse_sessions).toEqual(ops.sessions);
  });

  test("anonymous still gets NO sse_sessions (leak stays closed, mutation-red witness)", async () => {
    // This is the mutation-red assertion for the auth gate: if the
    // handler stops distinguishing anonymous from authenticated and
    // starts including sse_sessions unconditionally, this test turns
    // RED. Distinct from the older `does NOT expose SSE key detail`
    // test — that one guards against any regression restoring the
    // OLD unconditional leak; this one guards against a well-meaning
    // "just always send it if authenticated is optional" bug.
    const res = await fetch(`${BASE}/health`);
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(false);
  });

  test("invalid/garbage token: treated as anonymous — no sse_sessions", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: "Bearer utok_completely_fake_nonexistent" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // resolveRequestAuth returns null for unresolvable tokens, so the
    // handler must NOT fall through to "authenticated" branch. Otherwise
    // a bad token would degrade to "anonymous with sse_sessions" — that
    // would be the leak in a different disguise.
    expect("sse_sessions" in body).toBe(false);
  });
});

describe("#473 GET /api/stats/sse — detail survives, behind ops auth", () => {
  test("anonymous → 401", async () => {
    const res = await fetch(`${BASE}/api/stats/sse`);
    expect(res.status).toBe(401);
  });

  test("regular member token → 403 (detail spans every network)", async () => {
    const res = await fetch(`${BASE}/api/stats/sse`, { headers: { Authorization: `Bearer ${userToken}` } });
    expect(res.status).toBe(403);
  });

  test("admin → 200 with the full key breakdown (ops capability preserved)", async () => {
    const res = await fetch(`${BASE}/api/stats/sse`, { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.sessions[`${userNetworkId}:${userName}`]).toBeGreaterThanOrEqual(1);
  });

  test("legacy master token → 200 (ops path — restAuth null, isLegacyAuthToken)", () => {
    // COMMHUB_AUTH_TOKEN is captured at module import, so this path needs
    // a fresh process with the env set before boot (aggregate order can't
    // guarantee this file imports server.ts first). Subprocess, like the
    // patrol test. Reviewer flagged this path had code but no test.
    const script = `
      process.env.COMMHUB_AUTH_TOKEN = "master-secret-xyz";
      const { startHub } = await import("./src/server.js");
      const hub = startHub({ port: 0, hostname: "127.0.0.1" });
      const base = "http://127.0.0.1:" + hub.port;
      const anon = await fetch(base + "/api/stats/sse");
      const master = await fetch(base + "/api/stats/sse", { headers: { Authorization: "Bearer master-secret-xyz" } });
      const health = await fetch(base + "/health");
      const hb = await health.json();
      console.log("RESULT:" + JSON.stringify({
        anon: anon.status,
        master: master.status,
        masterOk: (await master.json()).ok,
        healthHasSseSessions: "sse_sessions" in hb,
      }));
      hub.stop(true);
      process.exit(0);
    `;
    const child = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, COMMHUB_DB: process.env.COMMHUB_DB || "/tmp/anet-473-master.db" },
      timeout: 15_000,
    });
    const out = new TextDecoder().decode(child.stdout);
    const m = out.match(/RESULT:(\{.*\})/);
    expect(m).not.toBeNull();
    const r = JSON.parse(m![1]);
    expect(r.anon).toBe(401);        // token configured → anonymous rejected
    expect(r.master).toBe(200);      // legacy master token → ops access
    expect(r.masterOk).toBe(true);
    expect(r.healthHasSseSessions).toBe(false); // /health still redacted with a token set
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────
// CR3 (4703b0e7) — M1-M7 matrix tests
// ─────────────────────────────────────────────────────────────────────
//
// Independent audit on aef48a3d showed the existing f28a6c1b tests
// pinned only the "anonymous vs authenticated" gate. The reviewer
// mutated `scopedSessions = sse.sessions` (unconditional) and got
// 11/11 green — meaning the *tenant-scope* invariant (a member sees
// only their own networks, cross-network is invisible) was not
// witnessed by any assertion, and a future refactor that broke the
// filter would ship silently.
//
// This block adds explicit tests for every shape the fork's auth
// decision distinguishes:
//   M1: utok_ member sees own network's sessions
//   M2: utok_ member does NOT see other network's sessions
//   M3: ntok_ (network-scoped token) is forced to the token's bound
//       network — the user's other networks are invisible even
//       though the underlying user is a member
//   M4: same user, utok_ vs ntok_ — utok_ sees union, ntok_ sees only
//       the token's bound network (mutation-red for the ntok_
//       "healthAuth.networkId ? [...] : db.all(...)" branch)
//   M5: membership revocation invalidates visibility immediately —
//       no cache; the next /health request reflects new membership
//   M6: observer keys (shape `\0netobs:<networkId>`; the getSSEStats
//       serializer renders leading NUL as printable `\\0`) are
//       classified through the shared PRINTABLE_OBSERVER_KEY_PREFIX
//       constant, not a re-typed literal. Mutation-red for the
//       constant drift (server.ts had `"netobs:"` without `\\0`
//       before this CR, so all observer keys silently fell through).
//   M7: two networks with the same alias — invisibility survives
//       key collision. Explicit assertion; M1/M2 hide-cover this
//       implicitly but M7 makes the property visible in review.
describe("f28a6c1b CR3 — network-scoped filter matrix (M1-M7)", () => {
  let mUserAToken = "";
  let mUserANet = "";
  let mUserAName = "";
  let mUserBToken = "";
  let mUserBNet = "";
  let mUserBName = "";
  let mAliceToken = "";       // utok_ (user-scoped)
  let mAliceNtok = "";        // ntok_ bound to mAliceNet
  let mAliceNet = "";
  let mAliceName = "";
  let mCarolToken = "";
  let mCarolNet = "";
  let mCarolName = "";
  let mUserAId = "";
  let mAliceId = "";
  let mCarolId = "";
  let mSameAliasName = "";    // used by M7 — two sessions, one per network

  const openReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];

  const startSse = async (base: string, name: string, netId: string, token: string) => {
    const res = await fetch(`${base}/events/${encodeURIComponent(name)}?network_id=${netId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`SSE subscribe failed (${res.status}) for ${name}@${netId}`);
    const reader = res.body!.getReader();
    await reader.read();
    openReaders.push(reader);
    return reader;
  };

  const startObserverSse = async (base: string, netId: string, token: string) => {
    // The observer endpoint is /events/network/:networkId — carries no
    // per-agent alias; server registers with the special observer key
    // shape `\0netobs:<networkId>` (see push.ts observerKey()).
    const res = await fetch(`${base}/events/network/${encodeURIComponent(netId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`observer SSE subscribe failed (${res.status}) for ${netId}`);
    const reader = res.body!.getReader();
    await reader.read();
    openReaders.push(reader);
    return reader;
  };

  beforeAll(async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pw = "BootstrapPw123Aa!";

    // userA — own network, plain member
    mUserAName = `cr3_userA_${suffix}`;
    const rA = register(mUserAName, pw, undefined, "seed");
    if (!rA.ok || !rA.token || !rA.network_id) throw new Error("userA register failed");
    mUserAToken = rA.token;
    mUserANet = rA.network_id;
    db.run("UPDATE users SET role = 'user' WHERE username = ?1", [mUserAName]);
    mUserAId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [mUserAName])!.user_id;

    // userB — different own network, plain member
    mUserBName = `cr3_userB_${suffix}`;
    const rB = register(mUserBName, pw, undefined, "seed");
    if (!rB.ok || !rB.token || !rB.network_id) throw new Error("userB register failed");
    mUserBToken = rB.token;
    mUserBNet = rB.network_id;
    db.run("UPDATE users SET role = 'user' WHERE username = ?1", [mUserBName]);

    // alice — own network + will also be added to userA's N_A, so
    // membership set = { mAliceNet (owner), mUserANet (member) }.
    // Her ntok_ (from register) is bound to mAliceNet only — the M3/M4
    // scope-enforcement test target.
    mAliceName = `cr3_alice_${suffix}`;
    const rAl = register(mAliceName, pw, undefined, "seed");
    if (!rAl.ok || !rAl.token || !rAl.network_token || !rAl.network_id) throw new Error("alice register failed");
    mAliceToken = rAl.token;
    mAliceNtok = rAl.network_token;
    mAliceNet = rAl.network_id;
    db.run("UPDATE users SET role = 'user' WHERE username = ?1", [mAliceName]);
    mAliceId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [mAliceName])!.user_id;
    // 多用户 Agent 权限:新成员默认只看授权 Agent;本测试测的是「完全信任的成员」旧语义,显式 agent_access=all。
    const addAlice = addNetworkMember(mUserANet, mAliceId, "member", mUserAId, { agentAccess: "all" });
    if (!addAlice.ok) throw new Error("addNetworkMember(alice→N_A) failed: " + addAlice.error);

    // carol — own network + will also be added to N_A, then revoked
    // in M5.
    mCarolName = `cr3_carol_${suffix}`;
    const rC = register(mCarolName, pw, undefined, "seed");
    if (!rC.ok || !rC.token || !rC.network_id) throw new Error("carol register failed");
    mCarolToken = rC.token;
    mCarolNet = rC.network_id;
    db.run("UPDATE users SET role = 'user' WHERE username = ?1", [mCarolName]);
    mCarolId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [mCarolName])!.user_id;
    const addCarol = addNetworkMember(mUserANet, mCarolId, "member", mUserAId, { agentAccess: "all" });
    if (!addCarol.ok) throw new Error("addNetworkMember(carol→N_A) failed: " + addCarol.error);

    // Live SSE sessions — one per network — so the filter has real
    // keys to include/exclude.
    await startSse(BASE, mUserAName, mUserANet, mUserAToken);
    await startSse(BASE, mUserBName, mUserBNet, mUserBToken);
    await startSse(BASE, mAliceName, mAliceNet, mAliceToken);
    await startSse(BASE, mCarolName, mCarolNet, mCarolToken);

    // M6 — observer stream for N_A (produces `\0netobs:<mUserANet>` key)
    await startObserverSse(BASE, mUserANet, mUserAToken);

    // M7 note: The dashboard-user SSE gate only lets a caller subscribe
    // as their own username (path 3, gate 4a). Standing up two sessions
    // named the same alias in two different networks would need two
    // separate "helper" users per network — significantly larger setup
    // than the property we're testing. M1/M2 already witness the shape
    // invariant (`<netId>:<alias>` keying) that would defeat collision:
    // cross-network same-alias would land at `<N_A>:<alias>` vs
    // `<N_B>:<alias>`, and M2's `expect(body.sse_sessions[<N_B>:...]).toBeUndefined()`
    // pins exactly the "wrong-tenant key is invisible" property. M7 is
    // therefore covered structurally; skipping the physical fixture.
    mSameAliasName = "";
  });

  afterAll(() => {
    for (const r of openReaders) { try { r.cancel(); } catch {} }
  });

  // ── M1 + M2 — utok_ member sees own network only ────────────────
  test("M1: utok_ member of N_A sees N_A sessions", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mUserAToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(true);
    expect(body.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeGreaterThanOrEqual(1);
  });

  test("M2: utok_ member of N_A does NOT see N_B sessions (cross-network invisibility)", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mUserAToken}` } });
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(true);
    // The N_B session (userB's own network) must not surface here —
    // this is the assertion the reviewer's "delete member filter"
    // mutation must break (currently was silently green).
    expect(body.sse_sessions[`${mUserBNet}:${mUserBName}`]).toBeUndefined();
  });

  test("M2b: utok_ member of N_B sees own but not N_A (reverse of M2)", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mUserBToken}` } });
    const body = await res.json() as any;
    expect(body.sse_sessions[`${mUserBNet}:${mUserBName}`]).toBeGreaterThanOrEqual(1);
    expect(body.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeUndefined();
  });

  // ── M3 + M4 — ntok_ single-network enforce ──────────────────────
  test("M3: alice utok_ (user-scoped) sees union — both mAliceNet and mUserANet", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mAliceToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sse_sessions[`${mAliceNet}:${mAliceName}`]).toBeGreaterThanOrEqual(1);
    expect(body.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeGreaterThanOrEqual(1);
  });

  test("M4: alice ntok_ (network-scoped, bound to mAliceNet) sees ONLY mAliceNet — N_A invisible even though she is a member", async () => {
    // This is the CR3 P1 fix's mutation-red target: if the /health
    // filter falls through to the `db.all(...)` union for ntok_
    // callers (i.e. drops the `healthAuth.networkId ? [...] : ...`
    // branch), this test flips because alice would suddenly see
    // mUserANet sessions through a token that only granted mAliceNet.
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mAliceNtok}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(true);
    // Own network — must be present.
    expect(body.sse_sessions[`${mAliceNet}:${mAliceName}`]).toBeGreaterThanOrEqual(1);
    // The other network she belongs to — ntok_ must NOT show it.
    expect(body.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeUndefined();
    // Sanity: an unrelated network she's not in must also be absent.
    expect(body.sse_sessions[`${mUserBNet}:${mUserBName}`]).toBeUndefined();
  });

  // ── M5 — membership revocation invalidates visibility ───────────
  test("M5: removing carol from N_A → next /health hides N_A sessions", async () => {
    // Pre-revocation: carol utok_ sees own network + N_A (userA lives
    // in N_A). Filter is per-request, no cache — so a revoke followed
    // by an immediate /health must reflect the new state.
    const before = await (await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${mCarolToken}` },
    })).json() as any;
    expect(before.sse_sessions[`${mCarolNet}:${mCarolName}`]).toBeGreaterThanOrEqual(1);
    expect(before.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeGreaterThanOrEqual(1);

    const rm = removeNetworkMember(mUserANet, mCarolId);
    if (!rm.ok) throw new Error("revoke failed: " + rm.error);

    const after = await (await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${mCarolToken}` },
    })).json() as any;
    expect(after.sse_sessions[`${mCarolNet}:${mCarolName}`]).toBeGreaterThanOrEqual(1);
    // The revoked N_A must be gone. Mutation-red for any caching of
    // the memberNets Set across requests.
    expect(after.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeUndefined();
  });

  // ── M6 — observer key format via shared constant ────────────────
  test("M6: observer keys (\\0netobs:<net>) are classified through the shared prefix constant, member sees own network's observer entry", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${mUserAToken}` },
    });
    const body = await res.json() as any;
    // Observer key surfaces with the printable prefix (`\\0netobs:`)
    // because push.ts's printableKey renders the NUL byte as `\\0`.
    // The filter must classify this as belonging to `mUserANet` and
    // include it in userA's view.
    const observerKey = `\\0netobs:${mUserANet}`;
    expect(body.sse_sessions[observerKey]).toBeGreaterThanOrEqual(1);
  });

  test("M6b: userB (not in N_A) does NOT see N_A's observer key — mutation-red for prefix constant drift", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${mUserBToken}` },
    });
    const body = await res.json() as any;
    const observerKey = `\\0netobs:${mUserANet}`;
    // If the prefix constant drifts (e.g. server.ts checks "netobs:"
    // without `\\0`), the classifier falls through to `key.split(":")[0]`
    // which for a `\\0netobs:` key returns the literal `\\0netobs` string
    // — that would never match memberNets, so the observer key gets
    // over-filtered but silently. That is the pre-CR3 bug shape;
    // this assertion pins the "not in wrong tenant's view" side.
    expect(body.sse_sessions[observerKey]).toBeUndefined();
  });

  // M7 removed — see beforeAll note. Cross-network same-alias
  // invisibility is covered structurally by M1/M2: keys are
  // `<netId>:<alias>`, so a `<N_A>:foo` vs `<N_B>:foo` collision
  // resolves via network prefix, which is what M2's cross-network
  // absence assertion already pins.
});

// ── #506 — same alias, two networks: /health sse_sessions must not cross ──
//
// #505 restored auth-gated `sse_sessions`. Its member filter parses the
// `{networkId}:{alias}` key prefix and keeps only the caller's networks.
// That was verified at merge time by a standalone validator, but a
// validator does not re-run on future refactors — this pins it.
//
// Construction: the dashboard-user SSE gate only lets a caller subscribe
// to its own username (gate 4a), so two users can never share one key that
// way. Gate 4b is the usable path: any member may subscribe to an alias
// that exists as a session IN THEIR network. So we seed a session row with
// the SAME alias in two different networks and have each network's own
// member subscribe to it — producing `{N_A}:{alias}` and `{N_B}:{alias}`
// live at once, which is exactly the collision the filter must separate.
//
// Mutation-red (verified by hand, see the PR): replacing the member filter
// with `scopedSessions = sse.sessions` turns the two "must NOT contain the
// other network's key" assertions red.
describe("#506 cross-network isolation of /health sse_sessions (same alias, two networks)", () => {
  const SHARED_ALIAS = "shared-alias-506";
  let aToken = "", aNet = "", aName = "";
  let bToken = "", bNet = "", bName = "";
  let readerA: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let readerB: ReadableStreamDefaultReader<Uint8Array> | null = null;

  beforeAll(async () => {
    const sfx = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pw = "BootstrapPw123Aa!";

    // Probe users are registered AFTER the suite's seed user, so neither is
    // the auto-admin first user. Asserted below rather than assumed: an
    // admin caller takes the unfiltered branch and would make these tests
    // pass while proving nothing.
    const ra = register(`h506_a_${sfx}`, pw, undefined, "seed");
    const rb = register(`h506_b_${sfx}`, pw, undefined, "seed");
    if (!ra.ok || !ra.token || !rb.ok || !rb.token) throw new Error("506 register failed");
    aName = `h506_a_${sfx}`; aToken = ra.token; aNet = ra.network_id ?? "";
    bName = `h506_b_${sfx}`; bToken = rb.token; bNet = rb.network_id ?? "";
    if (!aNet || !bNet || aNet === bNet) throw new Error("506 needs two distinct networks");
    db.run("UPDATE users SET role = 'user' WHERE username IN (?1, ?2)", [aName, bName]);

    // Same alias name, one session row per network → gate 4b lets each
    // network's own member subscribe to it.
    for (const [net, tag] of [[aNet, "a"], [bNet, "b"]] as const) {
      db.run(
        `INSERT INTO sessions (resume_id, alias, network_id, last_seen_at, status)
         VALUES (?1, ?2, ?3, datetime('now'), 'idle')`,
        [`s_506_${tag}_${sfx}`, SHARED_ALIAS, net],
      );
    }

    const sub = async (token: string, net: string) => {
      const res = await fetch(
        `${BASE}/events/${encodeURIComponent(SHARED_ALIAS)}?network_id=${encodeURIComponent(net)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status !== 200) throw new Error(`506 SSE subscribe failed (${net}): ${res.status}`);
      const rd = res.body!.getReader();
      await rd.read(); // connected frame → key registered
      return rd;
    };
    readerA = await sub(aToken, aNet);
    readerB = await sub(bToken, bNet);
  });

  afterAll(() => {
    try { readerA?.cancel(); } catch {}
    try { readerB?.cancel(); } catch {}
  });

  test("probe users are NOT admin (an admin caller would bypass the filter and prove nothing)", () => {
    for (const n of [aName, bName]) {
      const row = db.get<{ role: string }>("SELECT role FROM users WHERE username = ?1", n);
      expect(row?.role).not.toBe("admin");
    }
  });

  test("both same-alias keys are live at once (the collision actually exists)", async () => {
    // Read through the ops endpoint with the admin token: if this shows only
    // one of the two keys, the fixture never built the collision and the
    // isolation assertions below would be vacuous.
    const res = await fetch(`${BASE}/api/stats/sse`, { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions?: Record<string, number> };
    const keys = Object.keys(body.sessions ?? {});
    expect(keys).toContain(`${aNet}:${SHARED_ALIAS}`);
    expect(keys).toContain(`${bNet}:${SHARED_ALIAS}`);
  });

  test("member of network A sees only A's copy of the shared alias", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${aToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { sse_sessions?: Record<string, number> };
    expect(body.sse_sessions).toBeDefined();
    const keys = Object.keys(body.sse_sessions!);
    expect(keys).toContain(`${aNet}:${SHARED_ALIAS}`);
    expect(keys).not.toContain(`${bNet}:${SHARED_ALIAS}`);
    // Nothing from the other network at all, by any key shape.
    expect(keys.some((k) => k.startsWith(`${bNet}:`))).toBe(false);
  });

  test("member of network B sees only B's copy (reverse direction)", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${bToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { sse_sessions?: Record<string, number> };
    expect(body.sse_sessions).toBeDefined();
    const keys = Object.keys(body.sse_sessions!);
    expect(keys).toContain(`${bNet}:${SHARED_ALIAS}`);
    expect(keys).not.toContain(`${aNet}:${SHARED_ALIAS}`);
    expect(keys.some((k) => k.startsWith(`${aNet}:`))).toBe(false);
  });
});

// #2149 —— 错误路径**不能回显凭据**。
//
// 背景：2026-10-23 TMA云鲸 对 CommHub MCP 做只读扫描时收到 502，代理生成的
// 非 JSON 错误页把本次请求的鉴权相关头回显在正文里。那个 502 页很可能来自
// 调用链上的代理（本仓没有 502 生成逻辑），但**这条防线必须在本仓也有**：
// 任何 4xx/5xx 的响应体都不该把调用方递上来的 `Authorization` / `Cookie` /
// query 里的 token 原样吐回去 —— 一旦有人写出这种错误文案，它就会进日志、
// 进回执、进诊断归档。
//
// 做法是**注入一个形状像真凭据的 canary**，然后打一圈错误路径，断言响应正文
// 里一次都不出现它。canary 用 `ntok_` 前缀，正是本仓 `redactTokens` 认得的形状。
describe("#2149 error paths never echo credentials", () => {
  const CANARY = "ntok_LEAKCANARY_0123456789abcdef";
  const COOKIE = "session=COOKIELEAKCANARY0123456789";

  const paths: Array<{ method: string; path: string; body?: string }> = [
    { method: "GET", path: "/api/nope-not-a-route" },
    { method: "GET", path: "/api/requirements" },
    { method: "GET", path: "/api/nodes" },
    { method: "POST", path: "/mcp", body: "{not json" },
    { method: "POST", path: "/api/auth/login", body: JSON.stringify({ username: "nobody", password: "wrong-password-Aa1!" }) },
    { method: "POST", path: "/api/auth/me/avatar/upload" },
  ];

  test("no 4xx/5xx body contains the presented token, cookie or query secret", async () => {
    for (const c of paths) {
      const res = await fetch(`${BASE}${c.path}${c.path.includes("?") ? "&" : "?"}access_token=${CANARY}`, {
        method: c.method,
        headers: {
          authorization: `Bearer ${CANARY}`,
          cookie: COOKIE,
          "content-type": "application/json",
        },
        body: c.body,
      });
      const text = await res.text();
      expect(text.includes(CANARY)).toBe(false);
      expect(text.includes("LEAKCANARY")).toBe(false);
      expect(text.includes("COOKIELEAKCANARY")).toBe(false);
    }
  });
});
