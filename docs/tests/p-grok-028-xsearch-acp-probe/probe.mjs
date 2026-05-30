// Minimal ACP introspection probe — capture available_commands_update.tools list
// from grok 0.2.x alpha to compare with prior 0.1.219 fixture.
// NO LLM prompt → zero quota tick.

import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";

const CWD = "/tmp/p-grok-028-xsearch-acp-probe/grok-cwd";
if (!existsSync(CWD)) mkdirSync(CWD, { recursive: true });

const proc = spawn("grok", ["agent", "stdio"], { stdio: ["pipe", "pipe", "pipe"], cwd: CWD });
const updates = [];
let buf = "";
let sessionId = null;
let initialized = false;
let authedOk = false;
let captured = false;
let timeoutHandle;

function send(obj) {
  proc.stdin.write(JSON.stringify(obj) + "\n");
}

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let payload;
    try { payload = JSON.parse(line); } catch { continue; }
    if (payload.id === 1 && payload.result) {
      console.log("[init] OK protocolVersion:", payload.result.protocolVersion,
        "agentCapabilities:", JSON.stringify(payload.result.agentCapabilities),
        "agentVersion:", payload.result._meta?.agentVersion);
      initialized = true;
      send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "cached_token", meta: { headless: true } } });
    } else if (payload.id === 2 && payload.result !== undefined) {
      authedOk = true;
      console.log("[auth] OK");
      send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: CWD, mcpServers: [] } });
    } else if (payload.id === 3 && payload.result) {
      sessionId = payload.result.sessionId;
      console.log("[session] new sessionId:", sessionId);
    } else if (payload.method === "session/update") {
      const u = payload.params?.update;
      if (u?.sessionUpdate === "available_commands_update") {
        const tools = payload.params?._meta?.tools || u?._meta?.tools || payload._meta?.tools;
        if (tools && !captured) {
          console.log("[tools] AvailableCommandsUpdate tools list (LLM-side tool registry):");
          console.log(JSON.stringify(tools, null, 2));
          const xSearchHit = tools.some(t => /xsearch|x_search|x_keyword|x_user/i.test(t));
          console.log(`\nXSearch / x_keyword_search / x_user_search hit? ${xSearchHit ? "YES" : "NO"}`);
          console.log(`web_search in list? ${tools.includes("web_search") ? "YES" : "NO"}`);
          console.log(`video_gen in list? ${tools.includes("video_gen") ? "YES" : "NO"}`);
          captured = true;
          setTimeout(() => proc.kill("SIGTERM"), 200);
        }
        updates.push(u);
      }
    }
  }
});

proc.stderr.on("data", (chunk) => {
  const s = chunk.toString("utf8");
  if (s.trim()) console.error("[stderr]", s.trim().slice(0, 400));
});

proc.on("exit", (code) => {
  console.log(`\n[exit] code=${code} initialized=${initialized} authed=${authedOk} captured=${captured} updates=${updates.length}`);
  process.exit(captured ? 0 : 1);
});

// kick off
send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "1",
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
  }
});

timeoutHandle = setTimeout(() => {
  console.error("[timeout] 20s elapsed");
  proc.kill("SIGTERM");
}, 20000);
