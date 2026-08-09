const port = Number(process.env.TEST656_PORT || 19400);

let vendorRequests = 0;
let mcpCalls = 0;
let lastToolName = "";
let lastToolArgs: unknown = null;

function sse(events: Array<[string, unknown]>): Response {
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function messageStart(id: string) {
  return ["message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", content: [],
      model: "claude-sonnet-4-5-20250929", stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 },
    },
  }] as [string, unknown];
}

function toolUseResponse(): Response {
  return sse([
    messageStart("msg_test656_tool"),
    ["content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "toolu_test656", name: "commhub_send_task", input: {} },
    }],
    ["content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ alias: "receiver", task: "alias-runtime-probe" }) },
    }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 12 },
    }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function finalResponse(): Response {
  return sse([
    messageStart("msg_test656_final"),
    ["content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" },
    }],
    ["content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "ALIAS_RUNTIME_OK" },
    }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/reset") {
      vendorRequests = 0; mcpCalls = 0; lastToolName = ""; lastToolArgs = null;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/stats") {
      return Response.json({ vendorRequests, mcpCalls, lastToolName, lastToolArgs });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const body = await request.json() as any;
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "test656", version: "1" } },
        }, { headers: { "mcp-session-id": "session-test656" } });
      }
      if (body.method === "tools/call") {
        mcpCalls++;
        lastToolName = body.params?.name || "";
        lastToolArgs = body.params?.arguments ?? null;
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true, task_id: "task_test656" }) }] },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
    }
    if (url.pathname === "/v1/messages" && request.method === "POST") {
      vendorRequests++;
      return vendorRequests === 1 ? toolUseResponse() : finalResponse();
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`test656 services listening on ${port}`);
