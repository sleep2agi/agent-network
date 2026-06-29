// Canary HTTP listener for RFC-028 M3 scenario E (SSRF redirect真验).
// Logs ANY TCP connect to /tmp/canary.log. assertion: 0 connects = pass.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const LOG = process.env.CANARY_LOG || "/tmp/canary.log";
function log(msg) { try { appendFileSync(LOG, msg + "\n"); } catch {} }
const server = createServer((req, res) => {
  log(`[canary] HIT ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  res.writeHead(200);
  res.end("canary-hit");
});
server.on("connection", (sock) => log(`[canary] TCP connect from ${sock.remoteAddress}:${sock.remotePort}`));
server.listen(9999, "127.0.0.1", () => log("[canary] listening 127.0.0.1:9999 — should NEVER receive any hit"));
