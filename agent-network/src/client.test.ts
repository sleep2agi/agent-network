import { expect, test } from "bun:test";
import { CommHub } from "./client";

test("CommHub.reply calls send_reply MCP tool", async () => {
  const calls: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
    }));
  }) as typeof fetch;

  try {
    const hub = new CommHub({ url: "http://127.0.0.1:9200", alias: "sdk-test", autoConnect: false });
    await hub.reply("task_123", "done");
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls).toHaveLength(1);
  expect(calls[0].params.name).toBe("send_reply");
  expect(calls[0].params.arguments).toEqual({
    in_reply_to: "task_123",
    text: "done",
    status: "completed",
  });
});
