// RFC-030 Phase 0 — real `codex app-server` smoke.
//
// Sanity-check that our client+bridge parse the actual 0.144.0 wire without
// relying on schema fixtures. This is NOT the full PoC gate (that needs a
// human TUI via `codex --remote`); it just:
//   1. spawns `codex app-server --listen ws://127.0.0.1:PORT`
//   2. waits for the WS to accept
//   3. connects the client, runs initialize → initialized → thread/loaded/list
//   4. logs responses so schema drift shows up early, then HARD-exits
//      (the spawned child otherwise keeps the event loop alive — 通信龙 fix).
//
// Runs standalone: `bun tests/rfc-030-real-appserver-smoke.ts`
// Exit 0 on success, 1 on failure. Time-boxed to 20s. No model turn → no tokens.
import { spawn } from "child_process";
import { CodexAppServerClient } from "../src/runtime/codex-app-server-client";
const port = 24500 + Math.floor(Math.random() * 400);
const url = `ws://127.0.0.1:${port}`;
const proc = spawn("codex", ["app-server", "--listen", url], { stdio: ["ignore", "pipe", "pipe"] });
proc.stdout.on("data", (d) => console.log("[srv]", String(d).trim().slice(0, 200)));
proc.stderr.on("data", (d) => console.log("[srv!]", String(d).trim().slice(0, 200)));
const die = (code: number, msg: string) => { console.log(msg); try { proc.kill("SIGKILL"); } catch {} ; process.exit(code); };
setTimeout(() => die(1, "TIMEOUT 20s"), 20_000);
(async () => {
  // wait for ws to accept
  for (let i = 0; i < 40; i++) {
    try { const c = new WebSocket(url); await new Promise((res, rej) => { c.onopen = res; c.onerror = rej; }); c.close(); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const client = new CodexAppServerClient({ url, clientLabel: "dragon-probe" });
  await client.connect();
  const init = await client.request("initialize", { clientInfo: { name: "dragon_probe", title: "Dragon Probe", version: "0.0.1" } }, 8000);
  console.log("INIT OK:", JSON.stringify(init).slice(0, 300));
  client.notify("initialized", {});
  // list persistent threads (read-only, no model turn, no token burn)
  try {
    const threads = await client.request("thread/loaded/list", {}, 5000);
    console.log("THREADS:", JSON.stringify(threads).slice(0, 200));
  } catch (e) { console.log("thread/loaded/list:", (e as Error).message.slice(0, 160)); }
  await client.close();
  die(0, "PROBE PASS ✓");
})().catch((e) => die(1, "PROBE FAIL: " + (e as Error).message));
