import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const rpcLog = process.env.ANET_TEST751_RPC_LOG;
const log = (line) => { if (rpcLog) appendFileSync(rpcLog, `${line}\n`); };
process.on("uncaughtException", (error) => { log(`fatal:${error?.stack || error}`); process.exit(1); });
process.on("unhandledRejection", (error) => { log(`fatal:${error?.stack || error}`); process.exit(1); });
log(`invoke:${JSON.stringify(args)}`);

if (args[0] === "app-server") {
  log(`appsrv-home:${process.env.CODEX_HOME}`);
  const listen = args[args.indexOf("--listen") + 1];
  const url = new URL(listen);
  const sockets = new Set();
  const broadcast = (payload) => {
    const text = JSON.stringify(payload);
    for (const socket of sockets) socket.send(text);
  };
  let humanTurnActive = false;
  const server = Bun.serve({
    hostname: url.hostname,
    port: Number(url.port),
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message(ws, data) {
        const msg = JSON.parse(String(data));
        if (!msg.id) return;
        const turnSuffix = msg.params?.expectedTurnId ? `:${msg.params.expectedTurnId}` : "";
        log(`rpc:${msg.method}${msg.params?.threadId ? `:${msg.params.threadId}` : ""}${turnSuffix}`);
        let result = {};
        if (msg.method === "thread/start") result = { thread: { id: "thread_windows_e2e" } };
        if (msg.method === "thread/resume") result = { thread: { id: msg.params.threadId } };
        if (msg.method === "turn/start") {
          result = { turn: { id: "turn_bootstrap" } };
        }
        if (msg.method === "thread/read") result = {
          thread: {
            id: msg.params.threadId,
            status: humanTurnActive ? { type: "active", activeFlags: [] } : { type: "idle" },
            turns: humanTurnActive
              ? [{ id: "turn_windows_human", status: "inProgress", items: [{ type: "userMessage", content: [{ type: "text", text: "human long turn" }] }] }]
              : [{ id: "turn_bootstrap", status: "completed", items: [] }],
          },
        };
        if (msg.method === "test/human-turn/start") {
          humanTurnActive = true;
          result = { turnId: "turn_windows_human" };
          queueMicrotask(() => broadcast({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_windows_e2e", turn: { id: "turn_windows_human", status: "inProgress" } } }));
        }
        if (msg.method === "test/tui-thread/create") {
          result = { threadId: "thread_windows_e2e" };
          queueMicrotask(() => broadcast({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread_windows_e2e", threadSource: "user" } } }));
        }
        if (msg.method === "turn/steer") result = { turnId: msg.params.expectedTurnId };
        if (msg.method === "test/human-turn/complete") {
          humanTurnActive = false;
          result = { ok: true };
          queueMicrotask(() => {
            broadcast({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread_windows_e2e", turnId: "turn_windows_human", item: { type: "agentMessage", phase: "final_answer", text: "windows steer completed" } } });
            broadcast({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread_windows_e2e", turn: { id: "turn_windows_human", status: "completed" } } });
          });
        }
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      },
    },
  });
  console.log(`listening on: ws://${server.hostname}:${server.port}`);
  // Keep the fake alive even when a detached tmux/ConPTY has no readable
  // stdin. The real app-server owns native handles; the fake must model that
  // lifetime explicitly instead of relying on an unresolved Promise alone.
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
} else if (args[0] === "resume" || args.includes("--remote")) {
  const freshDeferred = args[0] !== "resume";
  const threadId = args.find((arg) => arg.startsWith("thread_")) ?? "thread_windows_e2e";
  log(`tui:${threadId}`);
  log(`tui-remote:${args[args.indexOf("--remote") + 1]}`);
  log(`tui-home:${process.env.CODEX_HOME}`);
  console.log(">_ OpenAI Codex (test co-presence)");
  console.log(`FAKE_CODEX_TUI_RESUMED ${threadId}`);
  if (process.env.ANET_TEST751_EXPECT_CODEX_HOME
    && process.env.CODEX_HOME !== process.env.ANET_TEST751_EXPECT_CODEX_HOME) {
    console.log("FAKE_CODEX_TUI_CLOUD_FALLBACK");
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  // Every TUI fixture must model the production second client, including the
  // short create/start/restart probes. Printing a pane and exiting can never
  // satisfy PID+birth+socket health, and would only test a weaker old launcher.
  const remote = args[args.indexOf("--remote") + 1];
  const ws = new WebSocket(remote);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const request = (method) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 10_000);
    const listener = (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== id) return;
      ws.removeEventListener("message", listener);
      clearTimeout(timer);
      response.error ? reject(new Error(response.error.message)) : resolve(response.result);
    };
    ws.addEventListener("message", listener);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { threadId } }));
  });
  if (freshDeferred) await request("test/tui-thread/create");
  if (process.env.ANET_TEST751_LONG_TURN === "1") {
    await request("test/human-turn/start");
    console.log("FAKE_CODEX_TUI_LONG_TURN_READY");
    const sentinel = process.env.ANET_TEST751_COMPLETE_LONG_TURN;
    for (let i = 0; i < 600 && (!sentinel || !existsSync(sentinel)); i++) await Bun.sleep(100);
    if (!sentinel || !existsSync(sentinel)) throw new Error("long turn completion sentinel missing");
    await request("test/human-turn/complete");
    console.log("FAKE_CODEX_TUI_LONG_TURN_COMPLETED");
  }
  // Keep the root process and exact socket observable across the launcher's
  // WMI CreationDate and Get-NetTCPConnection snapshots. This applies after
  // both the short probe and the long-turn fixture: completing the synthetic
  // human turn must not make the second client disappear before attestation.
  await Bun.sleep(5_000);
  ws.close();
} else if (args[0] === "--version") {
  console.log("codex-cli 1.0.0");
} else {
  console.error(`unexpected fake codex args: ${args.join(" ")}`);
  process.exit(2);
}
