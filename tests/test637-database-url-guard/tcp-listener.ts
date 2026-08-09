import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const readyPath = process.argv[3];
const acceptedPath = process.argv[4];
if (!Number.isInteger(port) || !readyPath || !acceptedPath) process.exit(2);

const server = createServer((socket) => {
  appendFileSync(acceptedPath, "accepted\n");
  socket.destroy();
});
server.listen(port, "127.0.0.1", () => writeFileSync(readyPath, "ready\n"));
