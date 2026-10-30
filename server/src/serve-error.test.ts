import { describe, expect, test } from "bun:test";
import { buildServeErrorResponse, serveErrorBody } from "./serve-error.js";

// 注:「没有 error 回调时 Bun 回默认非 JSON 500」这一半没法在 bun test 里当用例:
// 运行器会把 fetch 里抛出的异常当成未处理错误直接判这条用例失败(实测),证据在 #695 末评。
describe("#695 fetch exceptions become JSON with the exception's own message", () => {
  test("body carries THE message, both JSON-RPC-shaped and REST-shaped", () => {
    const b = serveErrorBody(new Error("boom-695: sqlite is locked"));
    expect(b.error.code).toBe(-32603);
    expect(b.error.message).toBe("boom-695: sqlite is locked");
    expect(b.message).toBe("boom-695: sqlite is locked");
    expect(b.ok).toBe(false);
    // 不是固定 JSON:换一个异常,message 跟着变
    expect(serveErrorBody(new Error("other")).error.message).toBe("other");
    expect(serveErrorBody("plain string").error.message).toBe("plain string");
    expect(serveErrorBody(new Error("")).error.message).toBe("internal error");
  });

  test("real Bun.serve: a throwing fetch answers 500 + application/json + the message (was a non-JSON default page)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() { throw new Error("boom-695-live"); },
      error: (err) => buildServeErrorResponse(err),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", body: "{}" });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      const json = await res.json() as { error: { code: number; message: string }; ok: boolean };
      expect(json.error.code).toBe(-32603);
      expect(json.error.message).toBe("boom-695-live");
      expect(json.ok).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  // 2026-10-31 —— join 的**前提**：一个错误要能被念回来，且念回的那个 id 必须真的进日志。
  // 只说「加了 id」不算：三者（body / header / log）不一致时，念回 id 反而更糟 ——
  // 它会让人以为服务端有记录。
  describe("error_id: the join key must exist in all three places, identically", () => {
    test("body.error_id === x-error-id === the logged id", async () => {
      const logged: string[] = [];
      const res = buildServeErrorResponse(new Error("boom-join"), (l) => logged.push(l));
      const body = await res.json() as any;
      expect(typeof body.error_id).toBe("string");
      expect(body.error_id).toMatch(/^[0-9a-f]{8}$/);
      expect(res.headers.get("x-error-id")).toBe(body.error_id);
      // 分母：日志必须真的有一条，且里面就是那个 id
      expect(logged.length).toBe(1);
      expect(logged[0]).toContain(`id=${body.error_id}`);
    });

    test("ids differ per failure (a constant id would join every incident to one line)", () => {
      const a = serveErrorBody(new Error("a"));
      const b = serveErrorBody(new Error("b"));
      expect(a.error_id).not.toBe(b.error_id);
    });
  });
});
