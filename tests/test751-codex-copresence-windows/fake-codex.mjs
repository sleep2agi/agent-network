import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const rpcLog = process.env.ANET_TEST751_RPC_LOG;
const log = (line) => { if (rpcLog) appendFileSync(rpcLog, `${line}\n`); };

if (args[0] === "app-server") {
  const listen = args[args.indexOf("--listen") + 1];
  const url = new URL(listen);
  const server = Bun.serve({
    hostname: url.hostname,
    port: Number(url.port),
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        const msg = JSON.parse(String(data));
        if (!msg.id) return;
        log(`rpc:${msg.method}${msg.params?.threadId ? `:${msg.params.threadId}` : ""}`);
        let result = {};
        if (msg.method === "thread/start") result = { thread: { id: "thread_windows_e2e" } };
        if (msg.method === "thread/resume") result = { thread: { id: msg.params.threadId } };
        if (msg.method === "turn/start") result = { turn: { id: "turn_bootstrap" } };
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      },
    },
  });
  console.log(`listening on: ws://${server.hostname}:${server.port}`);
  await new Promise(() => {});
} else if (args[0] === "resume") {
  const threadId = args.find((arg) => arg.startsWith("thread_"));
  log(`tui:${threadId}`);
  console.log(`FAKE_CODEX_TUI_RESUMED ${threadId}`);
} else if (args[0] === "--version") {
  console.log("codex-cli 1.0.0");
} else {
  console.error(`unexpected fake codex args: ${args.join(" ")}`);
  process.exit(2);
}
