import { describe, expect, test } from "bun:test";
import { interruptCurrentTurn, parseControlOp, sharedServerInterruptEndpoint } from "./control-interrupt";

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

// #3812 — measured on a real Windows node: a stop answered {"ok":false,"reason":"no_endpoint"} and
// the turn kept running, because the endpoint record is not written there.

describe("the shared OpenCode Server as an interrupt endpoint", () => {
  const config = { opencodeSharedServerUrl: "http://127.0.0.1:14096", opencodeSharedServerPasswordFile: "C:\\Users\\a\\.anet\\pw" };
  test("built from the node's own configuration", () => {
    const seen: string[] = [];
    const ep = sharedServerInterruptEndpoint(config, (file) => { seen.push(file); return "s3cret\r\n"; });
    expect(seen).toEqual([config.opencodeSharedServerPasswordFile]);
    expect(ep).toEqual({ url: "http://127.0.0.1:14096", authorization: `Basic ${Buffer.from("opencode:s3cret").toString("base64")}` });
  });
  test("nothing is guessed: no shared Server, a non-loopback URL, an unreadable or empty password", () => {
    const read = () => "pw";
    expect(sharedServerInterruptEndpoint(null, read)).toBeNull();
    expect(sharedServerInterruptEndpoint({}, read)).toBeNull();
    expect(sharedServerInterruptEndpoint({ ...config, opencodeSharedServerUrl: "http://10.0.0.5:14096" }, read)).toBeNull();
    expect(sharedServerInterruptEndpoint({ ...config, opencodeSharedServerPasswordFile: "" }, read)).toBeNull();
    expect(sharedServerInterruptEndpoint(config, () => { throw new Error("not private"); })).toBeNull();
    expect(sharedServerInterruptEndpoint(config, () => "  \n")).toBeNull();
  });
});
