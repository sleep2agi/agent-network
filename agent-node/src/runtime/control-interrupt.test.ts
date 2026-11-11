import { describe, expect, test } from "bun:test";
import { interruptCurrentTurn, parseControlOp } from "./control-interrupt";

const ep = { url: "http://127.0.0.1:1234", authorization: "Bearer x" };
const mk = (interrupted: boolean) => (async () =>
  new Response(JSON.stringify({ interrupted }), { status: 200 })) as unknown as typeof fetch;

describe("interruptCurrentTurn", () => {
  test("内核回 {interrupted:true} ⇒ ok/interrupted", async () => {
    const r = await interruptCurrentTurn({ readEndpoint: () => ep, sessionId: () => "ses_x", fetchImpl: mk(true) });
    expect(r).toEqual({ ok: true, interrupted: true });
  });
  test("内核回 {interrupted:false} ⇒ ok 但没打断（无在飞回合）", async () => {
    const r = await interruptCurrentTurn({ readEndpoint: () => ep, sessionId: () => "ses_x", fetchImpl: mk(false) });
    expect(r).toEqual({ ok: true, interrupted: false });
  });
  test("没有端点 ⇒ no_endpoint（不许当成成功）", async () => {
    const r = await interruptCurrentTurn({ readEndpoint: () => null, sessionId: () => "ses_x" });
    expect(r).toEqual({ ok: false, reason: "no_endpoint" });
  });
  test("没有会话 ⇒ no_session", async () => {
    const r = await interruptCurrentTurn({ readEndpoint: () => ep, sessionId: () => null });
    expect(r).toEqual({ ok: false, reason: "no_session" });
  });
  test("HTTP 非 2xx ⇒ http_error 且带状态", async () => {
    const f = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const r = await interruptCurrentTurn({ readEndpoint: () => ep, sessionId: () => "ses_x", fetchImpl: f });
    expect(r.ok).toBe(false);
    expect((r as any).detail).toContain("503");
  });
});

describe("parseControlOp", () => {
  test("只认 op=interrupt，其它/坏 JSON 一律 null", () => {
    expect(parseControlOp('{"op":"interrupt"}')).toBe("interrupt");
    expect(parseControlOp('{"op":"other"}')).toBeNull();
    expect(parseControlOp("not json")).toBeNull();
    expect(parseControlOp(undefined)).toBeNull();
  });
});
