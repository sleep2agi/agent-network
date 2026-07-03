#!/usr/bin/env node
// RFC-029 PR② — deterministic mock-opencode ACP for the CI gate.
//
// Behaves like `opencode acp`: stdin/stdout newline-delimited JSON-
// RPC 2.0. The Phase 0b probe (u8-acp.txt) pins the frame shape we
// emit; this mock replays exactly that shape so runtime.ts + events.ts
// wiring is exercised end-to-end without any external dependency.
//
// State machine:
//   initialize       → agent-info response
//   session/new      → { sessionId, configOptions[] }
//   session/load     → { sessionId }  (with MOCK_LOAD_FAILS=1 → error)
//   session/prompt   → stream N session/update notifications, then a
//                      response with stopReason + usage.
//
// Env toggles:
//   MOCK_THINKING_ONLY=1 → prompt emits only agent_thought_chunk (no
//                          agent_message_chunk) → runtime.ts's #383
//                          rescue path fires and follow-up prompt
//                          gets a plain-text answer.
//   MOCK_LOAD_FAILS=1    → session/load returns a JSON-RPC error so
//                          the runtime falls back to session/new with
//                          the explicit "session lost on restart" log.

let buf = "";
let promptCount = 0;

const write = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};

const stream = (sessionId, msgId, chunks) => {
  for (const c of chunks) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: c.kind, messageId: msgId, content: { type: "text", text: c.text }},
      },
    });
  }
};

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  while (buf.includes("\n")) {
    const idx = buf.indexOf("\n");
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    handleRequest(req);
  }
});

function handleRequest(req) {
  switch (req.method) {
    case "initialize":
      write({
        jsonrpc: "2.0", id: req.id, result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
            promptCapabilities: { embeddedContext: true, image: true },
          },
          agentInfo: { name: "MockOpenCode", version: "0.0.0-mock" },
        },
      });
      break;
    case "session/new":
      write({
        jsonrpc: "2.0", id: req.id, result: {
          sessionId: "ses_mock_new",
          configOptions: [],
        },
      });
      break;
    case "session/load":
      if (process.env.MOCK_LOAD_FAILS === "1") {
        write({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "session not found (mock)" }});
      } else {
        write({
          jsonrpc: "2.0", id: req.id, result: {
            sessionId: req.params?.sessionId ?? "ses_mock_loaded",
          },
        });
      }
      break;
    case "session/prompt": {
      promptCount++;
      const sessionId = req.params?.sessionId ?? "ses_mock";
      const msgId = "msg_mock_" + promptCount;
      const thinkingOnly = process.env.MOCK_THINKING_ONLY === "1" && promptCount === 1;

      // Emit an initial available_commands_update (matches U8 fixture).
      write({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] }},
      });

      // Thinking chunks — always present so the test can assert the
      // thoughtText accumulator works.
      stream(sessionId, msgId, [
        { kind: "agent_thought_chunk", text: "Analyzing " },
        { kind: "agent_thought_chunk", text: "request." },
      ]);

      if (!thinkingOnly) {
        stream(sessionId, msgId, [
          { kind: "agent_message_chunk", text: "hello " },
          { kind: "agent_message_chunk", text: "world" },
        ]);
      }
      // Usage notification.
      write({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId, update: { sessionUpdate: "usage_update", used: 100 + promptCount, size: 100000, cost: { amount: 0, currency: "USD" }}},
      });
      // Terminal response with stopReason + usage.
      write({
        jsonrpc: "2.0", id: req.id,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: thinkingOnly ? 0 : 2, totalTokens: 12, thoughtTokens: 2 },
          _meta: {},
        },
      });
      break;
    }
    default:
      write({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` }});
  }
}
