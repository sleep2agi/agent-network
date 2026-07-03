// Mock Anthropic-compatible endpoint for #383 e2e — real SDK / real cli.ts
// path, vendor boundary mocked (通信龙 approved: "real SDK + real path,
// vendor 边界 mock 对 code-path 足够").
//
// Behavior: three distinct request phases distinguished by counter.
//
//   Phase 1 (first POST /v1/messages):
//     Return an assistant message whose ONLY content block is a
//     `thinking` block — no text block. Ends turn cleanly.
//     This is the buggy shape #383 describes: SDK aggregates
//     m.result="" but reports subtype="success" with real usage.
//
//   Phase 2+ (re-prompt request, if fix ① fires):
//     Return an assistant message whose ONLY content block is a
//     `text` block with a short plain-text answer. Simulates the
//     model coming out of thinking-mode when explicitly asked for a
//     final plain-text reply.
//
// Bun's http server; started by the docker-compose "mock-vendor"
// service. Listens on 0.0.0.0:9400. No TLS — the compose network is
// isolated and the SDK is configured to trust http://mock-vendor:9400.

const PORT = Number(process.env.PORT || 9400);
const HOST = process.env.HOST || "0.0.0.0";

let requestCounter = 0;

function anthropicSseStream(phase: "thinking-only" | "text-final") {
  const encoder = new TextEncoder();
  const messageId = `msg_${Date.now().toString(36)}_${phase}`;
  const model = "claude-sonnet-4-5-20250929";

  const events: Array<[string, unknown]> = [];

  events.push(["message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 42, output_tokens: 0 },
    },
  }]);

  if (phase === "thinking-only") {
    events.push(["content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }]);
    events.push(["content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: "工具查询被 channel 拒绝, 我需要考虑其他方式回答, 但看起来我还没写出面向用户的答复...",
      },
    }]);
    events.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
  } else {
    events.push(["content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }]);
    events.push(["content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "抱歉，本轮工具不可用；不过你可以告诉我具体想查什么，我尽量用其他方式回答。",
      },
    }]);
    events.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
  }

  events.push(["message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: phase === "thinking-only" ? 33 : 25 },
  }]);
  events.push(["message_stop", { type: "message_stop" }]);

  const body = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

  return encoder.encode(body);
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/_reset") {
      requestCounter = 0;
      return new Response(JSON.stringify({ ok: true, resetTo: 0 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/_stats") {
      return new Response(JSON.stringify({ requestCounter }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname !== "/v1/messages") {
      return new Response("not found", { status: 404 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    requestCounter++;
    const phase = requestCounter === 1 ? "thinking-only" : "text-final";
    console.log(`[mock-vendor] req #${requestCounter} → phase=${phase}`);

    const body = anthropicSseStream(phase);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  },
});

console.log(`[mock-vendor] listening on ${HOST}:${PORT}`);
