// RFC-030 co-presence verification — shared app-server + observer.
//
// Stands up a SHARED `codex app-server`, creates & persists one thread, and
// keeps an OBSERVER client subscribed to it (this simulates the human
// `codex --remote` TUI). It writes the threadId to a file so an agent-node
// in ADOPT mode (codexAppServerUrl + codexThreadId) can resume the SAME
// thread. Every agentMessage the observer sees on that thread is appended to
// a log — so when a network `send_task` drives a bridge turn, we can prove
// the turn was visible to the co-present observer (= human TUI would see it).
//
// Long-running: spawn in tmux/background. Kill to tear down.

import { spawn } from "child_process";
import { writeFileSync, appendFileSync } from "fs";
import { CodexAppServerClient } from "../src/runtime/codex-app-server-client";

const WS = process.env.COPRES_WS || "ws://127.0.0.1:24999";
const PORT = WS.split(":").pop();
const OUT_THREAD = process.env.COPRES_THREAD_FILE || "/home/vansin/rfc030-work/.demo/copresence-thread";
const OUT_LOG = process.env.COPRES_LOG || "/home/vansin/rfc030-work/.demo/observer.log";

async function waitWs(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const c = new WebSocket(url);
      await new Promise<void>((res, rej) => { c.onopen = () => res(); c.onerror = (e) => rej(e); });
      c.close(); return;
    } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error("shared app-server never up");
}

(async () => {
  // Shared app-server (auto-approve + workspace-write, matching the node).
  const srv = spawn("codex", [
    "app-server", "-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write",
    "--listen", WS,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  srv.stderr.on("data", (d) => process.env.COPRES_DEBUG && console.log("[srv]", String(d).trim().slice(0, 160)));
  process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
  await waitWs(WS);
  console.log(`[copres] shared app-server up on ${WS}`);

  // Creator: make + persist a thread (one tiny turn writes the rollout so
  // a later thread/resume by the bridge/observer succeeds).
  const creator = new CodexAppServerClient({ url: WS, clientLabel: "copres_creator" });
  await creator.connect();
  await creator.request("initialize", { clientInfo: { name: "copres", title: "copres", version: "0.0.1" } }, 10_000);
  creator.notify("initialized", {});
  const started = await creator.request<any>("thread/start", {}, 15_000);
  const threadId = started?.threadId ?? started?.thread?.id;
  if (!threadId) { console.log("FAIL: no threadId"); process.exit(1); }
  // Persist a rollout.
  await creator.request("turn/start", {
    threadId, clientUserMessageId: "copres:init",
    input: [{ type: "text", text: "只回复一个词：READY" }],
  }, 30_000);
  await new Promise((r) => setTimeout(r, 4000)); // let the turn complete + rollout persist
  writeFileSync(OUT_THREAD, threadId);
  writeFileSync(OUT_LOG, `# co-presence observer log — thread ${threadId}\n`);
  console.log(`[copres] thread ready: ${threadId} (written to ${OUT_THREAD})`);

  // Observer: a SECOND client that resumes the SAME thread — the human-TUI
  // stand-in. Log every agentMessage it sees on this thread.
  const observer = new CodexAppServerClient({ url: WS, clientLabel: "copres_observer" });
  await observer.connect();
  try {
    await observer.request("initialize", { clientInfo: { name: "obs", title: "obs", version: "0.0.1" } }, 10_000);
    observer.notify("initialized", {});
  } catch { /* already initialized on shared server — expected */ }
  await observer.request("thread/resume", { threadId }, 15_000);
  console.log(`[copres] observer subscribed to ${threadId} — waiting for network-driven turns…`);

  observer.on("item/completed", (params: any) => {
    const it = params?.item;
    if (params?.threadId === threadId && it?.type === "agentMessage") {
      const line = `[${new Date().toISOString?.() ?? "t"}] agentMessage(phase=${it.phase}): ${String(it.text ?? "").slice(0, 200)}`;
      appendFileSync(OUT_LOG, line + "\n");
      console.log("[copres OBSERVED]", line);
    }
  });
  observer.on("turn/started", (p: any) => {
    if (p?.threadId === threadId) {
      appendFileSync(OUT_LOG, `[turn/started] turn=${p?.turn?.id ?? p?.turnId}\n`);
      console.log("[copres OBSERVED] turn/started", p?.turn?.id ?? p?.turnId);
    }
  });

  // Stay alive.
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.log("FAIL:", e?.stack || e); process.exit(1); });
