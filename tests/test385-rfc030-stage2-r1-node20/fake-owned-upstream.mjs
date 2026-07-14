#!/usr/bin/env node

import { createServer } from "node:net";

const listenIndex = process.argv.indexOf("--listen");
if (listenIndex < 0 || typeof process.argv[listenIndex + 1] !== "string") {
  process.exit(64);
}
const parsed = new URL(process.argv[listenIndex + 1]);
if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1") {
  process.exit(65);
}

const server = createServer((socket) => socket.destroy());
server.listen(Number(parsed.port), "127.0.0.1");

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 100).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
