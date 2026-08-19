// #1100 — parseCommhubToolResult must never throw, and must surface a
// readable error on the isError path (a parameter-range rejection must
// NOT masquerade as a -32603 protocol error).
//
// 改坏报红 gate: revert parseCommhubToolResult to the old
//   `content[0].text ? JSON.parse(content[0].text) : json`
// and the "isError → structured error (no throw)" test flips from a
// clean object to a thrown SyntaxError.

import { describe, expect, test } from "bun:test";
import { parseCommhubToolResult } from "./commhub-response";

// The EXACT envelope the live hub returns for report_status({progress:101}),
// captured 2026-08-19 (reproduced against 127.0.0.1:9200).
const HUB_PROGRESS_ERROR = {
  result: {
    content: [{
      type: "text",
      text: "MCP error -32602: Input validation error: Invalid arguments for tool report_status: Too big: expected number to be <=100 at progress",
    }],
    isError: true,
  },
  jsonrpc: "2.0",
  id: 2,
};

describe("#1100 parseCommhubToolResult", () => {
  test("isError result → structured {ok:false,error} carrying the readable message, does NOT throw", () => {
    let out: any;
    expect(() => { out = parseCommhubToolResult(HUB_PROGRESS_ERROR); }).not.toThrow();
    expect(out.ok).toBe(false);
    // The rejection reason must survive — it names the offending field.
    expect(out.error).toContain("progress");
    expect(out.error).toContain("<=100");
    // And it must NOT look like a protocol/parse error.
    expect(out.error).not.toContain("JSON Parse");
    expect(out.error).not.toContain("-32603");
  });

  test("success JSON payload still parses to an object", () => {
    const ok = { result: { content: [{ type: "text", text: '{"ok":true,"inbox_count":3}' }], isError: false }, jsonrpc: "2.0", id: 2 };
    expect(parseCommhubToolResult(ok)).toEqual({ ok: true, inbox_count: 3 });
  });

  test("success text that isn't JSON degrades to a structured error, does NOT throw", () => {
    const weird = { result: { content: [{ type: "text", text: "plain not-json body" }], isError: false }, jsonrpc: "2.0", id: 2 };
    let out: any;
    expect(() => { out = parseCommhubToolResult(weird); }).not.toThrow();
    expect(out).toEqual({ ok: false, error: "plain not-json body" });
  });

  test("JSON-RPC error envelope (no result.content) → readable structured error", () => {
    const envErr = { error: { code: -32600, message: "Invalid Request" }, jsonrpc: "2.0", id: 2 };
    const out = parseCommhubToolResult(envErr);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Invalid Request");
  });

  test("plain result with no content passes through", () => {
    const plain = { result: { ok: true, inbox_count: 0 }, jsonrpc: "2.0", id: 2 };
    expect(parseCommhubToolResult(plain)).toEqual({ result: { ok: true, inbox_count: 0 }, jsonrpc: "2.0", id: 2 });
  });
});
