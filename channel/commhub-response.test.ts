import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parseCommhubToolResult } from "./commhub-response.js";

describe("channel plugin: commhub response parsing", () => {
  test("an isError body never throws — the real reason survives", () => {
    // The exact shape that burned four days: hub rejects on Zod validation and
    // returns a human-readable string. JSON.parse'ing it threw, and the throw
    // reached the agent as `JSON Parse error: Unexpected identifier "MCP"` —
    // every distinct failure wearing the same face.
    const env = { result: { isError: true, content: [{ type: "text", text: 'MCP error -32602: Invalid arguments for tool send_reply' }] } };
    const out = parseCommhubToolResult(env);
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("-32602");
  });

  test("a normal JSON body still parses", () => {
    const env = { result: { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: "abc" }) }] } };
    expect(parseCommhubToolResult(env)).toEqual({ ok: true, message_id: "abc" });
  });

  test("the two copies of this helper stay byte-identical", () => {
    // This file exists only because channel/ is an independent package that
    // cannot import from agent-network. Duplication is WHY the bug survived
    // #1102 — so make drift fail here rather than in production four days later.
    const a = readFileSync(new URL("./commhub-response.ts", import.meta.url), "utf8");
    const b = readFileSync(new URL("../agent-network/src/commhub-response.ts", import.meta.url), "utf8");
    expect(a).toBe(b);
  });

  test("the channel plugin's own call site uses the helper, not a raw JSON.parse", () => {
    // The helper being correct proves nothing if commhub-channel.ts never calls
    // it. #1102 fixed the identical line in agent-network and this copy stayed
    // broken for four days precisely because nothing looked at the CALL SITE.
    const src = readFileSync(new URL("./commhub-channel.ts", import.meta.url), "utf8");
    expect(src).not.toContain("JSON.parse(json.result.content[0].text)");
    expect(src).toContain("parseCommhubToolResult(json)");
  });
});
