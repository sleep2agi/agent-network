import { createServer } from "node:https";
import { appendFileSync, readFileSync } from "node:fs";

const bind = process.env.MOCK_BIND || "127.0.0.1";
const port = Number(process.env.MOCK_PORT || 18443);
const status = Number(process.env.MOCK_STATUS || 200);
const logPath = process.env.MOCK_LOG || "/tmp/test648-mock.log";

const server = createServer({
  cert: readFileSync(process.env.MOCK_CERT || "/tmp/test648-cert.pem"),
  key: readFileSync(process.env.MOCK_KEY || "/tmp/test648-key.pem"),
}, (req, res) => {
  const sni = req.socket.servername || "(none)";
  appendFileSync(logPath, `request bind=${bind} status=${status} sni=${sni} path=${req.url}\n`);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ bind, status }));
});

server.listen(port, bind, () => {
  appendFileSync(logPath, `listening bind=${bind} port=${port}\n`);
});
