// #1459 —— P2 写路径与 P3 读路径的**接缝**。
//
// 通信龙 在 origin/main 上核出的覆盖缝：desktop-message.test.ts 测真实 send 但
// 不碰 scope=user 读；user-inbox-read-http.test.ts 测 scope=user 读但用 SQL 直接
// 播种行。两半各自对着自己的夹具绿，而"真实 send 写进的行、真实 scope=user
// 读得回来"从没验过。本文件就走这一条：真 send → 真 HTTP 读。
//
// 附带钉住 network_id 不为 NULL 的**真实机制**：不是 INSERT 时兜底，而是
// tools.ts 里 `if (!effectiveNetId) return writeDeniedReply(...)` 在写之前就拒。
// 见下面 "解析不出 network 时拒发" 那条 —— 把那个 if 拿掉，本文件会红。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-dm-seam-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let server: ReturnType<typeof Bun.serve>;
let base = "";
let targetToken = "";
let senderId = "", targetId = "", senderNet = "", secondNet = "";
let send: (args: any) => Promise<Record<string, any>>;

function buildSend(opts: { netId: string | null; userId: string | null; alias: string | null }) {
  const mcp = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, any> = {};
  const origTool = mcp.tool.bind(mcp);
  mcp.tool = (name: string, _d: string, _s: any, handler: any) => { tools[name] = handler; return origTool(name, _d, _s, handler); };
  const { registerTools } = require("./tools.js");
  registerTools(mcp, undefined, opts.netId, opts.userId, opts.alias, false, "tok_seam_test");
  return async (args: any) => JSON.parse((await tools["send_desktop_message"](args)).content[0].text);
}

beforeAll(async () => {
  const { db } = await import("./db.js");
  const { register, addNetworkMember } = await import("./auth.js");
  const stamp = Date.now();

  // 首个注册用户自动成为全局 admin，而 admin 读侧不走 scope 过滤分支。
  // 收件人必须是普通 user，否则"读得回来"可能只是因为它绕过了过滤。
  expect(register(`seam_admin_${stamp}`, "SeamAdmin-Strong-1!").ok).toBe(true);
  const s = register(`seam_sender_${stamp}`, "SeamSender-Strong-1!");
  const t = register(`seam_target_${stamp}`, "SeamTarget-Strong-1!");
  expect(s.ok && t.ok).toBe(true);
  targetToken = t.token!;
  senderNet = s.network_id!;
  secondNet = t.network_id!;
  senderId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `seam_sender_${stamp}`)!.user_id;
  targetId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `seam_target_${stamp}`)!.user_id;
  expect(db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", targetId)?.role).toBe("user");

  // 收件人进发件人的网（真实形态：同网两成员）。
  expect(addNetworkMember(senderNet, targetId, "member").ok).toBe(true);

  send = buildSend({ netId: senderNet, userId: senderId, alias: "seam-sender" });

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

const readOwn = async (token: string, qs = "") => {
  const r = await fetch(`${base}/api/messages?scope=user${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
};

describe("#1459 P2 写 → P3 读 接缝", () => {
  test("🔴 真实 send_desktop_message 写进的行，真实 GET ?scope=user 读得回来", async () => {
    const sent = await send({ to_user_id: targetId, message: "接缝测试正文", title: "接缝", severity: "warning", kind: "agent_message" });
    expect([sent.ok, sent.persisted]).toEqual([true, true]);

    const { status, body } = await readOwn(targetToken);
    expect(status).toBe(200);
    const row = body.messages.find((m: any) => m.message_id === sent.message_id);
    expect(row).toBeTruthy();                      // 承重：两半接得上
    expect(row.content).toBe("接缝测试正文");
    expect(row.title).toBe("接缝");
    expect(row.severity).toBe("warning");
    expect(row.user_id).toBe(targetId);
  });

  test("🔴 落库的 network_id 就是授权用的那个网，不是 NULL —— 否则 scoped 读回不来", async () => {
    const { db } = require("./db.js");
    const sent = await send({ to_user_id: targetId, message: "网络归属" });
    const row = db.get<any>("SELECT network_id FROM user_inbox WHERE message_id = ?1", sent.message_id);
    expect(row.network_id).toBe(senderNet);

    const { body } = await readOwn(targetToken);
    expect(body.messages.map((m: any) => m.message_id)).toContain(sent.message_id);
  });

  test("unread 随真实 send 增长", async () => {
    const before = (await readOwn(targetToken)).body.unread;
    await send({ to_user_id: targetId, message: "计数 +1" });
    expect((await readOwn(targetToken)).body.unread).toBe(before + 1);
  });

  test("redact-at-read 作用在真实写进去的正文上", async () => {
    const sent = await send({ to_user_id: targetId, message: "凭据 ntok_seamtoken123456 在正文里" });
    const { db } = require("./db.js");
    // 存储侧保留原文，遮蔽发生在**回读**时 —— 这两句一起才说明是 read-time 脱敏。
    expect(db.get<any>("SELECT content FROM user_inbox WHERE message_id = ?1", sent.message_id).content)
      .toContain("ntok_seamtoken123456");
    const row = (await readOwn(targetToken)).body.messages.find((m: any) => m.message_id === sent.message_id);
    expect(row.content).toContain("ntok_***redacted***");
    expect(row.content).not.toContain("ntok_seamtoken123456");
  });

  // 🔴 这一条是 `if (!effectiveNetId) return` 这道守卫**唯一**能被触发的场景。
  //    有 auth ctx 时前一道 `canWrite` 就拦了；而 canRestWriteNetwork 对
  //    legacy 全局 token / --dev-open（authCtx 为 null）是 `return true`
  //    （network-scope.ts:96）—— 那条路上只剩这道守卫挡着 NULL 孤儿行。
  //    把 tools.ts:2320 那行删掉，本条会红（写出一行 network_id=NULL）。
  test("🔴 legacy 无 auth ctx 的调用者同样拒发，不写 NULL 孤儿行", async () => {
    const { db } = require("./db.js");
    const legacy = buildSend({ netId: null, userId: null as any, alias: null as any });
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox")!.n;
    const r = await legacy({ to_user_id: targetId, message: "legacy 无网络上下文" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("network_id_required");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox")!.n).toBe(before);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox WHERE network_id IS NULL")!.n).toBe(0);
  });

  test("🔴 解析不出 network 时**拒发**，而不是写一行 network_id=NULL 的孤儿", async () => {
    const { db } = require("./db.js");
    const { addNetworkMember } = require("./auth.js");
    // 发件人进第二个网 ⇒ 不带 network_id 时 singleNetworkId 解析不出唯一网。
    addNetworkMember(secondNet, senderId, "member");
    const ambiguous = buildSend({ netId: null, userId: senderId, alias: "seam-sender" });

    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox")!.n;
    const r = await ambiguous({ to_user_id: targetId, message: "无法解析网络" });

    expect(r.ok).toBe(false);
    expect(r.error).toBe("network_id_required");
    // 承重：拒发意味着**一行都不写**。若把 tools.ts 的
    // `if (!effectiveNetId) return writeDeniedReply(...)` 拿掉，这里会多出一行
    // network_id=NULL 的孤儿 —— 写得进去、scoped 读不回来。
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox")!.n).toBe(before);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox WHERE network_id IS NULL")!.n).toBe(0);
  });
});
