// 🔴 这个文件测的是 channel/ 里的东西,却放在 agent-network/src/ 下 —— 是故意的。
// check-test-file-coverage 这道门抓到:channel/ 不在任何聚合门的扫描范围里,
// 放在那边的测试「加了也不会有人跑」。而本文件四条断言里三条本来就是按路径读
// 文件,不依赖所在包,所以挪进被覆盖的根是等价的 —— 且从此真的会被 CI 跑到。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parseCommhubToolResult } from "./commhub-response.js";

describe("channel plugin (channel/commhub-channel.ts) error masking", () => {
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
    const a = readFileSync(new URL("../../channel/commhub-response.ts", import.meta.url), "utf8");
    const b = readFileSync(new URL("./commhub-response.ts", import.meta.url), "utf8");
    expect(a).toBe(b);
  });

  test("the channel plugin's own call site uses the helper, not a raw JSON.parse", () => {
    // The helper being correct proves nothing if commhub-channel.ts never calls
    // it. #1102 fixed the identical line in agent-network and this copy stayed
    // broken for four days precisely because nothing looked at the CALL SITE.
    const src = readFileSync(new URL("../../channel/commhub-channel.ts", import.meta.url), "utf8");
    expect(src).not.toContain("JSON.parse(json.result.content[0].text)");
    expect(src).toContain("parseCommhubToolResult(json)");
  });
});
