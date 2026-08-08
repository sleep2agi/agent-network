if (process.argv.includes("--stray-no-bind")) {
  setInterval(() => {}, 60_000);
}
else if (process.argv.includes("--socket-child")) {
  const socket = new WebSocket(process.argv[process.argv.indexOf("--socket-child") + 1]);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }).catch(() => process.exit(5));
  setInterval(() => socket.send("ping"), 60_000);
}
else if (process.argv.includes("--version")) { console.log("codex-cli 9.9.9"); process.exit(0); }
else if (process.argv.includes("resume")) {
  if (process.argv.includes("thread_fail_resume")) process.exit(7);
  if (process.argv.includes("thread_no_socket")) setInterval(() => {}, 60_000);
  else {
    const remoteAt = process.argv.indexOf("--remote");
    if (remoteAt < 0) process.exit(4);
    const child = Bun.spawn([process.execPath, "--socket-child", process.argv[remoteAt + 1]], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
  }
}
else {
const listenAt = process.argv.indexOf("--listen");
if (listenAt < 0) process.exit(3);
const url = new URL(process.argv[listenAt + 1]);
let threadName: string | null = null;
Bun.serve({ hostname: url.hostname, port: Number(url.port),
  fetch(request, server) { if (server.upgrade(request)) return; return new Response("upgrade required", { status: 426 }); },
  websocket: { message(socket, raw) {
    let msg: any; try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id === undefined) return;
    let result: any = {};
    if (msg.method === "thread/read") result = { thread: { id: msg.params.threadId, cwd: process.cwd(), name: threadName } };
    if (msg.method === "thread/name/set") threadName = msg.params.name;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  } },
});
}
setInterval(() => {}, 60_000);
