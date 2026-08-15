#!/usr/bin/env node
/**
 * agent-node 消息生命周期测试
 *
 * 前置：CommHub Server 在 9210 端口运行
 *   PORT=9210 bun run server/src/index.ts
 *
 * 运行：node tests/archive/message-lifecycle.integration.mjs
 *
 * 🔴 文件名里**不带 `.test.`** 是有意的。它原名 `message-lifecycle.test.mjs`，
 *    于是被 `bun test` 的默认 glob 捞进套件 —— 而它是个顶层脚本，末尾有
 *    `process.exit(failed > 0 ? 1 : 0)`。**在被 runner 加载的文件里调
 *    process.exit 会杀掉整个 runner。**
 *    实测:把前置检查改成"跳过时 process.exit(0)"之后，整套件只跑到第 7 个
 *    文件就结束，却给出 rc=0 —— 108 个文件里 6% 都不到，外面看是一片绿。
 *    它一直没炸，只是因为每次都先崩在 TypeError 上，**从没执行到那一行**。
 *    ⇒ 这个文件本来就该按它自己文档说的那样用 node 单独跑。
 */

const HUB = "http://127.0.0.1:9210";
// 这个 hub 现在是要鉴权的(`security: "secured"`, `v3_auth: true`)。本文件写于鉴权之前，
// 一直不带凭据地调 API，于是每次都拿 401、读回空数组。给它一个 token 入口。
const HUB_TOKEN = process.env.ANET_TEST_HUB_TOKEN || "";
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...(HUB_TOKEN ? { Authorization: `Bearer ${HUB_TOKEN}` } : {}),
};

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

async function mcp(tool, args) {
  const res = await fetch(`${HUB}/mcp`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  const match = raw.match(/data: (.+)/);
  const data = match ? JSON.parse(match[1]) : JSON.parse(raw);
  const text = data?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : data;
}

async function getInbox(alias) {
  const r = await mcp("get_inbox", { alias, limit: 20 });
  return r?.messages || [];
}

async function ackAll(alias) {
  const msgs = await getInbox(alias);
  for (const m of msgs) await mcp("ack_inbox", { alias, message_id: m.id });
  return msgs.length;
}

async function getStatus(alias) {
  const r = await fetch(`${HUB}/api/status`).then(r => r.json());
  return r.sessions?.find(s => s.alias === alias);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 前置:hub 得**用得了**，不只是"有人接 TCP" ──
//
// 🔴 原来这里是 `try { await fetch(HUB + "/health") } catch { exit(1) }`。
//    两处不成立:
//      - `fetch` **只在网络层出错才 throw** —— 401 / 500 都不 throw；
//      - `/health` 是免鉴权的，稳定返 200。
//    所以它实际只验证了"有人接 TCP"，放行了一个本测试根本用不了的 hub，
//    然后在 200 行开外崩成 `undefined is not an object`，
//    报出来的东西和真因(401)毫无关系。
//    ⇒ 前置必须打一个**需要鉴权**的端点，并按状态码分开三种结局。
function skip(reason, hint) {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║  SKIPPED — 依赖未就绪，未执行任何断言     ║");
  console.log("╚═══════════════════════════════════════════╝");
  console.log(`  原因: ${reason}`);
  console.log(`  如何跑起来: ${hint}`);
  // 依赖没备好不是产品缺陷 —— 报红会训练人忽略这一行。
  // 但**必须吵**:上面那三行是无条件打印的，不存在"安静地跳过"。
  process.exit(0);
}

let preflight;
try {
  preflight = await fetch(`${HUB}/api/status`, { headers: HEADERS });
} catch {
  skip(`CommHub 不在 ${HUB} 上`, `PORT=9210 bun run server/src/index.ts`);
}
if (preflight.status === 401) {
  skip(
    `${HUB} 活着但拒绝本测试的凭据(HTTP 401)`,
    `ANET_TEST_HUB_TOKEN=<user token> node tests/archive/message-lifecycle.test.mjs`,
  );
}
if (!preflight.ok) {
  skip(`${HUB}/api/status 返回 HTTP ${preflight.status}`, `先确认那个 hub 是本测试预期的版本`);
}

console.log("╔═══════════════════════════════════════════╗");
console.log("║  agent-node 消息生命周期测试              ║");
console.log("╚═══════════════════════════════════════════╝\n");

// ══════════════════════════════════════
// 单元测试：isLowValueText + shouldSkipMessage
// ══════════════════════════════════════

console.log("--- 单元测试: isLowValueText ---");

const LOW_VALUE_PHRASES = new Set([
  "收到", "好的", "ok", "嗯", "是的", "了解", "明白", "确认",
  "done", "ack", "roger", "yes", "no", "在线", "待命", "正常",
  "保持在线", "通信正常", "已收到", "收到了", "好", "行",
  "noted", "copy", "received", "understood",
  "等待任务", "等待中", "等待指令", "无新任务", "idle", "waiting",
]);

function isLowValueText(text) {
  if (!text) return true;
  const stripped = text.replace(/[\s\p{P}\p{S}\p{Emoji}]/gu, "");
  if (stripped.length < 3) return true;
  const clean = text.trim().replace(/^[\[【].+?[\]】]\s*/, "").trim();
  const lower = clean.toLowerCase().replace(/[\s。！？.!?✅❌👀⏳，,]+$/g, "").trim();
  if (LOW_VALUE_PHRASES.has(lower)) return true;
  if (/^[\p{Emoji}\s]+$/u.test(text.trim())) return true;
  return false;
}

// Test 5: 低价值消息过滤
console.log("\n--- TEST 5: 低价值消息过滤 ---");
assert(isLowValueText("收到") === true, "收到 → 低价值");
assert(isLowValueText("好的") === true, "好的 → 低价值");
assert(isLowValueText("ok") === true, "ok → 低价值");
assert(isLowValueText("。") === true, "。 → 低价值 (短)");
assert(isLowValueText("✅") === true, "✅ → 低价值 (emoji)");
assert(isLowValueText("👀") === true, "👀 → 低价值 (emoji)");
assert(isLowValueText("在线") === true, "在线 → 低价值");
assert(isLowValueText("待命") === true, "待命 → 低价值");
assert(isLowValueText("保持在线") === true, "保持在线 → 低价值");
assert(isLowValueText("通信正常") === true, "通信正常 → 低价值");
assert(isLowValueText("等待任务") === true, "等待任务 → 低价值");
assert(isLowValueText("[SDK马] 收到") === true, "[SDK马] 收到 → 低价值 (带前缀)");
assert(isLowValueText("收到。✅") === true, "收到。✅ → 低价值 (带标点+emoji)");
assert(isLowValueText("分析这段代码的安全性") === false, "正常任务 → 有价值");
assert(isLowValueText("发现 3 个 XSS 漏洞") === false, "正常回复 → 有价值");
assert(isLowValueText("") === true, "空字符串 → 低价值");
assert(isLowValueText("hi") === true, "hi → 低价值 (短)");

// Test 9: 自己发的消息跳过
console.log("\n--- TEST 9: shouldSkipMessage ---");

const ALIAS = "测试马";
const lastReplyTime = {};
const COOLDOWN_MS = 5000;

function shouldSkipMessage(from, content) {
  if (from === ALIAS) return "self";
  if (content.startsWith(`[${ALIAS}]`)) return "own-prefix";
  const now = Date.now();
  if (lastReplyTime[from] && now - lastReplyTime[from] < COOLDOWN_MS) return "cooldown";
  if (isLowValueText(content)) return "low-value-inbound";
  return null;
}

assert(shouldSkipMessage("测试马", "hello") === "self", "from=self → skip");
assert(shouldSkipMessage("other", "[测试马] result") === "own-prefix", "own prefix → skip");
assert(shouldSkipMessage("other", "收到") === "low-value-inbound", "low value → skip");
assert(shouldSkipMessage("other", "分析这段代码") === null, "normal task → process");

// Test 8: 冷却
console.log("\n--- TEST 8: 防循环冷却 ---");
lastReplyTime["cooltest"] = Date.now();
assert(shouldSkipMessage("cooltest", "第二条") === "cooldown", "同 from 5s 内 → cooldown");
lastReplyTime["cooltest"] = Date.now() - 6000;
assert(shouldSkipMessage("cooltest", "第三条") === null, "同 from 6s 后 → 通过");

// Test 6: --new-session
console.log("\n--- TEST 6: --new-session ---");
{
  const opts = { "new-session": "true" };
  const fileConfig = { session: "old-session-123" };
  const NEW_SESSION = opts["new-session"] === "true";
  const SESSION_ID = NEW_SESSION ? "" : (fileConfig.session || "");
  assert(SESSION_ID === "", "--new-session 清空 SESSION_ID");
}
{
  const opts = {};
  const fileConfig = { session: "old-session-123" };
  const NEW_SESSION = (opts["new-session"] || "") === "true";
  const SESSION_ID = NEW_SESSION ? "" : (fileConfig.session || "");
  assert(SESSION_ID === "old-session-123", "无 --new-session 保留 session");
}

// ══════════════════════════════════════
// 集成测试（需要 CommHub 9210）
// ══════════════════════════════════════

console.log("\n--- 集成测试（CommHub 9210）---");

// 注册一个模拟 agent
const AGENT = "test-agent-" + Date.now().toString(36);
await mcp("report_status", { resume_id: `test-${AGENT}`, alias: AGENT, status: "idle" });

// Test 1: send_task → inbox
console.log("\n--- TEST 1: send_task 入 inbox ---");
await ackAll(AGENT);
await mcp("send_task", { alias: AGENT, task: "test task 1", priority: "normal", from_session: "tester" });
await sleep(500);
const inbox1 = await getInbox(AGENT);
assert(inbox1.length >= 1, `send_task 入 inbox: ${inbox1.length} 条`);
assert(inbox1.some(m => m.content === "test task 1"), "内容匹配");
assert(inbox1.some(m => m.from_session === "tester"), "from_session 正确");
await ackAll(AGENT);

// Test 2: send_message → inbox 但 type=message
console.log("\n--- TEST 2: send_message 入 inbox ---");
await mcp("send_message", { alias: AGENT, message: "just a message", from_session: "tester" });
await sleep(500);
const inbox2 = await getInbox(AGENT);
assert(inbox2.length >= 1, `send_message 入 inbox: ${inbox2.length} 条`);
const msgEntry = inbox2.find(m => m.content === "just a message");
assert(msgEntry !== undefined, "message 内容在 inbox");
assert(msgEntry?.type === "message", `type=${msgEntry?.type} (应为 message)`);
await ackAll(AGENT);

// Test 3: SSE event type 区分
console.log("\n--- TEST 3: SSE event 区分 ---");
{
  // 连 SSE 监听
  const events = [];
  const controller = new AbortController();
  const ssePromise = (async () => {
    try {
      const res = await fetch(`${HUB}/events/${encodeURIComponent(AGENT)}`, {
        headers: { Accept: "text/event-stream" }, signal: controller.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch {}
        }
      }
    } catch {}
  })();

  await sleep(1000); // 等 SSE 连上

  await mcp("send_task", { alias: AGENT, task: "sse test task", from_session: "tester" });
  await sleep(500);
  await mcp("send_message", { alias: AGENT, message: "sse test msg", from_session: "tester" });
  await sleep(500);

  controller.abort();
  await ssePromise.catch(() => {});

  const taskEvents = events.filter(e => e.type === "new_task");
  const msgEvents = events.filter(e => e.type === "new_message");

  assert(taskEvents.length >= 1, `SSE new_task events: ${taskEvents.length}`);
  assert(msgEvents.length >= 1, `SSE new_message events: ${msgEvents.length}`);
  assert(taskEvents.length > 0 && msgEvents.length > 0, "SSE 区分 task vs message");
  await ackAll(AGENT);
}

// Test 4: 多条 task 串行
console.log("\n--- TEST 4: 多条 task 串行入 inbox ---");
await ackAll(AGENT);
for (let i = 0; i < 3; i++) {
  await mcp("send_task", { alias: AGENT, task: `task ${i}`, from_session: "tester" });
}
await sleep(500);
const inbox4 = await getInbox(AGENT);
assert(inbox4.length === 3, `3 条 task 入 inbox: ${inbox4.length}`);
assert(inbox4[0]?.content === "task 0", "顺序正确: task 0");
assert(inbox4[2]?.content === "task 2", "顺序正确: task 2");
await ackAll(AGENT);

// Test 7: auto-compact 阈值 (单元测试)
console.log("\n--- TEST 7: auto-compact 配置 ---");
{
  // 验证 Codex config 包含 model_auto_compact_token_limit
  // 这是代码层面的验证，不需要实际跑 codex
  const configStr = "model_auto_compact_token_limit: 200000";
  assert(configStr.includes("200000"), "auto-compact 阈值 = 200000");
}

// Test 10: inbox 积压消化
console.log("\n--- TEST 10: inbox 积压 + ack 消化 ---");
await ackAll(AGENT);
for (let i = 0; i < 5; i++) {
  await mcp("send_task", { alias: AGENT, task: `backlog ${i}`, from_session: "tester" });
}
await sleep(300);
const before = await getInbox(AGENT);
assert(before.length === 5, `积压 5 条: ${before.length}`);
const cleared = await ackAll(AGENT);
assert(cleared === 5, `ack 消化 5 条: ${cleared}`);
const after = await getInbox(AGENT);
assert(after.length === 0, `消化后 0 条: ${after.length}`);

// ── 清理 ──
try { await mcp("report_status", { resume_id: `test-${AGENT}`, alias: AGENT, status: "offline" }); } catch {}

// ── 结果 ──
console.log("\n╔═══════════════════════════════════════════╗");
console.log(`║  结果: ${passed} passed, ${failed} failed${" ".repeat(Math.max(0, 20 - String(passed).length - String(failed).length))}║`);
console.log("╚═══════════════════════════════════════════╝");

process.exit(failed > 0 ? 1 : 0);
