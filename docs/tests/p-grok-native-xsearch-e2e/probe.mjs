// Native end-to-end Grok X-search probe v2 — natural user prompts,
// --always-approve, fresh sessionId capture for multi-session traces.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const STAGE = (process.argv[2] || "basic").toLowerCase();
const CWD = `/tmp/p-grok-native-xsearch-e2e/cwd-${STAGE}`;
const OUT = `/tmp/p-grok-native-xsearch-e2e/${STAGE}`;

function rm(p) {
  try {
    const s = statSync(p);
    if (s.isDirectory()) {
      for (const f of readdirSync(p)) rm(path.join(p, f));
      rmdirSync(p);
    } else unlinkSync(p);
  } catch {}
}
rm(CWD); mkdirSync(CWD, { recursive: true }); mkdirSync(OUT, { recursive: true });

const PROMPTS = {
  basic:
    "找一下 X (Twitter) 上 @sama 最近关于 AGI 的几条帖子, 给我每条的 https://x.com/... 链接 + 中文摘要 + 大致时间, markdown 列表 5 条左右。",
  advanced:
    "找过去 7 天 X (Twitter) 上 #AI 话题最高赞 (faves) 前 5 条帖子, 按 faves 数倒序排, 输出 markdown 表格含 handle / URL / faves / retweets / 大致时间。\n\n如果你确实拿不到真实 faves / retweets 数, 请明确说哪部分能力做不到, 不要编造数字。"
};

const prompt = PROMPTS[STAGE];
if (!prompt) { console.error(`Unknown stage`); process.exit(1); }

console.log(`[probe v2] stage=${STAGE}`);
console.log(`[probe] prompt:\n${prompt}\n`);

const proc = spawn("grok", ["agent", "--always-approve", "stdio"], { stdio: ["pipe", "pipe", "pipe"], cwd: CWD });
let buf = "";
const sessions = [];
const toolCalls = [];
const replyChunks = [];
const stderrAll = [];
let activeSessionId = null;
let promptDone = false;
let nextId = 100;

function send(obj) { proc.stdin.write(JSON.stringify(obj) + "\n"); }

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let p; try { p = JSON.parse(line); } catch { continue; }

    if (p.id === 1 && p.result) {
      console.log(`[init] agentVersion=${p.result._meta?.agentVersion}`);
      send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "cached_token", meta: { headless: true } } });
    } else if (p.id === 2) {
      console.log(`[auth] OK`);
      send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: CWD, mcpServers: [] } });
    } else if (p.id === 3 && p.result) {
      activeSessionId = p.result.sessionId;
      sessions.push(activeSessionId);
      console.log(`[session] new sessionId=${activeSessionId}`);
      send({ jsonrpc: "2.0", id: 4, method: "session/prompt",
             params: { sessionId: activeSessionId, prompt: [{ type: "text", text: prompt }] } });
    } else if (p.id === 4) {
      console.log(`[prompt] resp: stopReason=${p.result?.stopReason ?? "?"} error=${p.error?.message ?? "?"}`);
      promptDone = true;
      setTimeout(() => proc.kill("SIGTERM"), 3000);
    } else if (p.method === "session/request_permission" && p.id != null) {
      const opts = p.params?.options ?? [];
      const allow = opts.find(o => o.optionId === "allow-once") ?? opts[0];
      send({ jsonrpc: "2.0", id: p.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow-once" } } });
    } else if (p.method && p.id != null && p.method !== "session/update") {
      // Reply unknown client methods with empty result so agent doesn't stall
      console.log(`[client method] ${p.method} (auto-reply {})`);
      send({ jsonrpc: "2.0", id: p.id, result: {} });
    } else if (p.method === "session/update") {
      const sId = p.params?.sessionId;
      const u = p.params?.update;
      if (!u) continue;
      if (sId && !sessions.includes(sId)) sessions.push(sId);

      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const entry = {
          sessionId: sId, kind: u.sessionUpdate, title: u.title,
          rawInputKeys: u.rawInput ? Object.keys(u.rawInput) : [],
          rawInput: u.rawInput, status: u.status, rawOutput: u.rawOutput
        };
        toolCalls.push(entry);
        if (u.sessionUpdate === "tool_call") {
          console.log(`  [tool] ${u.title} keys=${JSON.stringify(entry.rawInputKeys)}`);
          if (u.rawInput) {
            const s = JSON.stringify(u.rawInput);
            console.log(`         ${s.length <= 350 ? s : s.slice(0, 350) + "..."}`);
          }
        }
      } else if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
        let text = "";
        if (u.content?.text) text = u.content.text;
        else if (Array.isArray(u.content)) text = u.content.map(c => c?.text ?? "").join("");
        if (text) {
          if (u.sessionUpdate === "agent_message_chunk") replyChunks.push(text);
        }
      }
    }
  }
});

proc.stderr.on("data", (chunk) => {
  const s = chunk.toString("utf8");
  stderrAll.push(s);
  if (s.includes("ERROR") && !s.includes("serde error expected value at line 1 column 2")) {
    console.error(`[grok-stderr] ${s.trim().slice(0, 200)}`);
  }
});

proc.on("exit", (code) => {
  const reply = replyChunks.join("");
  console.log(`\n=== exit code=${code} promptDone=${promptDone} ===`);
  console.log(`sessions seen: ${sessions.length} (${sessions.join(", ")})`);
  console.log(`toolCallCount: ${toolCalls.length}`);
  console.log(`reply length: ${reply.length}`);

  const titles = toolCalls.reduce((acc, e) => {
    if (e.kind === "tool_call") acc[e.title] = (acc[e.title] || 0) + 1;
    return acc;
  }, {});
  console.log(`tool titles fired (from session/update):`);
  for (const [t, n] of Object.entries(titles).sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`);

  const urls = (reply.match(/https?:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+/g) || []);
  const unique = Array.from(new Set(urls));
  console.log(`x.com URLs in reply: ${unique.length}`);
  for (const u of unique) console.log(`  - ${u}`);

  writeFileSync(path.join(OUT, "tool_calls.json"), JSON.stringify(toolCalls, null, 2));
  writeFileSync(path.join(OUT, "reply.md"), reply);
  writeFileSync(path.join(OUT, "stderr.log"), stderrAll.join(""));
  writeFileSync(path.join(OUT, "urls.txt"), unique.join("\n") + (unique.length ? "\n" : ""));
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({
    stage: STAGE, sessions, toolCallCount: toolCalls.length,
    toolTitles: titles, replyLength: reply.length, urlsFound: unique.length, promptDone
  }, null, 2));
  console.log(`artifacts → ${OUT}/`);
  process.exit(promptDone && reply.length > 0 ? 0 : 1);
});

send({ jsonrpc: "2.0", id: 1, method: "initialize",
       params: { protocolVersion: "1", clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } } });

setTimeout(() => { console.error(`[probe timeout] killing after 240s`); proc.kill("SIGTERM"); }, 240_000);
