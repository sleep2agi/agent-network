// RFC-030 helper — create + persist one codex thread on a running
// app-server, print its threadId. Used to pre-create the shared thread that
// both the human TUI (`codex resume --remote <ws> <id>`) and the bridge
// (adopt mode: codexAppServerUrl + codexThreadId) will resume.
//
// Usage: COPRES_WS=ws://127.0.0.1:24700 bun tests/rfc-030-create-thread.ts
// Prints only the threadId on stdout (last line) for easy capture.

import { CodexAppServerClient } from "../src/runtime/codex-app-server-client";

const WS = process.env.COPRES_WS || "ws://127.0.0.1:24700";

(async () => {
  const c = new CodexAppServerClient({ url: WS, clientLabel: "thread_creator" });
  await c.connect();
  try {
    await c.request("initialize", { clientInfo: { name: "creator", title: "creator", version: "0.0.1" } }, 10_000);
    c.notify("initialized", {});
  } catch { /* already initialized on shared server */ }
  const started = await c.request<any>("thread/start", {}, 15_000);
  const threadId = started?.threadId ?? started?.thread?.id;
  if (!threadId) { console.error("FAIL: no threadId"); process.exit(1); }
  // One tiny turn persists the rollout so later thread/resume succeeds.
  await c.request("turn/start", {
    threadId, clientUserMessageId: "bootstrap:init",
    input: [{ type: "text", text: "只回复一个词：READY" }],
  }, 45_000);
  await new Promise((r) => setTimeout(r, 4000));
  await c.close().catch(() => {});
  console.log(threadId);
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e?.message || e); process.exit(1); });
