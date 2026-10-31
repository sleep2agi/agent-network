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
import { createHash } from "node:crypto";
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
    // 2026-10-31 —— **窗口与值必须同响应**（外部复核 ③：窗口是分母，必须先固定再取数）。
    // 本仓的结构比「s1 = since; v = counter; s2 = since」更强：since 与各计数在**同一份载荷**里，
    // 单次读就原子，不存在跨越 reset 的长读。⇒ 这里把「同一个对象里」这件事钉住。
    expect(Object.prototype.hasOwnProperty.call(before.counters, "since")).toBe(true);
    expect(typeof before.counters.since).toBe("string");
    // 跨两次读的读者（如上面的 before/after 比较）必须自己比对 since —— 本条就是那个例子。
    expect(before.counters.since.length).toBeGreaterThan(0);
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

  // 2026-10-31 —— 出口清单里最后一行空 pinned_by：**请求体超限**（Bun maxRequestBodySize）。
  // 它是**运行时在 fetch() 之前**拒绝的：我们的代码一行都没跑 ⇒ 不可能计数。
  // 这一条钉住的是「不计数」，而它最容易怀疑的方向恰好相反（"那么大一个请求，肯定记了吧"）。
  test("KNOWN GAP: body over runtime maxRequestBodySize is NOT counted (rejected before fetch())", async () => {
    const read = async () => (await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any);
    const before = await read();
    const huge = "x".repeat(MAX_REQUEST_CONTENT_LENGTH + 1024);
    let status: number | null = null;
    let rejectedAtTransport = false;
    try {
      const r = await fetch(`${BASE}/api/task`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${userToken}` },
        body: huge,
      });
      status = r.status;
      await r.text();
    } catch {
      rejectedAtTransport = true;
    }
    const after = await read();
    // 形态有两条：运行时回 413，或传输层直接断（两者都算「没到我们的代码」）。
    // 本机实测：**status=413**（Bun 在 fetch() 之前就回了，响应体不是我们的 handler 生成的）。
    expect(rejectedAtTransport || status === 413).toBe(true);

    // 2026-10-31 —— **否定断言必须配镜像**：上面「没计数」在「这条路由根本不通」时也成立。
    // ⇒ 同一条路由 + 同一组鉴权头，用小请求体必须**走到 handler**（拿到 HTTP 状态码）。
    //   两条合起来才说明：计数没变是**因为这个请求太大了**，不是因为这条路本来就不计数。
    const control = await fetch(`${BASE}/api/task`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({}),
    });
    expect(control.status).toBeGreaterThanOrEqual(200);
    await control.text();
    if (after.counters.task_rejections.total !== before.counters.task_rejections.total) {
      throw new Error("已知缺口已被修复？超限请求体现在会计数了 —— 请更新 TASK_REJECTION_EXITS 与这条测试。");
    }
    expect(after.counters.task_rejections.total).toBe(before.counters.task_rejections.total);
  });

  // 2026-10-31 —— 出口清单里「before_route_table」那一行原本 pinned_by 为空（= 缺口）。
  // 补上它的钉：未匹配的 /api/* 在路由表之前就 404，**不经过 handler，也不计数**。
  // 这一条同时是「清单要能被一次坏输入打出来」的实例（对方那句）。
  test("KNOWN GAP: unmatched /api/* route 404 is NOT counted (route table rejects before handler)", async () => {
    const read = async () => (await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any);
    const before = await read();
    const r = await fetch(`${BASE}/api/definitely-not-a-route-xyz`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({}),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const after = await read();
    if (after.counters.task_rejections.total !== before.counters.task_rejections.total) {
      throw new Error("已知缺口已被修复？404 出口现在会计数了 —— 请更新 TASK_REJECTION_EXITS 与这条测试。");
    }
    expect(after.counters.task_rejections.total).toBe(before.counters.task_rejections.total);
  });

  // 2026-10-31 —— **出口清单的分母要有来源**（外部复核 ②）：
  // 六行以前只活在注释里；现在它是数据，这条断言把「表」与「钉住它的测试」绑在一起。
  // 2026-10-31 —— **白名单条目必须指得出读者**（外部复核 ⑤ 第 ②′ 问：路标还是仪表）。
  // 三分类（landmark/gauge/credential）回答「该不该给」，这张表回答「谁在读」。
  // 关键是它**跨源**：声明 reader=cli 的键，必须在 agent-network/src 里真的出现，
  // 否则「有人在读」就只是白名单里的一个愿望。
  test("every anonymous key names a reader, and reader=cli is cross-checked against the CLI source", async () => {
    const { PUBLIC_HEALTH_KEYS } = await import("./server.js");
    const { PUBLIC_HEALTH_KEY_READERS } = await import("./health-anon-readers.js");
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    // ① 覆盖：白名单里每个键都要有读者登记，反之亦然（两边同集合，防「删了白名单留下登记」）
    expect(Object.keys(PUBLIC_HEALTH_KEY_READERS).sort()).toEqual([...PUBLIC_HEALTH_KEYS].sort());

    // ② 读者类别必须在闭集里（防「reader: 某个系统」这种自由文本）
    for (const [key, entry] of Object.entries(PUBLIC_HEALTH_KEY_READERS)) {
      expect(["cli", "probe", "external", "operator"]).toContain(entry.reader);
      // 「同上」在这一类表里是无效理由：它把理由指向另一行，而那行改了它不会跟着改。
      expect(entry.why).not.toContain("同上");
      expect(entry.why.length).toBeGreaterThan(3);
      // external 必须写明「未验」或指明是哪类系统 —— 两种都接受，但不能什么都不说
      if (entry.reader === "external") expect(entry.why.length).toBeGreaterThan(10);
      expect(key.length).toBeGreaterThan(0);
    }

    // ③ 跨源：reader=cli 必须能在客户端源码里找到这个名字
    // 两个根都要扫：`src/`（库）与 `bin/`（CLI 入口）。第一版只扫了 src，
    // 于是把「只在 cli.ts 里读」的 4 个键误判成「没有读者」——
    // 这正是这类跨源断言最容易出的错：**读者在，只是不在我扫的那个目录里**。
    const roots = [
      join(import.meta.dir, "..", "..", "agent-network", "src"),
      join(import.meta.dir, "..", "..", "agent-network", "bin"),
    ];
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
      }
      return out;
    };
    const cliSource = roots.flatMap((r) => walk(r)).map((f) => readFileSync(f, "utf8")).join("\n");
    const cliKeys = Object.entries(PUBLIC_HEALTH_KEY_READERS).filter(([, e]) => e.reader === "cli").map(([k]) => k);
    expect(cliKeys.length).toBeGreaterThan(0);
    const missing = cliKeys.filter((k) => !new RegExp(`\\b${k}\\b`).test(cliSource));
    if (missing.length) throw new Error(`声明 reader=cli 但这些键在客户端源码里找不到：${missing.join(", ")}`);
  });

  test("rejection exit inventory: 6 rows, and every counted row names a pinning test", async () => {
    const { TASK_REJECTION_EXITS } = await import("./rejection-counters.js");
    expect(TASK_REJECTION_EXITS.length).toBe(6);
    // counted 的位置必须有测试钉住（空串 ⇒ 缺口，红）
    for (const row of TASK_REJECTION_EXITS) {
      if (row.counted) expect(row.pinned_by.length).toBeGreaterThan(0);
    }
    // 2026-10-31 —— **空 pinned_by 必须自报家门**（外部复核 (b)：「兜底值必须说出自己是兜底」）。
    // 空的 pinned_by 与「忘了填」在数据里长得一样 ⇒ 要求 `pinned_by` 与 `gap_reason` **恰好填一个**。
    // 两个都填 = 自相矛盾（既说钉住了又说钉不住）；都不填 = 又回到静默缺口。
    for (const row of TASK_REJECTION_EXITS) {
      const hasPin = row.pinned_by.length > 0;
      const hasGap = (row.gap_reason ?? "").length > 0;
      expect(hasPin !== hasGap).toBe(true);
    }
    // 声明为缺口的行：目前恰好 1 行（error_hook_500），且理由里必须同时写出「卡在哪」与「什么能解锁」
    const gaps = TASK_REJECTION_EXITS.filter((r) => !r.pinned_by.length);
    expect(gaps.map((r) => r.position)).toEqual(["error_hook_500"]);
    expect(gaps[0].gap_reason).toContain("解锁条件");

    // 反过来：未计数的位置若已有测试钉住，名字必须非空 —— 否则「钉住了」只是注释
    const pinnedNames = TASK_REJECTION_EXITS.map((r) => r.pinned_by).filter(Boolean);
    expect(pinnedNames.length).toBeGreaterThanOrEqual(3);
    // 位置名必须唯一（否则两行描述同一处，比例就重复计了）
    expect(new Set(TASK_REJECTION_EXITS.map((r) => r.position)).size).toBe(TASK_REJECTION_EXITS.length);

    // 2026-10-31 —— **「数对、集合错」**（外部复核 164b3e5e 那条：14 个块数得对，
    // 而「13 个公共头」不成立，因为 14 个头集合的交集是空集）。
    // 本表同款：有 2 个位置装了表（一个**计数**），但链路必须先过前面若干个位置 ——
    // 所以「链路覆盖」只能是**前缀长度**，不能是「计数 / 总数」。
    const instrumented = TASK_REJECTION_EXITS.filter((r) => r.counted).length;
    let prefix = 0;
    for (const r of TASK_REJECTION_EXITS) { if (r.counted) prefix += 1; else break; }
    expect(instrumented).toBe(2);          // 装了几个点（计数）
    expect(prefix).toBe(0);                // 链路覆盖（前缀）—— 第 1 个位置就是洞
    // 反例守卫：一旦数错集合（把第 1 行改成 counted），前缀与计数会一起变 —— 那时必须改比例与注释
    expect(instrumented).not.toBe(prefix);

    // 2026-10-31 —— **构造自洽的断言不会以我们关心的方式失败**（外部复核 164b3e5e：
    // 「14 个块数得对，但那是构造自洽的断言，不会以我们关心的方式失败」）。
    // 上面那些都是对着**自己声明的表**断言 —— 它只证明「表没被改」，不证明「表描述的世界还在」。
    // ⇒ 加一条**跨源**检查：计数器的主语（/api/task）必须真的出现在生成的路由清单里。
    //    若有人改了路由名而没改计数器，这条会红；而只对自己的表断言的测试永远不会。
    const { readFileSync } = await import("node:fs");
    // 仓根的 docs/（从 server/src 出发是 ../../docs），不是 server/docs
    const table = JSON.parse(readFileSync(new URL("../../docs/rest-route-table.json", import.meta.url), "utf8"));
    expect(table.rows.some((r: any) => r.path === "/api/task")).toBe(true);
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
    const read = async () => (await (await fetch(`${BASE}/health`)).json() as any).served_at;
    const t1 = await read();
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, 250));
    const t2 = await read();
    const elapsed = Date.now() - startedAt;
    const delta = Date.parse(t2) - Date.parse(t1);
    expect(delta).toBeGreaterThan(0);   // 真的走了（否定「常量」）
    // 2026-10-31 —— (b) 容差必须**大于被测时钟可能的最大步进**，否则一次 NTP 步进就假红，
    //   而假红会被读成「字段坏了」，实际是「时钟动了一下」。
    //   NTP：slew 阈 128ms，超阈值即步进（秒级）。⇒ 容差 5s，不是 1s。
    //   ⚠️ 这条量的是**速率**（差 / 等待）；「时钟偏置」（绝对值）在 epoch_delta_ms 那条，
    //      两者不能共用容差 —— 它们量的是两件事。
    const STEP_ALLOWANCE_MS = 5000;
    expect(Math.abs(delta - elapsed)).toBeLessThanOrEqual(STEP_ALLOWANCE_MS);
    // 2026-10-31 —— (a) 「必须变」没排除「以错误的方式变」：
    //   每次请求变 / 每秒变 / 每次部署变 都满足「差 > 0」，而语义完全不同。
    //   两次读数上，「每次请求变」与「每秒变」同形 ⇒ 需要第二条锁定**时间尺度**：
    //   在同样的等待里多打若干请求，差值不应随请求数增长。
    const t3 = await read();
    const burstStart = Date.now();
    const BURST = 20;
    for (let i = 0; i < BURST; i++) await read();   // 20 次额外请求
    await new Promise((r) => setTimeout(r, 250));
    const t4 = await read();
    const burstElapsed = Date.now() - burstStart;
    const burstDelta = Date.parse(t4) - Date.parse(t3);
    // ⚠️ 这一条的容差**不能**用上面那个时钟步进容差，否则判据被它自己压平：
    //   20 次请求 × 每次 +150ms 的假实现 = +3000ms，而我第一版给的是 +5000ms ⇒ 照样绿。
    //   （witnessed-red 抓到了：把 served_at 改成每次请求 +150ms，那一版仍然 68 pass。）
    //   ⇒ 这里用「与请求数无关」的紧口：20 次请求带来的增量必须远小于其漂移规模。
    const PER_REQUEST_ALLOWANCE_MS = 1000;   // 20 次请求合计只许 +1s；每请求漂移 ≥50ms 就会红
    expect(burstDelta).toBeLessThanOrEqual(burstElapsed + PER_REQUEST_ALLOWANCE_MS);
    expect(burstDelta).toBeGreaterThanOrEqual(0);
  });

  // 2026-10-31 —— 误差界必须有**地板**。
  //   uptime×|delta|/value 只覆盖尺子自己的舍入，delta=0 时报 0；
  //   而 btime 是整秒（±500ms）、jiffies 是 10ms 量化 —— 这两项不会因为尺子变准而消失。
  // ⇒ 判据：误差界的最小值是「尺子之外的误差之和」，不是 0。
  describe("clk_tck 的误差界与守卫的可检出下限", () => {
    test("error bound never reports 0 (floor from btime seconds + jiffies quantum)", async () => {
      const b = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      if (b.kernel_started_at === null) return; // 非 Linux：这一族本来就不发布
      expect(typeof b.kernel_started_at_error_ms).toBe("number");
      expect(b.kernel_started_at_error_ms).toBeGreaterThanOrEqual(510);
      // 即使 delta=0（尺子最准的那一刻），地板仍然在
      if (b.clk_tck_delta === 0) expect(b.kernel_started_at_error_ms).toBeGreaterThanOrEqual(510);
    });

    // 2026-10-31 —— 阈值决定了它抓得住多大的异常；不报换算，读者无法区分
    //   「没有挂起过」与「挂起太小，抓不到」—— 两者都读成 derived。
    test("publishes the smallest suspend the 1% guard could actually catch", async () => {
      const b = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      if (b.kernel_started_at === null) return;
      expect(typeof b.clk_tck_guard_min_suspend_s).toBe("number");
      // relErr ≈ 挂起 / **机器** uptime ⇒ 1% ⇒ 0.01 × host_uptime_s
      // ⚠️ 不是 b.uptime（那是进程的），两者相差可以上万倍 —— 这一条正是在钉这个区别
      expect(typeof b.host_uptime_s).toBe("number");
      const expected = 0.01 * b.host_uptime_s;
      expect(Math.abs(b.clk_tck_guard_min_suspend_s - expected)).toBeLessThanOrEqual(2);
      expect(b.clk_tck_guard_min_suspend_s).toBeGreaterThan(0);
      // 机器 uptime ≥ 进程 uptime（本进程是这台机器上后起的）—— 两个量确实不同名不同物
      expect(b.host_uptime_s).toBeGreaterThanOrEqual(b.uptime);
      // 2026-10-31 —— 原始估计与阈值判定分开报：
      //   本机实测 estimate=99.35 而 suspend_total_s=0 ⇒ 被打回 assumed 不是挂起造成的，是估计器偏置。
      //   没有这一格，那句「为什么是 assumed」说不出来（只能看到 assumed）。
      expect(typeof b.clk_tck_estimate).toBe("number");
      expect(Math.abs(b.clk_tck_estimate - 100)).toBeLessThan(10);
      if (b.clk_tck_source === "confirmed") expect(Math.abs(b.clk_tck_estimate - 100)).toBeLessThan(0.5);
    });

    // 2026-10-31 —— 把**推导的前提**做成读数：累计挂起 = (now − btime) − /proc/uptime。
    // 没有它，derived 与 confirmed 在读数上只差一个容差，而「没挂起过」这个前提在两者之外。
    test("derived carries its premise: suspend_total_s is published (null ≠ 0)", async () => {
      const b = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      if (b.kernel_started_at === null) return;
      expect("suspend_total_s" in b).toBe(true);
      const s = b.suspend_total_s;
      expect(s === null || (typeof s === "number" && s >= 0)).toBe(true);
      // 前提与结论必须一致：若已挂起超过守卫的可检出下限，就不该还报 confirmed
      if (typeof s === "number" && s > (b.clk_tck_guard_min_suspend_s ?? Infinity)) {
        expect(b.clk_tck_source).not.toBe("confirmed");
      }
    });
  });

  // 2026-10-31 —— `/health` 的 validator 语义：**不发 ETag，且 `If-None-Match: *` 也回 200**。
  //
  // 起因（外部复核在同族端点上实测到的）：当响应体里带时间/计数器时，
  // 「回不回 304」从头到尾不由 cache-control 决定：
  //   · Express 的默认 etag 对每个 body 都变 ⇒ validator 永远匹配不上 ⇒ 一次 If-None-Match 测不出任何东西
  //   · `if-none-match: *` 会**直接跳过** etag 比较（RFC 9110 §13.1.2：资源存在 ⇒ 304）
  // ⇒ 本仓的选择是：不发 ETag（没有 validator 可匹配），并且对 `*` 也回 200 ——
  //   因为我们每一份正文都是「此刻的读数」，回 304 等于告诉客户端「你手里那份是当前的」，那是假话。
  //   这条断言把「不发的决定」和「对 * 的例外」都钉住；否则它只是注释里的一句话。
  describe("/health 的 validator 语义", () => {
    test("no ETag at all, and If-None-Match: * still returns 200 with fresh body", async () => {
      const a = await fetch(`${BASE}/health`);
      expect(a.headers.get("etag")).toBeNull();          // 没有 validator 可匹配
      expect(a.headers.get("cache-control")).toBe("no-store");
      const b = await fetch(`${BASE}/health`, { headers: { "If-None-Match": "*" } });
      expect(b.status).toBe(200);                        // RFC 会要 304；我们是**故意的例外**
      const bodyB = await b.json() as any;
      const bodyA = await a.json() as any;
      // 而且正文确实是新的（不是把上一份原样回给条件请求）
      expect(typeof bodyB.served_at).toBe("string");
      expect(Date.parse(bodyB.served_at)).toBeGreaterThanOrEqual(Date.parse(bodyA.served_at));
    });
  });

  // 2026-10-31 —— 补的是**反方向**：既有的
  //   "every field in the authenticated body carries a class"
  // 只查 payload → meta（加字段忘了分类）；它查不到 meta → payload（**声明了一个永远不出现的字段**）。
  // 后者是「死 meta」：一条 meta 写着 class/granularity/frozen_at_boot，而没有任何响应会带它，
  // 于是它会一直正确地描述一个不存在的东西 —— 并且看起来比没有更权威。
  // （写这条时我以为两个方向都没覆盖；实测 witness 表明正向早就有，只有反向是空的。）
  test("every field in the full payload has meta, and every meta appears in it", async () => {
    const full = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    const payloadKeys = Object.keys(full);
    const metaKeys = Object.keys(HEALTH_FIELD_META);
    const undocumented = payloadKeys.filter((k) => !metaKeys.includes(k)).sort();
    // **有条件出现的字段**：meta 里有、默认响应里没有。每一项都必须能说出触发条件，
    // 并且在这里当场把它触发一次 —— 否则「有条件出现」与「写错了」同形。
    const conditional: Record<string, string> = {
      probe_nonce: "只在带 X-Probe-Nonce 时出现",
    };
    const phantom = metaKeys.filter((k) => !payloadKeys.includes(k) && !(k in conditional)).sort();
    expect({ undocumented, phantom }).toEqual({ undocumented: [], phantom: [] });
    // 把每个条件字段真的触发一次
    for (const k of Object.keys(conditional)) {
      if (k !== "probe_nonce") continue;
      const withNonce = await (await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": "meta-bijection" } })).json() as any;
      expect(Object.prototype.hasOwnProperty.call(withNonce, k)).toBe(true);
    }
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

    // 2026-10-31 —— 兼容字段 `license` 与三态之间的**配对约束**（外部复核在本仓指到的那个洞）：
    //   `license: "none"` 同时表示 absent 与 unknown ⇒ 单看它无法支撑「是否商业授权」。
    //   这一条把它的歧义**限定在一个范围内**：只有这两种状态才允许渲染成 "none"；
    //   反过来，known 时 "none" 绝不允许出现（那才是真的把「有授权」读成「没有」）。
    const legacy = body.license;
    if (legacy === "none") expect(["absent", "unknown"]).toContain(st.kind);
    if (st.kind === "known") expect(legacy).not.toBe("none");
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

    // 2026-10-31 —— **witness 已做隔离版**（上一轮记的是「未验」，本轮转「已验」）：
    //   只在**鉴权分支**丢掉 sse_sessions（匿名投影一字未动）
    //   ⇒ 上面三条否定断言**全绿**（"不存在"仍然成立），失败点恰好落在下面第 446 行的镜像上。
    //   ⇒ 这就是「否定断言单独的强度是零」的现场：它抓不住「鉴权侧丢键」，镜像抓得住。
    //
    // 2026-10-31 —— **否定断言必须配镜像**（外部复核：「一条否定断言单独的强度是零 ——
    // 它和『这里什么都没有』无法区分」）。
    // 上面三条都是「不出现在匿名里」；若投影实现坏成「什么都不给」，它们仍然全绿。
    // ⇒ 镜像：同一 URL 在**鉴权态**下，这几个键必须真的出现。
    const authed = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect("git_commit" in authed).toBe(true);
    expect("counters" in authed).toBe(true);
    expect("sse_sessions" in authed).toBe(true);
    // 再强一格：鉴权投影必须**严格大于**匿名投影（否则「白名单」可能只是把两边都截了）
    expect(Object.keys(authed).length).toBeGreaterThan(Object.keys(body).length);
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
    // 2026-10-31 —— confirmed 不能只说「相等」，必须报「差多少」+ 误差界；
    // 而且差值大到不可能是舍入时，source 必须退回 assumed（典型成因：机器挂起过）。
    if (body.clk_tck_source === "assumed") {
      expect(body.clk_tck_source).toBe("assumed");
    } else {
      expect(typeof body.clk_tck_delta).toBe("number");
      expect(typeof body.kernel_started_at_error_ms).toBe("number");
      expect(Math.abs(body.clk_tck_delta)).toBeLessThan(0.01 * body.clk_tck_assumed);
    }
    expect(["agree", "disagree", "unknown"]).toContain(body.epoch_agreement);

    if (body.kernel_started_at !== null) {
      expect(typeof body.kernel_started_at).toBe("string");
      expect(body.kernel_started_at_note).toBeNull();
      // 🔴 关键：发布条件**不再**是「与自报一致」
      //    实测这台机器上应当一致 ⇒ 断言的是一条**真实现象**，而不是发布条件的复述
      const delta = Math.abs(Date.parse(body.kernel_started_at) - Date.parse(body.startedAt));
      if (body.epoch_agreement === "agree") expect(delta).toBeLessThanOrEqual(10_000);
      // 2026-10-31 —— 「两次读数相同」只证明相同，证明不了「它会变」：
      // 一个写死的常量头与真的 startedAt 在那个测法下完全一样。
      // 我们的独立生产者是**内核**：epoch_delta_ms = (btime + ticks/CLK_TCK) − startedAt。
      // ⇒ 只有当 startedAt 与内核推出的时刻一致时，它才不是抄来的配置值。
      if (body.epoch_agreement === "agree") {
        expect(typeof body.epoch_delta_ms).toBe("number");
        expect(Math.abs(body.epoch_delta_ms)).toBeLessThanOrEqual(10_000);
        expect(body.kernel_started_at).not.toBeNull();
      }
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

  // 2026-10-31 —— `limits` 故意保持匿名（dashboard 上传代理开流前要读，且已在公开文档里），
  // 但「故意公开」不等于「可以长东西」：它必须只有静态容量上限，不许出现路径/主机/用户。
  test("anonymous `limits` carries ONLY static byte caps (public by decision, pinned in shape)", async () => {
    const b = await (await fetch(`${BASE}/health`)).json() as any;
    expect(Object.keys(b.limits).sort()).toEqual(["max_request_content_length", "max_upload_bytes"]);
    for (const v of Object.values(b.limits)) expect(typeof v).toBe("number");
    // 反例守卫：路径/用户名/主机名一类的字符串一旦混进来，这条会红
    expect(JSON.stringify(b.limits)).not.toMatch(/\/|[A-Za-z]:\\|@/);
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
      // 2026-10-31 —— 镜像必须针对**同一个属性在另一种条件下确实存在**，
      // 而不是「这个响应是 JSON」（那只排除了取错对象）。
      const authed = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      expect(typeof authed.git_commit).toBe("string");   // 同一 URL、登录态下确实有指纹
      // ⇒ 于是「匿名不带」才是一个有对照的读数
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
  // 2026-10-31 —— **0 只能作为读数出现，不能冒充「没测」**（外部复核 ④：
  // 「『未取』被系统翻译成『正常』——而零恰好是最好看的那个值」）。
  // event_loop 的计数类字段天然可能是 0（真的没停顿）。所以必须能区分：
  //   窗口存在 ⇒ 0 是「这段时间内没有停顿」（读数）
  //   窗口为零长 ⇒ 0 是「还没测」（不是读数）
  // 断言：窗口两端必须同时存在，且 since ≤ observed_at；窗口为空时**不得**声称 0 是结论。
  test("zero-valued stall counters carry a window, so 0 is a reading rather than 'not measured'", async () => {
    const body = await (await fetch(`${BASE}/health`)).json() as any;
    const el = body.event_loop;
    const since = Date.parse(el.since), observed = Date.parse(el.observed_at);
    expect(Number.isFinite(since)).toBe(true);
    expect(Number.isFinite(observed)).toBe(true);
    expect(observed).toBeGreaterThanOrEqual(since);
    if (el.stall_count === 0) {
      // 0 停顿 + 正长度窗口 = 读数；0 停顿 + 零长度窗口 = 还没测，此时不能当成「没有停顿」
      expect(observed - since).toBeGreaterThan(0);
    }
  });

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
    // 2026-10-31 —— 「包含」不是值级：`toContain("no-store")` 允许
    // `private, no-store, max-age=31536000`（两者矛盾）而不红，而「被加料」正是缓存头最危险的改法。
    // 合法值唯一（就是 no-store）⇒ 用「等于」。
    expect(plain.headers.get("cache-control")).toBe("no-store");

    // 2026-10-31 —— 先分清「不可能 304」与「可能 304 但服务端拒绝了」：
    // 没有 ETag 时，条件请求必然 200，那条断言是**空的**（vacuous），
    // 而它与「实测过 304 不存在」在报告里长得一样。
    const etag = plain.headers.get("etag");
    if (etag === null) {
      // 明确记录：本服务不产生 ETag ⇒ 304 在协议层不可能发生；这一格不靠条件请求证明。
      expect(plain.headers.get("etag")).toBeNull();
    }
    const conditional = await fetch(`${BASE}/health`, {
      headers: { "cache-control": "no-cache", "if-none-match": etag ?? "*" },
    });
    expect(conditional.status).toBe(200);   // 304 会让 startedAt 冻结、counters 照涨 = 假 flapping
    const body = await conditional.json() as any;
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.served_at).toBe("string");
  });

  // 2026-10-31 —— 「读不到」不许渲染成 0。
  // 0 是一个合法值，而它会被当成事实；「0 个会话」与「读库失败」在读数上同形。
  // 兄弟字段 status_reasons 里已有 db_unreadable ⇒ 两者一起读才完整。
  test("sessions_count is a number when the DB is readable, and null (not 0) when it is not", async () => {
    const b = await (await fetch(`${BASE}/health`)).json() as any;
    const dbBad = Array.isArray(b.status_reasons) && b.status_reasons.includes("db_unreadable");
    if (dbBad) {
      expect(b.sessions_count).toBeNull();
    } else {
      expect(typeof b.sessions_count).toBe("number");
    }
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

  // 2026-10-31 —— 契约测试，不是碰撞测试：用**对抗输入**证明「不在白名单里就进不去」，
  // 而不是去证明某个具体分隔符撞不撞。
  // （外部复核的原话：只写「不能碰撞」的测试，测的是实现；契约是「键集恰好是这些」。）
  test("adversarial keys (separator-in-name / extra / landmark) never survive the projection", () => {
    const adversarial = {
      "ok\u0000version": 1,          // 含分隔符的键名：任何 join 方案都会在这里含糊
      "ok,version": 2,                // 逗号分隔符
      ok: true,                       // 合法
      git_commit: "deadbeef",         // landmark：必须被丢
      sessions_count: 3,              // 合法
      "__proto__": { polluted: true },// 原型污染形态
    } as Record<string, unknown>;
    const out = projectPublicHealth(adversarial);
    const keys = Object.keys(out).sort();
    // 断言的是**键集恰好**，不是「某些键被丢」—— 后者在「什么都丢」时也成立
    expect(keys).toEqual(["ok", "sessions_count"]);
    expect((out as any)["ok\u0000version"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("polluted");
  });

  // 2026-10-31 —— 形状测试必须先证明**输入彼此不同**，否则它测的是同一个形状 N 次。
  // 顺序不能反：先断言两两不等，再断言各自的行为。
  // 2026-10-31 —— 夹具的身份写进**测试名**（每次运行都会打印、且不依赖测试通过）。
  // 有人后加一份重复的 ⇒ 名字里的 sha 立刻变，diff 里就能看见，而不用等断言红。
  const WITNESS_SET_SHA = createHash("sha256")
    .update(JSON.stringify({ unknown_field: { ok: true }, landmark: { git_commit: "deadbeef" } }))
    .digest("hex")
    .slice(0, 8);
  test(`the four projection witnesses are pairwise distinct inputs (fixtureset=${WITNESS_SET_SHA})`, () => {
    const cases = {
      unknown_field: { ok: true, future_issued_token: "abc" },   // 未登记 ⇒ 丢
      landmark: { ok: true, git_commit: "deadbeef" },            // landmark ⇒ 丢
      gauge: { ok: true, sessions_count: 3 },                    // gauge ⇒ 留
      echo: { probe_nonce: "n-1" },                              // credential(echo) ⇒ 留
    };
    const serialized = Object.entries(cases).map(([k, v]) => [k, JSON.stringify(v)] as const);
    // 2026-10-31 —— 报「哪一对相等」，不是只报「存在相等」。
    // 只报「存在相等」时，红的人要在四份夹具里自己找，而他通常先怀疑新加的那份；
    // 而问题可能在一份旧的里（旧的那份才是标准）。
    const equalPairs: string[] = [];
    for (let i = 0; i < serialized.length; i += 1) {
      for (let j = i + 1; j < serialized.length; j += 1) {
        if (serialized[i][1] === serialized[j][1]) {
          equalPairs.push(`${serialized[i][0]} == ${serialized[j][0]}`);
        }
      }
    }
    expect(equalPairs).toEqual([]);
    // 2026-10-31 —— 这条前置断言自己也要有反例，否则它只是在数份数：
    // 用「内容不同但长度相同」的对，证明判定按**内容**而不是按长度/份数。
    const sameLenDifferent = [{ a: "xy" }, { a: "yz" }];
    expect(JSON.stringify(sameLenDifferent[0]).length).toBe(JSON.stringify(sameLenDifferent[1]).length);
    expect(JSON.stringify(sameLenDifferent[0])).not.toBe(JSON.stringify(sameLenDifferent[1]));

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
    // 例外必须显式：served_at 长得一模一样，但它会变。
    // ⚠️ 但「不被冻结」只是一个**否定**，它在很多实现上都成立（没打标 / 标打错 / 字段不存在）。
    // ⇒ 它的正面断言在别处：「served_at actually advances with the wall clock」——
    //   那条要求**连续两次读数不同**，是「必须变」而不是「没有被打标」。
    expect(frozen).not.toContain("served_at");
    expect(HEALTH_FIELD_META.served_at.frozen_at_boot).toBeUndefined();
  });

  // 2026-10-31 —— **分类不决定「变不变」，还缺「窗口」这个参数**（外部复核 (e)：
  // 「`startedAt` 属 instance，却会在 failover 时变，正是你自己那张表的反例；
  //   处理分三态 pinned / excluded / allowed，而不是混进白名单」）。
  //
  // 本仓的 `frozen_at_boot: true` 到此为止只是一条**声明**：没有任何断言把它和
  // 「同一个进程在窗口内读两次，这个值不变」对上。声明与行为之间没有桥，
  // 于是分类错了只会被下一个人读出来，不会被测试读出来。
  //
  // 判据（三态在这里的落法）：
  //   pinned   = frozen_at_boot:true  ⇒ 窗口内必须**逐字节相同**，变了就红
  //   allowed  = 没打 frozen 标      ⇒ 变不变都可以，本测试不管
  //   excluded = 会变且不该被 pinned  ⇒ 必须存在并在正向对照里出现（见下）
  // 窗口显式：WINDOW_MS 写在断言里，而不是「两次读一下大概就行」。
  test("frozen_at_boot fields really do not change within a declared window", async () => {
    const { HEALTH_FIELD_META } = await import("./server.js");
    const WINDOW_MS = 1200;
    expect(WINDOW_MS).toBeGreaterThan(0);   // 窗口为 0 的「没变」不构成读数

    const a = await (await fetch(`${BASE}/health`)).json() as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, WINDOW_MS));
    const b = await (await fetch(`${BASE}/health`)).json() as Record<string, unknown>;

    // 每一个 pinned 字段还必须**声明窗口**：不写窗口的「不变」无法被证伪。
    // 三态（外部复核 (e)）：pinned ＝ 有窗口且窗口内必须不变；allowed ＝ 没打标；
    // excluded ＝ 会变且不该被打成 pinned —— 它必须存在，否则「都 pinned」就没有反例。
    const pinnedAll = Object.entries(HEALTH_FIELD_META).filter(([, m]) => m.frozen_at_boot === true);
    const noWindow = pinnedAll.filter(([, m]) => !m.stable_within).map(([k]) => k);
    expect(noWindow).toEqual([]);                       // 声明了 pinned 就必须声明窗口
    const windows = new Set(pinnedAll.map(([, m]) => m.stable_within));
    for (const w of windows) expect(["request", "process", "deploy"]).toContain(w as string);

    const pinned = pinnedAll
      .map(([k]) => k)
      .filter((k) => k in a && k in b);
    // 分母：匿名投影里至少要能看见 1 个 pinned 字段，否则这条测试是真空真
    expect(pinned.length).toBeGreaterThan(0);

    const moved = pinned.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    expect(moved).toEqual([]);   // 声明是 pinned，就必须在窗口内真的不动

    // ⚠️ 这条检查的**弱点必须写出来**（否则它会被读成比实际更强的东西）：
    //   一个值**本来就在这个窗口里不变**的字段，即使被错误地标成 pinned，也照样通过。
    //   实测 witness：把 `sessions_count` 标成 `frozen_at_boot + stable_within:"process"`，
    //   测试**仍然绿** —— 因为空测试库里它恒为 0。
    //   ⇒ 这条断言真正守住的是「标了 pinned 的字段在窗口内不许变」，
    //     它**不能**守住「pinned 打得对」。后者只有两种办法：
    //       ① 造一个真会变的场景（连接数变化 / 重启 / failover）再读两次；
    //       ② 用第二个观测者（另一个实例、另一台机器），而不是对同一实例再采样一次。
    //   今天本仓两样都没有 ⇒ 这一格只能到「窗口声明 + 窗口内不变」为止。
    //
    // 正向对照：窗口内必须**有东西会变**，否则「都没变」可能只是「两次读的是同一份缓存」。
    // 这不是洁癖：一个恒定的响应体可以让上面那条永远绿。
    const changed = Object.keys(a).filter((k) => k in b && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    expect(changed.length).toBeGreaterThan(0);
    // 且变化必须**不含**任何 pinned 字段（与上面互为镜像：一条说“没变”，一条说“别的在变”）
    expect(changed.filter((k) => pinned.includes(k))).toEqual([]);
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
    test("every gauge declares one of level/cumulative/instant/label/boolean/verdict", async () => {
      const { HEALTH_FIELD_META } = await import("./server.js");
      const allowed = ["level", "cumulative", "instant", "label", "boolean", "verdict"];
      const bad = Object.entries(HEALTH_FIELD_META)
        .filter(([, m]) => m.class === "gauge" && !allowed.includes(String(m.granularity)))
        .map(([k, m]) => `${k}=${m.granularity}`);
      expect(bad).toEqual([]);
      // 分母非空：这一条今天必须有东西可查
      expect(Object.values(HEALTH_FIELD_META).filter((m) => m.class === "gauge").length).toBeGreaterThan(20);
    });

    // 2026-10-31 —— verdict 与 label 的差别只有一条，但它是致命的：
    //   label   是描述（"streamable-http"）⇒ 为常量无害
    //   verdict 是判定（"ok"/"degraded"）⇒ 若另一支不可观测，它就不是判定而是装饰
    // 起因：一次复核提议给 /health 加 `ptyWsAttached`，而 attach 在 listen 回调里无条件执行
    // ⇒ true 恒成立、false 不可观测 ⇒ 这个字段永远只有一个读数，正是被审的「一侧不可达」缺陷本身。
    // 2026-10-31 —— **身份三分类，且恰好一个权威**（外部复核：产物属性 / 调用属性 / 声明）。
  // 「三类混在一起且不标注，就是『六个身份』的根。」
  test("identity fields carry a class; exactly one artifact-class authority", async () => {
    const { HEALTH_FIELD_META } = await import("./server.js");
    const rows = Object.entries(HEALTH_FIELD_META).filter(([, m]: any) => m.identity_class);
    const cls = (r: [string, any]) => r[1].identity_class;
    // 三类都必须有代表（否则分类只是给已有字段贴了个词）
    for (const want of ["artifact", "call", "declaration"]) {
      expect(rows.filter((r) => cls(r as [string, any]) === want).length).toBeGreaterThanOrEqual(1);
    }
    // **恰好一个 artifact 类权威** —— 两个权威等于回到「谁说了算」
    expect(rows.filter((r) => cls(r as [string, any]) === "artifact").length).toBe(1);
    // 有 call 类覆盖时，必须同时存在 artifact 类（否则「怎么被启动的」在冒充「跑的是什么」）
    if (rows.some((r) => cls(r as [string, any]) === "call")) {
      expect(rows.some((r) => cls(r as [string, any]) === "artifact")).toBe(true);
    }
  });

  // 2026-10-31 —— **身份是从哪个根读的**（外部复核那条：release 读的是 cwd，不是可执行文件目录）。
  // 我们优先模块目录，只在拿不到时退回 cwd —— 但若没有字段说明是哪一支，
  // 「读到的是本包的身份」与「读到的是启动目录里另一个仓库」在载荷上完全同形。
  test("git identity says which root it came from (module_dir vs cwd)", async () => {
    const b = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect(["module_dir", "cwd"]).toContain(b.git_identity_root);
    // 从 cwd 读出来的身份，必须显式承认它不是制品身份
    if (b.git_identity_root === "cwd") {
      expect(b.build_identity_note === null || typeof b.build_identity_note === "string").toBe(true);
    }
    // 反向：有 commit 却说不出来源 ⇒ 这条断言不允许
    if (b.git_commit) expect(["module_dir", "cwd"]).toContain(b.git_identity_root);
  });

  // 2026-10-31 —— **每个 verdict 都要有仲裁字段**（外部复核那条：
  // 「每个问题一个权威字段 + 一个仲裁字段」）。
  // 只有权威字段时，读者无法区分「结论是对的」与「检查没跑」。
  test("every verdict declares an arbiter field that is actually in the payload", async () => {
    const full = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    const verdicts = Object.entries(HEALTH_FIELD_META).filter(([, m]: any) => m.granularity === "verdict");
    expect(verdicts.length).toBeGreaterThanOrEqual(4);
    for (const [k, m] of verdicts as Array<[string, any]>) {
      expect(typeof m.arbiter).toBe("string");
      expect(m.arbiter.length).toBeGreaterThan(2);
      // 仲裁字段必须在同一个载荷里（否则读者还得再发一次请求，那就不是仲裁而是推测）
      expect(Object.prototype.hasOwnProperty.call(full, m.arbiter)).toBe(true);
      // 不能自己仲裁自己
      expect(m.arbiter).not.toBe(k);
    }
  });

  test("every verdict names how to make the OTHER branch fire", async () => {
      const { HEALTH_FIELD_META } = await import("./server.js");
      // HEALTH_FIELD_META 覆盖**两个投影**（匿名 + 鉴权）⇒ 存在性要对着完整那份查。
      const full = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
      const anon = await (await fetch(`${BASE}/health`)).json() as any;
      const verdicts = Object.entries(HEALTH_FIELD_META).filter(([, m]) => m.granularity === "verdict");
      // 分母非空：今天至少要有这么多真判定，否则这条门是装饰
      expect(verdicts.length).toBeGreaterThanOrEqual(4);
      for (const [k, m] of verdicts) {
        expect((m.verdict_other_branch ?? "").length).toBeGreaterThanOrEqual(20);
        // 判定必须真的在载荷里（不许给不存在的字段配说明）
        expect(Object.prototype.hasOwnProperty.call(full, k)).toBe(true);
      }
      // 匿名/鉴权的边界也钉住：新增一个 verdict 时必须**显式决定**它匿不匿名，
      // 否则它会静默地默认进匿名载荷（或默认被滤掉，而没人注意到）。
      const anonVerdicts = verdicts.map(([k]) => k)
        .filter((k) => Object.prototype.hasOwnProperty.call(anon, k)).sort();
      expect(anonVerdicts).toEqual(["build_identified", "license_state", "status"]);
    });

    // 反面：断言自己是常量的字段，必须给出「另一支为什么不会出现」，并且**真的还是那个常量**。
    test("fields declared constant-by-design still read as that constant", async () => {
      const { HEALTH_FIELD_META } = await import("./server.js");
      const b = await (await fetch(`${BASE}/health`)).json() as any;
      const claimed: Record<string, unknown> = {
        ok: true,
        api_version: "v3",
        transport: "streamable-http",
        version_role: "deployment_label",
        v3_auth: true,
        multi_network: true,
      };
      for (const [k, want] of Object.entries(claimed)) {
        const m = (HEALTH_FIELD_META as any)[k];
        expect((m.constant_by_design ?? "").length).toBeGreaterThanOrEqual(20);
        expect(b[k]).toBe(want);
      }
      // 反例守卫：一条「常量」若其实是可变的，claim 就写错了 ⇒ 这里会红
      expect(b.status).toBe("ok");
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
  // 2026-10-31 —— **2×2 的第四格**（外部复核 (e)：「等价性断言必须按 (通道 × 配置) 组合进行」）。
  // 本仓的 /health 有两个维度：谁在读（匿名 / 鉴权）× 有没有带 X-Probe-Nonce。
  // 前面只覆盖了三格（匿名、匿名+探针、鉴权），**鉴权+探针**这一格没测过 ——
  // 而它正是「探针回显会不会被鉴权分支吃掉」的唯一读数。
  test("all four cells of (audience × probe-header) carry the fields they must", async () => {
    const anon = await (await fetch(`${BASE}/health`)).json() as any;
    const anonProbe = await (await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": "cell-anon" } })).json() as any;
    const authed = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    const authedProbe = await (await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${adminToken}`, "X-Probe-Nonce": "cell-authed" },
    })).json() as any;

    // 探针格：带头的两格都必须回显 nonce，且 served_at 都在（窗口两端同域）
    expect(anonProbe.probe_nonce).toBe("cell-anon");
    expect(authedProbe.probe_nonce).toBe("cell-authed");
    for (const body of [anon, anonProbe, authed, authedProbe]) {
      expect(typeof body.served_at).toBe("string");
    }
    // 不带头的一格不该出现 probe_nonce（否则「这一次的凭据」变成常驻字段）
    expect("probe_nonce" in anon).toBe(false);
    // 鉴权格必须比匿名格多（否则白名单形同虚设）——第四格同样成立
    expect(Object.keys(authedProbe).length).toBeGreaterThan(Object.keys(anonProbe).length);
  });

  // 2026-10-31 —— **未被读的字段 = 未验证的字段**（外部复核 ①：
  // 「not_applicable 占用了 hash 槽却活到今天，是因为那个字段从未被读取；
  //   字段『看起来有值』比『未被测的代码』更隐蔽」）。
  // 断言：HEALTH_FIELD_META 里每个键都必须至少被一条 server 测试提到；例外显式登记。
  // 上面那条 ratchet 抓出来的两个「被产出但没人读」字段，这里补上断言（而不是登记成例外）。
  test("alert_baselines and clk_tck_assumed_reason are actually read (not just produced)", async () => {
    const body = await (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    // alert_baselines：null（还没刷过）或 {at, rows, aliases} —— 两种形态都必须能说清
    expect(body).toHaveProperty("alert_baselines");
    if (body.alert_baselines !== null) {
      expect(typeof body.alert_baselines.at).toBe("string");
      expect(Number.isInteger(body.alert_baselines.rows)).toBe(true);
      expect(Number.isInteger(body.alert_baselines.aliases)).toBe(true);
    }
    // clk_tck_assumed_reason：一个必须能解释「为什么用假设值」的字符串（空串是合法的：读到了真实值）
    expect(typeof body.clk_tck_assumed_reason).toBe("string");
    // 它与 clk_tck_source 配对：source=assumed 时必须有理由，否则必须是空串
    if (body.clk_tck_source === "assumed") expect(body.clk_tck_assumed_reason.length).toBeGreaterThan(0);
    else expect(body.clk_tck_assumed_reason).toBe("");
  });

  test("every /health field is read by at least one test (unread = unverified)", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const start = src.indexOf("HEALTH_FIELD_META");
    const block = src.slice(start, src.indexOf("};", start));
    const keys = [...block.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*\{/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(30);
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith(".test.ts")) out.push(full);
      }
      return out;
    };
    const testSource = walk(join(import.meta.dir)).map((f) => readFileSync(f, "utf8")).join("\n");
    const ALLOW_UNREAD: Record<string, string> = {};
    const unread = keys.filter((k) => !ALLOW_UNREAD[k] && !new RegExp(`\\b${k}\\b`).test(testSource));
    if (unread.length) {
      throw new Error(`这 ${unread.length} 个字段被产出但没有任何测试读它们：${unread.join(", ")}\n  ⇒ 要么加断言，要么登记进 ALLOW_UNREAD 并写明为什么可以不读。`);
    }
  });

  // 2026-10-31 —— **有覆盖、零仲裁**（外部复核 (d)）：version 有两个来源
  // （standalone 二进制注入的 env / 磁盘 package.json），此前只报结果、不报谁赢了。
  // version_source 就是那个仲裁位；下面四例钉住它的语义。
  test("version_source names which override won (and splits the two failure causes)", async () => {
    const { resolveServerVersion } = await import("./server.js");
    expect(resolveServerVersion("0.9.0-preview.999", () => "0.9.0-preview.1"))
      .toEqual({ version: "0.9.0-preview.999", source: "embedded_env" });
    // env 形状不对 ⇒ 落到磁盘，而不是把非法值当版本号
    expect(resolveServerVersion("latest", () => "0.9.0-preview.1"))
      .toEqual({ version: "0.9.0-preview.1", source: "package_json" });
    // 磁盘读失败 ⇒ read_failed；读到空 ⇒ empty_value（**两个成因两个值**，不是一个 unknown）
    expect(resolveServerVersion(undefined, () => { throw new Error("ENOENT"); }))
      .toEqual({ version: "?", source: "read_failed" });
    expect(resolveServerVersion("  ", () => "?"))
      .toEqual({ version: "?", source: "empty_value" });

    // 线上读数与语义自洽：unknown ⇔ version 是 "?"
    const body = await (await fetch(`${BASE}/health`)).json() as any;
    expect(["embedded_env", "package_json", "read_failed", "empty_value"]).toContain(body.version_source);
    if (body.version_source === "read_failed" || body.version_source === "empty_value") expect(body.version).toBe("?");
    else expect(body.version).not.toBe("?");
  });

  // 2026-10-31 —— **granularity=instant 的字段必须写出反事实**（外部复核 (c)：
  // 「判法改为对『这个值变了，世界上什么变了』做反事实询问」）。
  // 这一类的共同陷阱：值在变，看起来有信息，而它变的可能只是**读的时刻**。
  test("every instant-granularity field states its counterfactual (why is mandatory)", async () => {
    const { HEALTH_FIELD_META } = await import("./server.js");
    const instant = Object.entries(HEALTH_FIELD_META).filter(([, m]: any) => m.granularity === "instant");
    expect(instant.length).toBeGreaterThanOrEqual(2);
    const missing = instant.filter(([, m]: any) => !(m.why && String(m.why).length > 8)).map(([k]) => k);
    if (missing.length) {
      throw new Error(`instant 字段没有写「变了意味着什么」：${missing.join(", ")}\n  ⇒ 它可能只是读的时刻在变，而不是状态在变。`);
    }
  });

  // 2026-10-31 —— **单一出口**（外部复核 (a)：
  // 「一个必须在『所有字段写完之后』执行的变换，只有收敛到单一出口才可靠 —— 多出口 × 惰性 = 迟早漏」）。
  // 这条门只看一件事：`shape(...)` 在源码里只能出现在**一处**。
  // 出现第二处 ⇒ 说明又有一个 return 各自记得调它 ⇒ 下一个人加第三个出口时就会裸奔。
  test("the anonymous projection is applied at exactly one call site", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const calls = [...src.matchAll(/Response\.json\(\s*shape\(/g)];
    expect(calls.length).toBe(1);
    // 定义处也算一处（`const shape = ...`），但它不是 Response.json 包裹，所以上面的正则不会数到
    expect((src.match(/const shape = /g) || []).length).toBe(1);
  });

  // 2026-10-31 —— **同一 body 里的两个时钟源**（外部复核：
  // 「要解耦两个读数，必须证明它们来自不同的源，而不是来自不同的字段名」）。
  // 这条同时证明两件事：
  //   ① uptime 的来源是 process.uptime()（单调时钟），不是 Date.now()-startedAt；
  //   ② startedAt 与 uptime 互相自洽（startedAt = now - uptime），所以它是「同一对的另一侧」。
  // 若哪天有人把 uptime 改成 Date.now()-startedAt，① 会红 —— 那时两个字段会同源、判别力归零。
  test("uptime comes from the monotonic clock (a separate source from served_at)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(src).toContain("uptime: Math.floor(process.uptime())");
    expect(src).not.toMatch(/uptime:\s*Math\.floor\(\(Date\.now\(\)\s*-/);

    const body = await (await fetch(`${BASE}/health`)).json() as any;
    expect(Number.isInteger(body.uptime)).toBe(true);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    // 自洽：now - startedAt ≈ uptime（±5s 容差，覆盖处理时间与秒级取整）
    const derived = (Date.now() - Date.parse(body.startedAt)) / 1000;
    expect(Math.abs(derived - body.uptime)).toBeLessThanOrEqual(5);
  });

  // 2026-10-31 —— **响应头也不能泄露指纹**（外部复核：「匿名 /health 响应头里不得出现
  // git / commit / build(sha|id) 类头；这两条不需要会话就能读 ⇒ 它们回答『我站在哪一层』，
  // 不是『我有没有登录』」）。
  // 为什么需要它：body 有白名单，**头没有**。将来有人把 build id 塞进 `X-Build-Id`，
  // body 侧断言全绿，而匿名读者已经拿到了指纹。
  test("anonymous /health exposes no fingerprint-bearing response header", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const names = [...res.headers.keys()].map((k) => k.toLowerCase());
    const forbidden = names.filter((n) => /git|commit|build[-_]?(sha|id)?/.test(n));
    if (forbidden.length) {
      throw new Error(`匿名 /health 出现了指纹类响应头：${forbidden.join(", ")}\n` +
        "  ⇒ body 白名单不覆盖响应头；要么删掉这个头，要么它只在鉴权分支发。");
    }
    // 镜像：同一个端点在**鉴权**分支下可以有 X-* 头，但也不能有指纹 —— 迄今也没有；
    // 这条留作记录：若哪天加了，必须先在白名单测试里显式放行。
    expect(forbidden).toEqual([]);
  });

  // 2026-10-31 —— **「谁写的」比「谁先谁后」更抗重构**（外部复核：头集合当主判据）。
  // 部署前面有 nginx/反代时，客户端拿到的错误页可能不是我们写的。
  // 判据不是「content-type 是 json」（那要求每个客户端都记得先看），
  // 而是一个**静态**产出者标记：有它 ⇒ 这段字节出自 hub；没有 ⇒ 出自它前面的某一层。
  // 必须是静态值：一旦它随进程/版本变化，它就变成了指纹（与 version_role 那条相冲突）。
  // 2026-10-31 —— **凡是差值字段，必须同时给出两个端点的原始值**
  // （外部复核：「任何 `a − b` 都会把『两字段一源』变成不可见；读者至少能看出可能同源，
  //   只剩一个数时他无法质疑两个端点」）。
  //
  // 谓词落在**名字**上而不是「源码里出现了减法」（外部复核：
  // 「`startedAt` / `lastSuccessAt` 也是减法算出来的但**稳**；只扫减法会漏掉无条件的那个」）。
  // 分母必须报出来：命中 0 个差值字段 ⇒ 这条断言是真空真。
  test("any difference-shaped field names both of its endpoints in the same payload", async () => {
    const { HEALTH_FIELD_META } = await import("./server.js");
    const DIFFY = /(age|elapsed|uptime|remaining|ttl|delta|drift|lag)/i;
    const named = Object.keys(HEALTH_FIELD_META).filter((k) => DIFFY.test(k));
    expect(named.length).toBeGreaterThan(0);            // 分母：按名字至少命中 1 个

    const derived = named.filter((k) => (HEALTH_FIELD_META as any)[k].derived_from);
    // 本仓今天有 2 个真差值（epoch_delta_ms / clk_tck_delta）；`uptime` 是**单调读数**不是差值，
    // 它显式不写 derived_from —— 所以这里要求的是「写了端点的必须两端齐全」，
    // 而不是「所有命中名字的都必须写」（后者会把这条规则变成填表）。
    expect(derived.length).toBeGreaterThanOrEqual(2);

    const problems: string[] = [];
    for (const k of derived) {
      const ends = (HEALTH_FIELD_META as any)[k].derived_from as readonly string[];
      if (!Array.isArray(ends) || ends.length < 2) { problems.push(`${k}: 端点少于 2 个`); continue; }
      for (const e of ends) {
        if (!(e in HEALTH_FIELD_META)) problems.push(`${k}: 端点 ${e} 不是本载荷里的字段（拼错的端点等于没有端点）`);
      }
    }
    expect(problems).toEqual([]);
    // 镜像：非差值字段**不该**被要求给端点（否则「填表」会取代判据）——
    // 断言 uptime 没有 derived_from，并且它确实不是 now-startedAt 那种同源减法。
    expect((HEALTH_FIELD_META as any).uptime.derived_from).toBeUndefined();
  });

  test("every hub response carries a constant producer marker (so a proxy page is distinguishable)", async () => {
    const paths = ["/health", "/api/definitely-not-a-route", "/"];
    const seen: (string | null)[] = [];
    for (const path of paths) {
      const res = await fetch(`${BASE}${path}`);
      seen.push(res.headers.get("X-CommHub"));
    }
    // 三个不同出口（健康检查 / 404 / 帮助页）都必须带，且值相同
    expect(seen).toEqual(["hub", "hub", "hub"]);
    // 静态性：同一路径两次读到的值必须一致（否则它是指纹，不是产出者标记）
    const again = await fetch(`${BASE}/health`);
    expect(again.headers.get("X-CommHub")).toBe("hub");
    // 与「匿名无指纹」那条不冲突：这个头不含 git/commit/build 类词
    expect(/git|commit|build[-_]?(sha|id)?/.test("x-commhub")).toBe(false);
  });

  test("no dead entries: every allow-listed key is actually served to anonymous callers", async () => {
    const { PUBLIC_HEALTH_KEYS } = await import("./server.js");
    const plain = await (await fetch(`${BASE}/health`)).json() as any;
    // 条件出现的键（只在带 X-Probe-Nonce 时出现）要在第二种请求里核对
    const probed = await (await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": "dead-entry-check" } })).json() as any;
    const seen = new Set([...Object.keys(plain), ...Object.keys(probed)]);
    const dead = [...PUBLIC_HEALTH_KEYS].filter((k) => !seen.has(k));
    // 2026-10-31 —— 失败时必须点名（外部复核 ③）：只说 `toEqual([])` 的失败信息里
    // 没有「是哪几个键」，而修它需要的正是那几个名字。
    if (dead.length) {
      throw new Error(
        `白名单里有 ${dead.length} 个键在任何投影里都不出现（死条目）：${dead.join(", ")}\n` +
        "  ⇒ 要么从 PUBLIC_HEALTH_KEYS 删掉，要么让 body 真的产出它；" +
        "留着等于给未来的同名字段预授权。",
      );
    }
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

  // 2026-10-31 —— 上面那条 `== 1` 需要一个**镜像**，否则它只在「日志存在」时成立，
  // 而在「日志被去重」时同样成立 —— 而去重恰好会毁掉 ==1 判据的全部价值：
  //   判据里的 `> 1` 只有在「复用会被记两次」时才能被发现。
  // ⇒ 一个看起来无害的优化（同一 nonce 只打一行、或加个 seen 集合）会让复用永远读成「新鲜」。
  test("reusing the same nonce logs TWICE (so `>1` can actually fire)", async () => {
    const nonce = `reuse-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const seen: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes(nonce)) seen.push(line);
      original(...args);
    };
    try {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": nonce } });
        await res.json();
      }
    } finally {
      console.log = original;
    }
    expect(seen.length).toBe(2);   // 去重实现会让这条红 —— 那是故意的
  });

  test("two distinct nonces are each logged once (no cross-talk)", async () => {
    const mk = () => `pair-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = mk(); const b = mk();
    const seen: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("pair-")) seen.push(line);
      original(...args);
    };
    try {
      await (await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": a } })).json();
      await (await fetch(`${BASE}/health`, { headers: { "X-Probe-Nonce": b } })).json();
    } finally {
      console.log = original;
    }
    expect(seen.filter(l => l.includes(a)).length).toBe(1);
    expect(seen.filter(l => l.includes(b)).length).toBe(1);
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
    expect(res.headers.get("cache-control")).toBe("no-store");
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
