// RFC-030 Phase 0 GATE — two-client end-to-end driver (bridge = 2nd client).
// The human TUI (codex --remote in tmux) is client #1 on the SAME app-server.
import { CodexAppServerClient } from "../src/runtime/codex-app-server-client";
import { CodexAppServerBridge } from "../src/runtime/codex-app-server-bridge";
const url = process.argv[2] || "ws://127.0.0.1:24777";
const die = (c: number, m: string) => { console.log(m); process.exit(c); };
setTimeout(() => die(1, "TIMEOUT 120s"), 120_000);
(async () => {
  const client = new CodexAppServerClient({ url, clientLabel: "anet-bridge" });
  await client.connect();
  await client.request("initialize", { clientInfo: { name: "anet_codex_bridge", title: "Agent Network Codex Bridge", version: "0.1.0" } }, 8000);
  client.notify("initialized", {});
  const threads: any = await client.request("thread/loaded/list", {}, 6000);
  console.log("LOADED THREADS:", JSON.stringify(threads).slice(0, 300));
  const tid = threads?.data?.[0]?.threadId || threads?.data?.[0]?.id || threads?.data?.[0];
  if (!tid) die(1, "no persistent thread to resume — human TUI must send one msg first");
  console.log("RESUMING thread:", tid);

  const bridge = new CodexAppServerBridge({ client, threadId: tid, bridgeLabel: "poc" });
  // log every event for observability
  for (const ev of ["status_changed","waiting_human","task_reply","task_error","cross_thread_drop","unowned_turn_drop","task_queued"]) {
    bridge.on(ev, (p) => console.log(`[bridge:${ev}]`, JSON.stringify(p).slice(0, 200)));
  }
  client.on("reverse_request", (rr) => console.log("[reverse_request — NOT answering]", JSON.stringify(rr).slice(0,160)));
  await bridge.bootstrap();
  console.log("BRIDGE bootstrapped, status:", bridge.currentStatus());

  const taskId = "poc-task-001";
  bridge.on("task_reply", (r: any) => { console.log("✅ TASK_REPLY mapped back:", JSON.stringify(r)); die(0, "GATE PASS ✓ — agent task ran on shared thread + reply mapped to task_id"); });
  bridge.on("task_error", (r: any) => die(1, "TASK_ERROR: " + JSON.stringify(r)));
  const sub = await bridge.submitTask({ taskId, text: "只回复两个字：收到" });
  console.log("SUBMITTED:", JSON.stringify(sub));
})().catch((e) => die(1, "DRIVER FAIL: " + (e as Error).message));
