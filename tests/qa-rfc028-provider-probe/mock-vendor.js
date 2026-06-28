// Mock anthropic-shaped vendor for RFC-028 M3 e2e. HTTPS with cert
// SAN=api.anthropic.com.
//
// Modes (per env):
//   default: 200 if x-api-key starts with sk-good- else 401
//   MOCK_FORCE_REDIRECT=1: always 302 Location: http://canary.internal:9999/leak
//
// Logs:
//   [mock-vendor] ClientHello SNI=<value>  (per TLS handshake — 通信龙 spot-check explicit)
//   [mock-vendor] <method> <path> sni=<value> x-api-key=<8 chars>... mode=<mode>

import { createServer } from "node:https";
import { readFileSync, appendFileSync } from "node:fs";

const PORT = 8443;
const CERT = readFileSync("/tmp/anet-mock-cert.pem", "utf-8");
const KEY = readFileSync("/tmp/anet-mock-key.pem", "utf-8");
const LOG_PATH = process.env.MOCK_LOG || "/tmp/mock-vendor.log";
const FORCE_REDIRECT = process.env.MOCK_FORCE_REDIRECT === "1";

function log(msg) { try { appendFileSync(LOG_PATH, msg + "\n"); } catch {} }

const server = createServer({ cert: CERT, key: KEY }, (req, res) => {
  const sni = req.socket.servername || "(none)";
  const ua = req.headers["x-api-key"] || "(none)";
  log(`[mock-vendor] ${req.method} ${req.url} sni=${sni} x-api-key=${String(ua).slice(0, 8)}... mode=${FORCE_REDIRECT ? "redirect" : "default"}`);

  if (FORCE_REDIRECT) {
    res.writeHead(302, { Location: "http://canary.internal:9999/leak" });
    res.end("redirecting-to-canary");
    return;
  }
  if (req.url === "/v1/messages" && req.method === "POST") {
    if (typeof ua === "string" && ua.startsWith("sk-good-")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_mock", type: "message", role: "assistant",
        content: [{ type: "text", text: "." }],
        model: "claude-mock-1",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    } else {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "authentication_error", message: "invalid api key" } }));
    }
    return;
  }
  res.writeHead(404);
  res.end("not_found");
});

// 通信龙 spot-check 加强: explicit positive SNI log per TLS handshake
server.on("secureConnection", (tlsSocket) => {
  const sni = tlsSocket.servername || "(none)";
  const peer = tlsSocket.remoteAddress;
  log(`[mock-vendor] ClientHello SNI=${sni} peer=${peer}`);
});
server.on("clientError", (e) => log(`[mock-vendor] clientError: ${e?.message || e}`));
server.listen(PORT, "127.0.0.1", () => log(`[mock-vendor] listening on 127.0.0.1:${PORT} sni-cert=api.anthropic.com mode=${FORCE_REDIRECT ? "redirect" : "default"}`));
